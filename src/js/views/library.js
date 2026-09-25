// Library: the corpus itself, no model in between. If the assistant cites
// 4PH1 Jun 2024 Paper 1P Q4(b), you can read it here. Search is keyword only;
// "more like this" uses stored embeddings, so neither costs a Gemini call.

import { esc, on, debounce } from "../ui/dom.js";
import { toast, openModal, emptyState, skeleton, spinner } from "../ui/feedback.js";
import { groundedSubjects, corpusCode, savePrefs, store } from "../store.js";
import {
  searchLibrary, subjectTopics, listPapers, getChunk, similarQuestions, syncPrefs,
} from "../api/data.js";
import { navigate } from "../router.js";
import { paperLabel, markPill } from "../lib/exam.js";

const PAGE = 25;

/** One option per corpus: Physics and Single Science Physics share papers, and duplicate values broke the select. */
function subjectOptions(subjects) {
  const seen = new Set();
  return subjects
    .filter((s) => {
      const code = corpusCode(s.code);
      if (seen.has(code)) return false;
      seen.add(code);
      return true;
    })
    .map((s) => {
      const code = corpusCode(s.code);
      const name = store.subjects.find((x) => x.code === code)?.name ?? s.name;
      return `<option value="${esc(code)}"${code === state.subject ? " selected" : ""}>${esc(name)}</option>`;
    })
    .join("");
}

let root = null;
let state = {
  subject: null,
  query: "",
  topic: null,
  paperId: null,
  markableOnly: false,
  offset: 0,
  total: 0,
  hasMore: false,
  rows: [],
};

export async function render(container, { query = {} } = {}) {
  root = container;
  const grounded = groundedSubjects();

  state.subject = query.subject
    ? corpusCode(query.subject)
    : state.subject ?? store.prefs.lastCorpus ?? null;
  if (!grounded.some((s) => corpusCode(s.code) === state.subject)) {
    state.subject = grounded.length ? corpusCode(grounded[0].code) : null;
  }
  if (query.topic) state.topic = query.topic;
  if (query.q) state.query = query.q;
  state.offset = 0;

  if (!grounded.length) {
    container.innerHTML = `
      <header class="view-head"><div><h1>Library</h1></div></header>
      ${emptyState({
        icon: "📚",
        title: "Nothing to browse yet",
        message: "The library is the corpus itself. Add a past paper and its mark scheme, and every question in it appears here.",
        action: `<button class="btn-primary" data-goto="papers">Add a paper</button>`,
      })}`;
    on(root, "click", "[data-goto]", (_, b) => navigate(b.dataset.goto));
    return;
  }

  container.innerHTML = shell(grounded);
  wire();
  await Promise.all([paintFilters(), load()]);
}

function shell(grounded) {
  return `
    <header class="view-head">
      <div>
        <h1>Library</h1>
        <p class="view-sub">Every question Markwise has read, with its real mark scheme underneath.</p>
      </div>
      <div class="view-actions">
        <label class="inline-field">
          <span class="muted">Subject</span>
          <select id="libSubject">
            ${subjectOptions(grounded)}
          </select>
        </label>
      </div>
    </header>

    <div class="lib-filters">
      <input type="search" id="libSearch" class="lib-search" placeholder="Search the questions…"
             autocomplete="off" value="${esc(state.query)}" data-autofocus>
      <select id="libTopic" aria-label="Topic"><option value="">All topics</option></select>
      <select id="libPaper" aria-label="Paper"><option value="">All papers</option></select>
      <label class="toggle">
        <input type="checkbox" id="libMarkable"${state.markableOnly ? " checked" : ""}> Only ones I can be marked on
      </label>
    </div>

    <p class="lib-count muted" id="libCount"></p>
    <div id="libBody">${skeleton(5)}</div>`;
}

/* ------------------------------------------------------------------ wiring -- */

function wire() {
  root.querySelector("#libSubject").addEventListener("change", async (e) => {
    state.subject = e.target.value;
    state.topic = null;
    state.paperId = null;
    state.offset = 0;
    savePrefs({ lastCorpus: state.subject });
    syncPrefs();
    await Promise.all([paintFilters(), load()]);
  });

  root.querySelector("#libSearch").addEventListener("input", debounce((e) => {
    state.query = e.target.value;
    state.offset = 0;
    load();
  }, 320));

  root.querySelector("#libTopic").addEventListener("change", (e) => {
    state.topic = e.target.value || null;
    state.offset = 0;
    load();
  });

  root.querySelector("#libPaper").addEventListener("change", (e) => {
    state.paperId = e.target.value || null;
    state.offset = 0;
    load();
  });

  root.querySelector("#libMarkable").addEventListener("change", (e) => {
    state.markableOnly = e.target.checked;
    state.offset = 0;
    load();
  });

  on(root, "click", "[data-open-q]", (_, btn) => openQuestion(btn.dataset.openQ));
  on(root, "click", "[data-page]", (_, btn) => {
    state.offset = Math.max(0, state.offset + Number(btn.dataset.page) * PAGE);
    load();
    root.scrollIntoView?.({ block: "start" });
  });
  on(root, "click", "[data-goto]", (_, b) => navigate(b.dataset.goto));
}

/** Topic and paper pickers, both derived from what is actually stored. */
async function paintFilters() {
  const topicSel = root.querySelector("#libTopic");
  const paperSel = root.querySelector("#libPaper");
  if (!topicSel || !paperSel) return;

  const [topics, papers] = await Promise.all([
    subjectTopics(state.subject).catch(() => []),
    listPapers(state.subject).catch(() => []),
  ]);
  if (!root.querySelector("#libTopic")) return;

  topicSel.innerHTML = `<option value="">All topics</option>` + topics.map((t) =>
    `<option value="${esc(t.topic)}"${t.topic === state.topic ? " selected" : ""}>${esc(t.topic)} (${t.questions})</option>`
  ).join("");

  paperSel.innerHTML = `<option value="">All papers</option>` + papers.map((p) =>
    `<option value="${esc(p.paper_id)}"${p.paper_id === state.paperId ? " selected" : ""}>${
      esc(paperLabel({ ...p, subject_code: state.subject }, { question: false }))} · ${p.questions} questions</option>`
  ).join("");
}

/* ---------------------------------------------------------------- loading -- */

async function load() {
  const body = root?.querySelector("#libBody");
  if (!body) return;
  body.innerHTML = skeleton(5);

  try {
    const { rows, total, hasMore } = await searchLibrary({
      subject: state.subject,
      query: state.query,
      topic: state.topic,
      paperId: state.paperId,
      markableOnly: state.markableOnly,
      limit: PAGE,
      offset: state.offset,
    });
    state.rows = rows;
    state.total = total;
    state.hasMore = hasMore;
  } catch (e) {
    const el = root?.querySelector("#libBody");
    if (el) el.innerHTML = `<div class="empty error"><h3>Search failed</h3><p>${esc(e.message)}</p></div>`;
    return;
  }

  paint();
}

function paint() {
  const body = root?.querySelector("#libBody");
  const count = root?.querySelector("#libCount");
  if (!body) return;

  if (count) {
    count.textContent = state.rows.length
      ? `Showing ${state.offset + 1}–${state.offset + state.rows.length}${
          state.total > state.rows.length ? ` of about ${state.total.toLocaleString()}` : ""}`
      : "";
  }

  if (!state.rows.length) {
    body.innerHTML = emptyState({
      icon: "🔍",
      title: "Nothing matched",
      message: state.query
        ? "No question in this subject contains those words. Try fewer, or a topic instead."
        : "No questions are stored for that combination yet.",
    });
    return;
  }

  body.innerHTML = `
    <ul class="lib-list">
      ${state.rows.map(questionRow).join("")}
    </ul>
    <div class="lib-pager">
      <button class="btn-ghost small" data-page="-1"${state.offset === 0 ? " disabled" : ""}>Previous</button>
      <button class="btn-ghost small" data-page="1"${state.hasMore ? "" : " disabled"}>Next</button>
    </div>`;
}

function questionRow(c) {
  const opening = String(c.content ?? "").replace(/\s+/g, " ").trim();
  return `
    <li class="lib-item">
      <button class="lib-open" data-open-q="${esc(c.id)}">
        <span class="lib-head">
          <span class="paper-ref">${esc(paperLabel(c))}</span>
          ${c.marks ? `<span class="marks-pill">${markPill(c.marks)}</span>` : ""}
          ${c.topic ? `<span class="lib-topic">${esc(c.topic)}</span>` : ""}
          ${c.ms_content ? '<span class="lib-markable" title="A mark scheme is stored">markable</span>' : ""}
        </span>
        <span class="lib-text">${esc(opening.slice(0, 260))}${opening.length > 260 ? "…" : ""}</span>
      </button>
    </li>`;
}

/* -------------------------------------------------------------- one question */

async function openQuestion(id) {
  openModal({
    title: "Question",
    width: "wide",
    body: spinner("Loading…"),
    async onMount(dialog) {
      const target = dialog.querySelector(".modal-body");
      let c;
      try {
        c = await getChunk(id);
        if (!c) throw new Error("That question is no longer available.");
      } catch (e) {
        target.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
        return;
      }

      dialog.querySelector("#modalTitle").textContent =
        paperLabel(c);

      target.innerHTML = `
        <div class="source-doc">
          <p class="source-ref">
            ${c.marks ? `${c.marks} mark${c.marks === 1 ? "" : "s"}` : ""}${c.topic ? ` · ${esc(c.topic)}` : ""}${
              c.command_word ? ` · ${esc(c.command_word)}` : ""}
          </p>
          <pre class="verbatim">${esc(c.content)}</pre>

          ${c.ms_content
            ? `<details class="model-details"><summary>Mark scheme</summary>
                 <pre class="verbatim ms">${esc(c.ms_content)}</pre></details>`
            : '<p class="muted">No mark scheme is stored for this one, so it cannot be marked yet.</p>'}
          ${c.er_content
            ? `<details class="model-details"><summary>What examiners said</summary>
                 <pre class="verbatim er">${esc(c.er_content)}</pre></details>`
            : ""}

          <div class="modal-actions">
            <button class="btn-ghost" data-similar>More like this</button>
            <button class="btn-primary" data-practise>Answer this and get it marked</button>
          </div>
          <div id="libSimilar"></div>
        </div>`;

      // Practising a question just opens the assistant with it pre-filled.
      target.querySelector("[data-practise]").addEventListener("click", () => {
        const ref = paperLabel(c).replaceAll(" · ", " ");
        navigate(`assistant?subject=${encodeURIComponent(c.subject_code)}&draft=${encodeURIComponent(
          `Mark my answer to ${ref}:\n`,
        )}`);
      });

      target.querySelector("[data-similar]").addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = "Finding…";
        const slot = target.querySelector("#libSimilar");
        try {
          const rows = await similarQuestions(c.id, 6);
          slot.innerHTML = rows.length
            ? `<h4>Questions like this one</h4>
               <ul class="lib-list compact">${rows.map((r) => `
                 <li class="lib-item">
                   <button class="lib-open" data-open-q="${esc(r.id)}">
                     <span class="lib-head">
                       <span class="paper-ref">${esc(paperLabel(r))}</span>
                       ${r.marks ? `<span class="marks-pill">${markPill(r.marks)}</span>` : ""}
                     </span>
                     <span class="lib-text">${esc(String(r.content ?? "").replace(/\s+/g, " ").slice(0, 160))}…</span>
                   </button>
                 </li>`).join("")}</ul>`
            : '<p class="muted">Nothing close enough to be worth showing.</p>';
          slot.addEventListener("click", (ev) => {
            const open = ev.target.closest("[data-open-q]");
            if (open) openQuestion(open.dataset.openQ);
          });
        } catch (err) {
          toast(err.message, "error");
        } finally {
          btn.disabled = false;
          btn.textContent = "More like this";
        }
      });
    },
  });
}

/** Forget filters and results. Called on sign-in and sign-out. */
export function invalidate() {
  state = { subject: null, query: "", topic: null, paperId: null, markableOnly: false, offset: 0, total: 0, hasMore: false, rows: [] };
}
