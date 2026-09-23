/**
 * Recall: short real questions, self-rated, on a spacing schedule.
 *
 * Two deliberate constraints:
 *
 *   1. The cards are real exam questions with their real mark schemes. Nothing
 *      here is generated, so there is nothing to hallucinate and the answer
 *      you are shown is the one an examiner would credit.
 *   2. Self-ratings never touch `topic_mastery`. Mastery is the app's claim
 *      that every number it shows came from marks awarded against a real mark
 *      scheme, and "I knew that" is not a mark. Recall keeps its own schedule
 *      in `recall_reviews` and stays out of the way.
 *
 * It also costs no AI call at all, which makes it the one thing a student can
 * do freely after the daily allowance is spent.
 */

import { esc, on } from "../ui/dom.js";
import { toast, emptyState, spinner } from "../ui/feedback.js";
import { groundedSubjects, corpusCode, subjectName, savePrefs, store } from "../store.js";
import { recallDeck, recordRecall, syncPrefs } from "../api/data.js";
import { navigate } from "../router.js";
import { paperLabel, markPill } from "../lib/exam.js";

const DECK_SIZE = 15;

/** One option per corpus: two courses can answer from the same papers. */
function corpusOptions(subjects) {
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

const GRADES = [
  { id: 0, label: "Again", hint: "No idea", cls: "poor" },
  { id: 1, label: "Hard", hint: "Got there slowly", cls: "mid" },
  { id: 2, label: "Good", hint: "Knew it", cls: "good" },
  { id: 3, label: "Easy", hint: "Instant", cls: "good" },
];

let root = null;
let state = { subject: null, deck: [], index: 0, revealed: false, done: 0, busy: false };

export async function render(container, { query = {} } = {}) {
  root = container;
  const grounded = groundedSubjects();

  state.subject = query.subject
    ? corpusCode(query.subject)
    : state.subject ?? store.prefs.lastCorpus ?? (grounded[0] ? corpusCode(grounded[0].code) : null);
  // A remembered subject the student no longer takes (or that lost its papers)
  // would otherwise load a deck the dropdown does not show.
  if (!grounded.some((s) => corpusCode(s.code) === state.subject)) {
    state.subject = grounded[0] ? corpusCode(grounded[0].code) : null;
  }

  if (!grounded.length) {
    container.innerHTML = `
      <header class="view-head"><div><h1>Recall</h1></div></header>
      ${emptyState({
        icon: "🗂",
        title: "No questions to practise on yet",
        message: "Recall uses real short questions and their mark schemes. Add a past paper and they appear here.",
        action: `<button class="btn-primary" data-goto="papers">Add a paper</button>`,
      })}`;
    on(root, "click", "[data-goto]", (_, b) => navigate(b.dataset.goto));
    return;
  }

  container.innerHTML = shell(grounded);
  wire();
  await loadDeck();

  // Space and 1-4 are the whole interface once you are going: the point of
  // recall practice is speed, and reaching for the mouse forty times is not.
  const keys = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    // Space and Enter are how a keyboard user presses a focused button. Taking
    // them here meant a button that had focus (Sign out, a nav link, Settings)
    // could no longer be activated while a card was showing.
    if (e.target?.closest?.("button, a, [role=button], [role=menuitem]") && !e.target.closest(".recall-card")) return;
    if (e.key === " " || e.key === "Enter") {
      if (!state.revealed && state.deck[state.index]) {
        e.preventDefault();
        reveal();
      }
      return;
    }
    const n = Number(e.key);
    if (state.revealed && n >= 1 && n <= 4) {
      e.preventDefault();
      void grade(n - 1);
    }
  };
  document.addEventListener("keydown", keys);
  return () => document.removeEventListener("keydown", keys);
}

function shell(grounded) {
  return `
    <header class="view-head">
      <div>
        <h1>Recall</h1>
        <p class="view-sub">
          Short real questions, spaced so the ones you keep missing come back soonest.
          No AI, no allowance spent.
        </p>
      </div>
      <div class="view-actions">
        <label class="inline-field">
          <span class="muted">Subject</span>
          <select id="recallSubject">
            ${corpusOptions(grounded)}
          </select>
        </label>
      </div>
    </header>
    <div id="recallBody"></div>`;
}

function wire() {
  root.querySelector("#recallSubject").addEventListener("change", async (e) => {
    state.subject = e.target.value;
    savePrefs({ lastCorpus: state.subject });
    syncPrefs();
    await loadDeck();
  });

  on(root, "click", "[data-reveal]", reveal);
  on(root, "click", "[data-grade]", (_, btn) => grade(Number(btn.dataset.grade)));
  on(root, "click", "[data-restock]", loadDeck);
  on(root, "click", "[data-goto]", (_, b) => navigate(b.dataset.goto));
}

async function loadDeck() {
  const body = root?.querySelector("#recallBody");
  if (!body) return;
  body.innerHTML = spinner("Building a deck…");

  try {
    state.deck = await recallDeck(state.subject, DECK_SIZE);
  } catch (e) {
    body.innerHTML = `<div class="empty error"><h3>Couldn't build a deck</h3><p>${esc(e.message)}</p></div>`;
    return;
  }
  state.index = 0;
  state.revealed = false;
  state.done = 0;
  paint();
}

/* ---------------------------------------------------------------- painting -- */

function paint() {
  const body = root?.querySelector("#recallBody");
  if (!body) return;

  if (!state.deck.length) {
    body.innerHTML = emptyState({
      icon: "✓",
      title: state.done ? "Deck finished" : "Nothing due",
      message: state.done
        ? `${state.done} card${state.done === 1 ? "" : "s"} reviewed. Come back when the next ones are due, or build another deck.`
        : `Every ${subjectName(state.subject)} card you have seen is scheduled for later. Nothing to do right now.`,
      action: `<button class="btn-ghost" data-restock>Build another deck</button>`,
    });
    return;
  }

  const card = state.deck[state.index];
  if (!card) {
    state.deck = [];
    paint();
    return;
  }

  const progress = Math.round((state.done / (state.done + state.deck.length)) * 100);

  body.innerHTML = `
    <div class="recall">
      <div class="recall-progress">
        <span class="progress-bar"><span style="width:${progress}%"></span></span>
        <span class="muted">${state.done} done · ${state.deck.length} left</span>
      </div>

      <div class="recall-stage">
      <article class="recall-card${state.revealed ? " is-revealed" : ""}" aria-live="polite">
        <header class="recall-head">
          <span class="paper-ref">${esc(paperLabel(card))}</span>
          ${card.marks ? `<span class="marks-pill">${markPill(card.marks)}</span>` : ""}
          ${card.topic ? `<span class="lib-topic">${esc(card.topic)}</span>` : ""}
          ${card.reps ? `<span class="muted">seen ${card.reps}×</span>` : '<span class="muted">new</span>'}
        </header>

        ${state.revealed ? `
          <section class="recall-face back" aria-label="Flashcard answer">
            <span class="recall-side-label">Answer</span>
            <p class="recall-prompt">${esc(card.content)}</p>
            <div class="recall-answer">${esc(card.ms_content ?? "")}</div>
          </section>
        ` : `
          <section class="recall-face front" aria-label="Flashcard question">
            <span class="recall-side-label">Question</span>
            <div class="recall-question">${esc(card.content)}</div>
            <div class="recall-actions">
              <button class="btn-primary big" data-reveal>Reveal answer</button>
              <span class="muted">or press space</span>
            </div>
          </section>`}
      </article>
      </div>

        ${state.revealed ? `
          <section class="recall-rating" aria-label="Rate this flashcard">
          <p class="recall-ask">How did that go?</p>
          <div class="recall-grades">
            ${GRADES.map((g, i) => `
              <button class="recall-grade ${g.cls}" data-grade="${g.id}" ${state.busy ? "disabled" : ""}>
                <span class="recall-grade-label">${g.label}</span>
                <span class="recall-grade-hint">${g.hint}</span>
                <span class="recall-grade-key">${i + 1}</span>
              </button>`).join("")}
          </div>
          </section>` : ""}
    </div>`;
}

function reveal() {
  if (state.revealed) return;
  state.revealed = true;
  paint();
}

async function grade(value) {
  if (state.busy) return;
  const card = state.deck[state.index];
  if (!card) return;

  state.busy = true;
  paint();
  try {
    await recordRecall(card.id, state.subject, value);
  } catch (e) {
    toast(e.message, "error");
    state.busy = false;
    paint();
    return;
  }

  // "Again" puts the card back at the end of this deck as well as tomorrow:
  // a card you have just failed is worth seeing once more in this sitting.
  state.deck.splice(state.index, 1);
  if (value === 0) state.deck.push({ ...card, reps: 0 });
  else state.done++;

  if (state.index >= state.deck.length) state.index = 0;
  state.revealed = false;
  state.busy = false;
  paint();
}

/** Called after sign-in so the deck is rebuilt for the new account. */
export function invalidate() {
  state = { subject: null, deck: [], index: 0, revealed: false, done: 0, busy: false };
}
