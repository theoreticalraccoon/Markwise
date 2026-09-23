/**
 * Your papers: add past papers to the corpus from the browser.
 *
 * Markwise is only as good as what it has read, and until this screen existed
 * the only way to feed it was a Node CLI, a service-role key and a folder of
 * correctly named PDFs. That is fine for the person who built it and useless
 * to everyone else: a student whose subject had not been ingested was told,
 * honestly but uselessly, that there was nothing to ground on.
 *
 * The student drops files in. The server reads each one's cover page to work
 * out what it is, extracts the questions or the marking points, embeds them and
 * stores them. Nothing is asked of the student: not the subject, not the year,
 * not a filename convention.
 *
 * Files are uploaded one at a time, deliberately. Each one is a whole document
 * going to Gemini, and a queue that reports each file as it lands is far more
 * useful than one request that either works or does not after four minutes.
 */

import { esc, on } from "../ui/dom.js";
import { toast, confirmModal, emptyState } from "../ui/feedback.js";
import { store, mySubjectRows, coverageFor, subjectName } from "../store.js";
import { ingestPaper, explainError } from "../api/ai.js";
import { loadCatalogue } from "../api/data.js";
import { navigate } from "../router.js";

/** Matches MAX_BASE64 in the edge function, less the base64 overhead. */
const MAX_BYTES = 11 * 1024 * 1024;
const MAX_QUEUE = 20;

let root = null;
/** [{ name, mimeType, data, size, status, message }] */
let queue = [];
let running = false;
/** Bumped whenever the screen is entered or left, so an old upload loop can tell. */
let generation = 0;

export async function render(container) {
  root = container;
  queue = [];
  running = false;
  generation++;

  // Adding a paper replaces questions and mark schemes that every student is
  // marked against, so it is limited to whoever runs this deployment. Say so
  // before offering a drop zone that would only fail.
  if (!store.isAdmin) {
    container.innerHTML = `
      <header class="view-head"><div><h1>Your papers</h1></div></header>
      ${emptyState({
        icon: "🔒",
        title: "Adding papers is limited to the person who runs Markwise",
        message:
          "Everything you are answered and marked against comes from one shared library, and changing it " +
          "changes it for every student. Ask whoever set this up to add the paper you need. What is in it now is below.",
      })}
      <h2 class="section-title">What Markwise has read</h2>
      <div id="pCoverage"></div>`;
    paintCoverage();
    return;
  }

  container.innerHTML = shell();
  wire();
  paintQueue();

  // Leaving the screen stops the queue. Otherwise coming back started a second
  // loop on a fresh queue while the first was still waiting on the network,
  // which defeated the one-file-at-a-time rate limiting.
  return () => { generation++; running = false; };
}

function shell() {
  return `
    <header class="view-head">
      <div>
        <h1>Your papers</h1>
        <p class="view-sub">
          Add past papers and mark schemes. Markwise reads each one, splits it into questions
          and pairs them with their marking points, so everything it later says can point at
          a real document.
        </p>
      </div>
    </header>

    <label class="dropzone tall" id="pDrop">
      <input type="file" id="pFiles" accept="application/pdf,image/*" multiple hidden>
      <span class="dropzone-icon" aria-hidden="true">📚</span>
      <span class="dropzone-main">Drop past papers here, or tap to choose</span>
      <span class="dropzone-sub">
        Question papers and mark schemes, as PDFs. Add them in any order: a mark scheme
        that arrives before its question paper waits for it. Up to ${MAX_QUEUE} at a time,
        11 MB each.
      </span>
    </label>

    <div id="pQueue"></div>

    <h2 class="section-title">What Markwise has read</h2>
    <div id="pCoverage"></div>

    <p class="field-hint copyright">
      Past papers, mark schemes and syllabuses are &copy; their awarding body. Add only material
      you are licensed to use, and keep your deployment private to yourself or your school.
    </p>`;
}

/* ------------------------------------------------------------------ wiring -- */

function wire() {
  const input = root.querySelector("#pFiles");
  input.addEventListener("change", () => {
    addFiles([...input.files]);
    input.value = "";
  });

  const drop = root.querySelector("#pDrop");
  for (const type of ["dragenter", "dragover"]) {
    drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add("over"); });
  }
  for (const type of ["dragleave", "drop"]) {
    drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.remove("over"); });
  }
  drop.addEventListener("drop", (e) => addFiles([...(e.dataTransfer?.files ?? [])]));

  on(root, "click", "[data-drop-queued]", (_, btn) => {
    const i = Number(btn.dataset.dropQueued);
    if (queue[i]?.status === "working") return;
    queue.splice(i, 1);
    paintQueue();
  });

  on(root, "click", "#pClear", async () => {
    const ok = await confirmModal({
      title: "Clear the list",
      message: "Files still waiting are removed. Anything already added stays in the corpus.",
      confirmLabel: "Clear",
    });
    if (!ok) return;
    queue = queue.filter((f) => f.status === "working");
    paintQueue();
  });

  on(root, "click", "[data-goto]", (_, btn) => navigate(btn.dataset.goto));

  paintCoverage();
}

/* ------------------------------------------------------------------- files -- */

async function addFiles(incoming) {
  const room = MAX_QUEUE - queue.length;
  if (room <= 0) {
    toast(`That is the limit of ${MAX_QUEUE} files at a time.`, "error");
    return;
  }

  for (const file of incoming.slice(0, room)) {
    if (file.type !== "application/pdf" && !/^image\//.test(file.type)) {
      toast(`${file.name} is not a PDF.`, "error");
      continue;
    }
    if (file.size > MAX_BYTES) {
      queue.push({
        name: file.name, size: file.size, status: "error",
        message: "Too large. Split the PDF, or export it at a lower quality.",
      });
      continue;
    }
    queue.push({
      name: file.name, mimeType: file.type, size: file.size,
      status: "waiting", message: "Waiting",
      data: await toBase64(file),
    });
  }
  paintQueue();
  void run();
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ----------------------------------------------------------------- running -- */

/**
 * One file at a time.
 *
 * Each upload is a whole PDF going through a vision model; firing six at once
 * would collide with the per-key rate limit and turn six slow successes into
 * six fast 429s.
 */
async function run() {
  if (running) return;
  running = true;
  const mine = generation;

  try {
    for (;;) {
      if (mine !== generation) return;   // the student left the screen
      const next = queue.find((f) => f.status === "waiting");
      if (!next) break;
      next.status = "working";
      next.message = "Reading it…";
      paintQueue();

      try {
        const result = await ingestPaper({
          file: { mimeType: next.mimeType, data: next.data },
          fileName: next.name,
        });
        next.status = "done";
        next.message = result.message ?? "Added.";
        next.data = null;   // release the base64 as soon as it has landed
      } catch (e) {
        next.status = "error";
        next.message = explainError(e) ?? "Could not add that file.";
        next.data = null;
        // Not allowed to add papers: every remaining file would fail the same
        // way, so stop rather than spend the queue finding that out.
        if (e?.code === "admin_only") {
          queue.filter((f) => f.status === "waiting").forEach((f) => { f.status = "error"; f.message = next.message; f.data = null; });
        }
      }
      paintQueue();
    }
  } finally {
    running = false;
  }

  // Coverage drives every "can the AI answer for this subject" decision in the
  // app, so refresh it once the run is over rather than per file.
  try {
    await loadCatalogue();
  } catch {
    /* the list on screen is still correct */
  }
  paintCoverage();
}

/* ---------------------------------------------------------------- painting -- */

function paintQueue() {
  const slot = root?.querySelector("#pQueue");
  if (!slot) return;
  if (!queue.length) {
    slot.innerHTML = "";
    return;
  }

  const done = queue.filter((f) => f.status === "done").length;
  const failed = queue.filter((f) => f.status === "error").length;
  const left = queue.filter((f) => f.status === "waiting" || f.status === "working").length;

  const icon = { waiting: "·", working: "◌", done: "✓", error: "!" };

  slot.innerHTML = `
    <section class="queue">
      <div class="queue-head">
        <strong>${done} added</strong>
        ${failed ? `<span class="muted">${failed} failed</span>` : ""}
        ${left ? `<span class="muted">${left} to go</span>` : ""}
        <button class="btn-ghost small" id="pClear">Clear the list</button>
      </div>
      <ul class="queue-list">
        ${queue.map((f, i) => `
          <li class="queue-item ${esc(f.status)}">
            <span class="queue-icon" aria-hidden="true">${icon[f.status] ?? "·"}</span>
            <span class="queue-text">
              <span class="queue-name">${esc(f.name)}</span>
              <span class="queue-msg">${esc(f.message)}</span>
            </span>
            ${f.status === "working" ? "" :
              `<button class="icon-btn" data-drop-queued="${i}" aria-label="Remove ${esc(f.name)}">&times;</button>`}
          </li>`).join("")}
      </ul>
    </section>`;
}

/**
 * What the corpus actually holds, for the subjects this student takes.
 *
 * The honest version of the claim on the front of the app: these are the
 * documents the answers will come from, and a subject with none says so.
 */
function paintCoverage() {
  const slot = root?.querySelector("#pCoverage");
  if (!slot) return;

  const mine = mySubjectRows();
  const rows = mine.length ? mine : store.subjects.slice(0, 12);
  if (!rows.length) {
    slot.innerHTML = '<p class="muted">Pick your subjects in Settings first.</p>';
    return;
  }

  slot.innerHTML = `
    <div class="coverage">
      ${rows.map((s) => {
        const cov = coverageFor(s.code);
        return `
          <div class="coverage-row">
            <span class="coverage-name">${esc(subjectName(s.code))}</span>
            <span class="coverage-count">
              ${cov ? `${cov.questions.toLocaleString()} questions · ${cov.papers} paper${cov.papers === 1 ? "" : "s"}` : "nothing yet"}
            </span>
            <span class="coverage-years">${cov?.from_year ? `${cov.from_year}–${cov.to_year}` : ""}</span>
          </div>`;
      }).join("")}
    </div>`;
}
