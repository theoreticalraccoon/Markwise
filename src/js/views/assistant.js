/**
 * Assistant: one chat box for everything you'd ask a tutor. A message that
 * names a question and carries an answer gets marked against the real scheme
 * and comes back as a card; anything else is answered from the papers with
 * citations. Routing happens here, not in the model, so the card is real data.
 */

import { esc, on, renderMarkdown, scrollToBottom } from "../ui/dom.js";
import { toast, openModal, closeModal } from "../ui/feedback.js";
import { groundedSubjects, subjectName, corpusCode, coverageFor } from "../store.js";
import { loadThreads, createThread, loadMessages, deleteThread, getChunk, weakTopics } from "../api/data.js";
import { ask, markAnswer, explainError } from "../api/ai.js";
import { navigate } from "../router.js";
import { paperLabel } from "../lib/exam.js";
import { looksLikeMarking, splitMarkRequest, looksLikeTechnique } from "../lib/routing.js";

const PROMPTS = [
  "How do I get full marks on a 6-mark 'explain' question?",
  "What is the difference between 'describe' and 'explain' in an Edexcel paper?",
  "What does 'Show that' actually want from me?",
];

let root = null;
let state = {
  threadId: null,
  subject: null,
  messages: [],
  historyPage: 0,
  hasOlder: false,
  busy: false,
  controller: null,
};

export async function render(container, { query = {} } = {}) {
  root = container;
  const grounded = groundedSubjects();
  state.subject = query.subject ?? state.subject ?? grounded[0]?.code ?? null;

  container.innerHTML = shell();
  wire();
  paint();

  // `q` asks for you; `draft` only fills the box (the Library uses it).
  const input = root.querySelector("#chatInput");
  if (query.q) {
    input.value = query.q;
    send();
  } else if (query.draft) {
    input.value = query.draft;
    input.dispatchEvent(new Event("input"));
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  return () => {
    state.controller?.abort();
    state.controller = null;
    state.busy = false;
  };
}

function shell() {
  const grounded = groundedSubjects();
  return `
    <div class="chat">
      <header class="chat-head">
        <div class="chat-subject">
          <select id="chatSubject" aria-label="Subject">
            ${grounded.length
              ? grounded.map((s) => `<option value="${esc(s.code)}">${esc(s.name)}</option>`).join("")
              : '<option value="">No papers added yet</option>'}
          </select>
        </div>
        <span class="chat-grounding" id="chatGrounding"></span>
        <div class="chat-tools">
          <button class="btn-ghost small" id="historyBtn">History</button>
          <button class="btn-ghost small" id="newChat">New chat</button>
        </div>
      </header>

      <div class="chat-thread" id="chatThread"></div>

      <form class="chat-composer" id="chatForm">
        <textarea id="chatInput" rows="1" data-autofocus
          placeholder="Ask a question..."></textarea>
        <button class="chat-send" id="chatSend" type="submit" aria-label="Send">↑</button>
        <button class="btn-ghost small" id="chatStop" type="button" hidden>Stop</button>
      </form>
      <p class="chat-hint">Answers come from the real papers and mark schemes. Every claim shows its source.</p>
    </div>`;
}

/* ------------------------------------------------------------------ wiring -- */

function wire() {
  const input = root.querySelector("#chatInput");
  const select = root.querySelector("#chatSubject");
  if (state.subject) select.value = state.subject;

  select.addEventListener("change", () => {
    state.subject = select.value || null;
    paintGrounding();
    if (!state.messages.length) paint();
  });
  paintGrounding();

  root.querySelector("#chatForm").addEventListener("submit", (e) => {
    e.preventDefault();
    send();
  });

  // Enter sends, Shift+Enter adds a line, and the box grows with the answer.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(220, input.scrollHeight)}px`;
  });

  root.querySelector("#chatStop").addEventListener("click", () => state.controller?.abort());

  root.querySelector("#newChat").addEventListener("click", () => {
    state.threadId = null;
    state.messages = [];
    state.historyPage = 0;
    state.hasOlder = false;
    paint();
    input.focus();
  });

  root.querySelector("#historyBtn").addEventListener("click", openHistory);
  on(root, "click", "[data-history-page]", async (_, btn) => {
    if (state.busy) return;
    setBusy(true);
    try { await loadHistoryPage(Number(btn.dataset.historyPage)); }
    catch (e) { toast(e.message, "error"); }
    finally { setBusy(false); }
  });

  on(root, "click", "[data-goto]", (_, btn) => navigate(btn.dataset.goto));
  on(root, "click", "[data-prompt]", (_, btn) => {
    input.value = btn.dataset.prompt;
    send();
  });
  on(root, "click", "[data-source-id]", (_, btn) => showSource(btn.dataset.sourceId));
  on(root, "click", ".cite", (_, btn) => {
    const msg = state.messages[Number(btn.dataset.msg)];
    const c = msg?.citations?.[Number(btn.dataset.cite) - 1];
    if (c) showSource(c.id);
  });
  on(root, "click", "[data-show-ms]", (_, btn) => {
    const panel = btn.closest(".mark-card").querySelector(".ms-panel");
    panel.hidden = !panel.hidden;
    btn.textContent = panel.hidden ? "Show the mark scheme" : "Hide the mark scheme";
  });
}

/* --------------------------------------------------------------- painting -- */

// Always show what this subject can be answered from, before the student asks.
function paintGrounding() {
  const el = root?.querySelector("#chatGrounding");
  if (!el) return;
  const cov = coverageFor(state.subject);
  el.innerHTML = cov
    ? `<span class="dot ok"></span>Reading ${cov.questions.toLocaleString()} real questions
       from ${cov.papers} past paper${cov.papers === 1 ? "" : "s"}${
         cov.from_year ? `, ${cov.from_year}–${cov.to_year}` : ""}`
    : `<span class="dot warn"></span>No papers loaded for this subject`;
}

function paint() {
  // A stream can keep arriving after the student has navigated away.
  const thread = root?.querySelector("#chatThread");
  if (!thread) return;

  if (!state.messages.length) {
    thread.innerHTML = welcome();
    void weakTopics(corpusCode(state.subject), 3).then((weak) => {
      const slot = root.querySelector("#weakSlot");
      if (!slot || !weak.length) return;
      slot.innerHTML = `
        <p class="chat-weak-title">You've been losing marks on</p>
        <div class="chat-weak">
          ${weak.map((w) => `
            <button class="chip-suggest" data-prompt="Give me practice on ${esc(w.topic)} and explain how to answer it">
              ${esc(w.topic)} <span class="muted">${Math.round(Number(w.pct ?? 0))}%</span>
            </button>`).join("")}
        </div>`;
    }).catch(() => {});
    return;
  }

  if (state.messages.length > 50) {
    state.messages = state.messages.slice(-50);
    state.hasOlder = true;
  }
  const paging = state.hasOlder || state.historyPage > 0 ? `
    <div class="view-actions">
      ${state.hasOlder ? `<button class="btn-ghost small" data-history-page="${state.historyPage + 1}" ${state.busy ? "disabled" : ""}>Earlier messages</button>` : ""}
      ${state.historyPage > 0 ? `<button class="btn-ghost small" data-history-page="0" ${state.busy ? "disabled" : ""}>Latest messages</button>` : ""}
    </div>` : "";
  thread.innerHTML = paging + state.messages.map(messageHTML).join("");
  scrollToBottom(thread);
}

function welcome() {
  const grounded = groundedSubjects();
  if (!grounded.length) {
    return `
      <div class="chat-welcome">
        <h2>No papers for your subjects yet</h2>
        <p>The assistant answers from real past papers and mark schemes, and none have been
           added for the subjects you take. Add one and everything here starts working.</p>
        <button class="btn-primary" data-goto="papers">Add a past paper</button>
        <button class="btn-ghost" data-goto="settings">Choose subjects</button>
      </div>`;
  }
  const cov = coverageFor(state.subject);
  return `
    <div class="chat-welcome">
      <h2>What are you working on?</h2>
      <p>
        Everything here is answered out of ${cov ? `${cov.questions.toLocaleString()} real exam questions and their
        mark schemes` : "real exam questions and their mark schemes"}. Not from what a chatbot half-remembers.
        Ask about a topic, or paste an answer and say which question it's for.
      </p>
      <div class="chat-prompts">
        ${PROMPTS.map((p) => `<button class="chip-suggest" data-prompt="${esc(p)}">${esc(p)}</button>`).join("")}
      </div>
      <div id="weakSlot"></div>
      <p class="chat-foot muted">
        Want to pick the question yourself?
        <button class="link-btn" data-goto="library">Browse the papers</button>
      </p>
    </div>`;
}

function messageHTML(m, i) {
  if (m.role === "user") {
    return `<div class="msg user"><div class="bubble">${esc(m.content)}</div></div>`;
  }
  if (m.kind === "mark") {
    return `<div class="msg model">${markCard(m.result)}</div>`;
  }
  if (m.kind === "note") {
    return `<div class="msg model"><p class="msg-note">${esc(m.content)}</p></div>`;
  }
  // Typing dots mean "still coming". An errored message isn't.
  const pending = !m.content && !m.error;
  return `
    <div class="msg model">
      <div class="bubble">
        ${m.content
          ? renderMarkdown(m.content).replace(/data-cite="/g, `data-msg="${i}" data-cite="`)
          : pending ? '<span class="typing"><i></i><i></i><i></i></span>' : ""}
        ${m.error ? `<p class="msg-error">${esc(m.error)}</p>` : ""}
      </div>
      ${m.grounded === false ? '<p class="ungrounded">Nothing matched in the papers you\'ve added, so this isn\'t grounded in a real one.</p>' : ""}
      ${sourceStrip(m.citations)}
    </div>`;
}

function sourceStrip(citations) {
  if (!citations?.length) return "";
  const shown = citations.slice(0, 6);
  return `
    <div class="sources">
      <p class="sources-title">
        <span class="sources-badge">From the papers</span>
        Answered using ${citations.length} real question${citations.length === 1 ? "" : "s"}: open any to read it
      </p>
      <div class="cite-strip">
        ${shown.map((c, i) => `
          <button class="cite-pill" data-source-id="${esc(c.id)}">
            <span class="cite-n">${i + 1}</span>${esc(c.label)}${
              c.marks ? `<span class="cite-marks">${c.marks} mark${c.marks === 1 ? "" : "s"}</span>` : ""}
          </button>`).join("")}
      </div>
    </div>`;
}

/** A marked answer, rendered as a card in the conversation. */
function markCard(r) {
  const pct = r.pct ?? 0;
  const band = pct >= 80 ? "good" : pct >= 50 ? "mid" : "poor";
  return `
    <div class="mark-card">
      <div class="mark-head">
        <span class="mark-score ${band}">${r.awarded}<span>/${r.total}</span></span>
        <span class="mark-ref">${esc(r.questionRef ?? "")}</span>
      </div>
      ${r.feedback ? `<p class="mark-feedback">${esc(r.feedback)}</p>` : ""}
      <ul class="breakdown">
        ${(r.breakdown ?? []).map((b) => `
          <li class="${b.earned ? "earned" : "lost"}">
            <span class="tick">${b.earned ? "✓" : "✗"}</span>
            <div><p class="point">${esc(b.point)}</p><p class="why">${esc(b.why)}</p></div>
          </li>`).join("")}
      </ul>
      ${r.missed?.length ? `
        <p class="mark-sub">What would have earned more</p>
        <ul class="bullets">${r.missed.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : ""}
      ${r.modelAnswer ? `
        <p class="mark-sub">A full-mark answer</p>
        <blockquote class="model-answer">${esc(r.modelAnswer)}</blockquote>` : ""}
      <div class="mark-tools">
        <button class="btn-ghost small" data-show-ms>Show the mark scheme</button>
      </div>
      <div class="ms-panel" hidden>
        <pre class="verbatim ms">${esc(r.markScheme ?? "")}</pre>
        <p class="field-hint">If the marking above disagrees with this, trust this.</p>
      </div>
    </div>`;
}

/* ---------------------------------------------------------------- sending -- */

async function send() {
  if (state.busy) return;
  const input = root.querySelector("#chatInput");
  const text = input.value.trim();
  if (!text) return;

  if (!state.subject) {
    toast("Add some past papers first.", "error");
    return;
  }

  if (state.historyPage > 0) {
    setBusy(true);
    try { await loadHistoryPage(0); }
    catch (e) { toast(e.message, "error"); setBusy(false); return; }
  }

  input.value = "";
  input.style.height = "auto";
  state.messages.push({ role: "user", content: text });
  setBusy(true);

  if (!state.threadId) {
    try {
      const thread = await createThread({ title: text, mode: "ask", subject: state.subject });
      state.threadId = thread.id;
    } catch {
      /* the chat still works unsaved */
    }
  }

  if (looksLikeMarking(text)) await runMark(text);
  else await runAsk(text, looksLikeTechnique(text) ? "technique" : "ask");

  setBusy(false);
  state.controller = null;
}

async function runMark(text) {
  const placeholder = { role: "model", content: "" };
  state.messages.push(placeholder);
  paint();

  const { question, answer } = splitMarkRequest(text);
  state.controller = new AbortController();

  const drop = () => {
    const i = state.messages.indexOf(placeholder);
    if (i >= 0) state.messages.splice(i, 1);
  };

  try {
    const result = await markAnswer(
      { question, answer, subject: corpusCode(state.subject) },
      { signal: state.controller.signal },
    );
    Object.assign(placeholder, { kind: "mark", result });
    paint();
    return;
  } catch (e) {
    const message = explainError(e);
    // Cancelled by the student: take the empty bubble away and say nothing.
    if (!message) {
      drop();
      paint();
      return;
    }
    // No scheme or no matching question: answer it as a question instead, and
    // leave a one-line note rather than an empty bubble.
    if (e?.code === "not_found" || e?.code === "no_markscheme") {
      drop();
      state.messages.push({
        role: "model",
        kind: "note",
        content: `${message} Answering it as a question instead.`,
      });
      paint();
      await runAsk(text);
      return;
    }
    placeholder.error = message;
    paint();
  }
}

async function runAsk(text, mode = "ask") {
  const reply = { role: "model", content: "", citations: [] };
  state.messages.push(reply);
  paint();

  // Mark cards and app notes aren't conversation; don't feed them back as turns.
  const history = state.messages
    .slice(0, -2)
    .filter((m) => m.content && m.kind !== "mark" && m.kind !== "note")
    .slice(-6)
    .map((m) => ({ role: m.role, text: m.content }));

  state.controller = new AbortController();

  try {
    await ask(
      { question: text, subject: corpusCode(state.subject), mode, threadId: state.threadId, history },
      {
        onCitations(citations, grounded) {
          reply.citations = citations;
          reply.grounded = grounded;
          paint();
        },
        onDelta(delta) {
          reply.content += delta;
          const last = root?.querySelector("#chatThread .msg.model:last-child .bubble");
          if (last) {
            last.innerHTML = renderMarkdown(reply.content);
            scrollToBottom(root.querySelector("#chatThread"));
          }
        },
        onError(e) {
          reply.error = explainError(e);
          paint();
        },
      },
      { signal: state.controller.signal },
    );
  } catch (e) {
    const message = explainError(e);
    if (message) reply.error = message;
  }
  if (!reply.content && !reply.error) reply.error = "No answer came back. Try again.";
  paint();
}

function setBusy(busy) {
  state.busy = busy;
  const send = root?.querySelector("#chatSend");
  const stop = root?.querySelector("#chatStop");
  if (send) send.hidden = busy;
  if (stop) stop.hidden = !busy;
  root?.querySelectorAll("[data-history-page], #newChat, #historyBtn").forEach((button) => { button.disabled = busy; });
}

/* ---------------------------------------------------------------- sources -- */

async function showSource(chunkId) {
  openModal({
    title: "Source",
    width: "wide",
    body: '<div class="loading"><span class="spinner"></span>Loading…</div>',
    async onMount(dialog) {
      const target = dialog.querySelector(".modal-body");
      try {
        const c = await getChunk(chunkId);
        if (!c) throw new Error("That source is no longer available.");
        dialog.querySelector("#modalTitle").textContent =
          paperLabel(c);
        target.innerHTML = `
          <div class="source-doc">
            <p class="source-ref">
              ${c.marks ? `${c.marks} mark${c.marks === 1 ? "" : "s"}` : ""}${c.topic ? ` · ${esc(c.topic)}` : ""}
            </p>
            <pre class="verbatim">${esc(c.content)}</pre>
            ${c.ms_content
              ? `<details class="model-details"><summary>Mark scheme</summary>
                   <pre class="verbatim ms">${esc(c.ms_content)}</pre></details>`
              : ""}
            ${c.er_content
              ? `<details class="model-details"><summary>What examiners said</summary>
                   <pre class="verbatim er">${esc(c.er_content)}</pre></details>`
              : ""}
          </div>`;
      } catch (e) {
        target.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
      }
    },
  });
}

/* ---------------------------------------------------------------- history -- */

async function openHistory() {
  openModal({
    title: "Your chats",
    body: '<div class="loading"><span class="spinner"></span>Loading…</div>',
    async onMount(dialog) {
      const target = dialog.querySelector(".modal-body");
      try {
        const threads = await loadThreads();
        if (!threads.length) {
          target.innerHTML = "<p class='muted'>No saved chats yet.</p>";
          return;
        }
        target.innerHTML = `
          <ul class="thread-list">
            ${threads.map((t) => `
              <li>
                <button class="thread-open" data-thread="${esc(t.id)}">
                  <span class="thread-title">${esc(t.title)}</span>
                  <span class="thread-meta">${t.subject_code ? esc(subjectName(t.subject_code)) : ""}</span>
                </button>
                <button class="icon-btn" data-del-thread="${esc(t.id)}" aria-label="Delete chat">&times;</button>
              </li>`).join("")}
          </ul>`;

        target.addEventListener("click", async (e) => {
          const open = e.target.closest("[data-thread]");
          if (open) {
            await resume(open.dataset.thread, threads);
            closeModal();
            return;
          }
          const del = e.target.closest("[data-del-thread]");
          if (del) {
            try {
              await deleteThread(del.dataset.delThread);
              del.closest("li").remove();
            } catch (err) {
              toast(err.message, "error");
            }
          }
        });
      } catch (e) {
        target.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
      }
    },
  });
}

async function resume(id, threads) {
  try {
    const meta = threads.find((t) => t.id === id);
    state.threadId = id;
    state.subject = meta?.subject_code ?? state.subject;
    await loadHistoryPage(0);
    root.querySelector("#chatSubject").value = state.subject ?? "";
    paint();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function loadHistoryPage(page) {
  const threadId = state.threadId;
  const { rows, hasMore } = await loadMessages(threadId, page);
  if (state.threadId !== threadId) return;
  state.historyPage = page;
  state.hasOlder = hasMore;
  state.messages = rows.map((m) => ({ role: m.role, content: m.content, citations: m.citations ?? [] }));
  paint();
}

/** Forget the conversation on sign-in/out, so a shared computer doesn't show the last student's chat. */
export function invalidate() {
  state.controller?.abort();
  state = { threadId: null, subject: null, messages: [], historyPage: 0, hasOlder: false, busy: false, controller: null };
}
