// Progress: every number comes from marks awarded against real schemes.
// Recall self-ratings are left out on purpose. Weak topics link to the tools
// that fix them.

import { esc, on } from "../ui/dom.js";
import { toast, emptyState, skeleton, openModal } from "../ui/feedback.js";
import { subjectName, mySubjectRows, corpusCode } from "../store.js";
import {
  loadAttempts, loadMastery, weakTopics, getAttempt, loadMocks,
  progressSeries, subjectReadiness, loadPaperAttempts,
} from "../api/data.js";
import { formatDateTime } from "../lib/dates.js";
import { addRevisionTask } from "./planner.js";
import { navigate } from "../router.js";
import { gradeHistory } from "../lib/exam.js";

let root = null;
let subject = null;

export async function render(container, { query = {} } = {}) {
  root = container;
  // Attempts are stored under the corpus subject, so filter by that.
  subject = query.subject ? corpusCode(query.subject) : (subject ?? null);

  container.innerHTML = `
    <header class="view-head">
      <div>
        <h1>Progress</h1>
        <p class="view-sub">Built only from answers marked against real mark schemes.</p>
      </div>
      <div class="view-actions">
        <label class="inline-field">
          <span class="muted">Subject</span>
          <select id="progSubject">
            <option value="">All subjects</option>
            ${mySubjectRows().map((s) => {
              const code = corpusCode(s.code);
              return `<option value="${esc(code)}"${code === subject ? " selected" : ""}>${esc(s.name)}</option>`;
            }).join("")}
          </select>
        </label>
        <button class="btn-ghost" id="printProgress">Print</button>
      </div>
    </header>
    <div id="progBody">${skeleton(5)}</div>`;

  root.querySelector("#progSubject").addEventListener("change", (e) => {
    subject = e.target.value || null;
    load();
  });
  root.querySelector("#printProgress").addEventListener("click", () => window.print());

  on(root, "click", "[data-goto]", (_, btn) => navigate(btn.dataset.goto));
  on(root, "click", "[data-attempt]", (_, btn) => showAttempt(btn.dataset.attempt));
  on(root, "click", "[data-paper]", (_, btn) => navigate(`markpaper/${btn.dataset.paper}`));
  on(root, "click", "[data-mock-weak]", () => navigate("mock"));
  on(root, "click", "[data-revise]", async (_, btn) => {
    btn.disabled = true;
    try {
      await addRevisionTask({
        subject: btn.dataset.subject,
        topic: btn.dataset.revise,
        text: `Revise ${btn.dataset.revise}`,
      });
    } catch (e) {
      btn.disabled = false;
      toast(e.message, "error");
    }
  });

  await load();
}

async function load() {
  const body = root.querySelector("#progBody");
  body.innerHTML = skeleton(5);

  let attempts, mastery, weak, mocks, series, readiness, papers;
  try {
    [attempts, mastery, weak, mocks, series, readiness, papers] = await Promise.all([
      loadAttempts({ subject, limit: 200 }),
      loadMastery(subject),
      weakTopics(subject, 6),
      loadMocks(50),
      progressSeries(subject, 12),
      subject ? subjectReadiness(subject) : Promise.resolve(null),
      loadPaperAttempts(50),
    ]);
  } catch (e) {
    body.innerHTML = `<div class="empty error"><h3>Couldn't load your progress</h3><p>${esc(e.message)}</p></div>`;
    return;
  }

  const grades = gradeHistory(mocks, papers, subject);
  if (!attempts.length && !grades.length) {
    body.innerHTML = emptyState({
      icon: "📈",
      title: "Nothing marked yet",
      message: "Answer a past question and have it marked. Your topic profile builds itself from there.",
      action: `
        <button class="btn-primary" data-goto="assistant">Mark an answer</button>
        <button class="btn-ghost" data-goto="markpaper">Or photograph a whole paper</button>`,
    });
    return;
  }

  const marks = attempts.reduce(
    (acc, a) => ({ awarded: acc.awarded + Number(a.awarded), total: acc.total + a.total }),
    { awarded: 0, total: 0 },
  );
  const overall = marks.total ? Math.round((marks.awarded / marks.total) * 100) : 0;

  body.innerHTML = `
    <section class="stat-row">
      ${stat("Overall", `${overall}%`, `${marks.awarded} of ${marks.total} marks`)}
      ${stat("Questions marked", attempts.length, subject ? subjectName(subject) : "across all subjects")}
      ${stat("Mocks sat", mocks.filter((m) => m.status === "marked" && (!subject || m.subject_code === subject)).length, "marked papers")}
      ${stat("Topics tracked", mastery.length, "with at least one attempt")}
    </section>

    ${readiness ? readinessCard(readiness) : ""}

    ${grades.map(gradeChart).join("")}

    ${series.length > 1 ? `
      <section class="card plain">
        <header><h2>How you are trending</h2></header>
        ${sparkline(series)}
        <p class="field-hint">
          One point per week you did some marked work. Weeks you did none are left out rather
          than drawn as zero.
        </p>
      </section>` : ""}

    ${weak.length ? `
      <section class="card plain">
        <header>
          <h2>Where you are losing marks</h2>
          <button class="btn-ghost small" data-mock-weak>Build a mock on these</button>
        </header>
        <div class="topic-bars">
          ${weak.map((w) => {
            const pct = Number(w.pct ?? 0);
            return `
              <div class="topic-bar">
                <span class="topic-name">${esc(w.topic)}${!subject ? ` <span class="muted">${esc(subjectName(w.subject_code))}</span>` : ""}</span>
                <span class="bar"><span style="width:${pct}%" class="${pct >= 70 ? "good" : pct >= 40 ? "mid" : "poor"}"></span></span>
                <span class="topic-score">${pct}%</span>
                <span class="topic-actions">
                  <button class="link-btn" data-revise="${esc(w.topic)}" data-subject="${esc(w.subject_code)}">Revise</button>
                  <button class="link-btn" data-goto="recall?subject=${encodeURIComponent(w.subject_code)}">Practise</button>
                </span>
              </div>`;
          }).join("")}
        </div>
      </section>` : ""}

    <section class="card plain">
      <header><h2>Every topic</h2></header>
      ${mastery.length ? `
        <div class="topic-bars">
          ${[...mastery]
            .map((m) => ({ ...m, pct: m.marks_total ? Math.round((m.marks_awarded / m.marks_total) * 100) : 0 }))
            .sort((a, b) => b.pct - a.pct)
            .map((m) => `
              <div class="topic-bar">
                <span class="topic-name">${esc(m.topic)}</span>
                <span class="bar"><span style="width:${m.pct}%" class="${m.pct >= 70 ? "good" : m.pct >= 40 ? "mid" : "poor"}"></span></span>
                <span class="topic-score">${m.marks_awarded}/${m.marks_total}</span>
              </div>`).join("")}
        </div>` : '<p class="muted">No topics classified yet.</p>'}
    </section>

    ${papers.length ? `
      <section class="card plain">
        <header><h2>Papers you have had marked</h2></header>
        <ul class="attempt-list">
          ${papers.filter((p) => !subject || p.subject_code === subject).slice(0, 5).map((p) => `
            <li>
              <button data-paper="${esc(p.id)}">
                <span class="attempt-ref">${esc(p.title)}</span>
                <span class="attempt-topic">${esc(subjectName(p.subject_code))}</span>
                <span class="attempt-score ${p.pct >= 70 ? "good" : p.pct >= 40 ? "mid" : "poor"}">${p.awarded}/${p.total}</span>
                <span class="attempt-when muted">${formatDateTime(p.created_at)}</span>
              </button>
            </li>`).join("")}
        </ul>
      </section>` : ""}

    <section class="card plain">
      <header><h2>Recent answers</h2></header>
      <ul class="attempt-list">
        ${attempts.slice(0, 25).map((a) => {
          const pct = a.total ? Math.round((a.awarded / a.total) * 100) : 0;
          return `
            <li>
              <button data-attempt="${esc(a.id)}">
                <span class="attempt-ref">${esc(a.question_ref ?? "Question")}</span>
                <span class="attempt-topic">${esc(a.topic ?? "")}</span>
                <span class="attempt-score ${pct >= 70 ? "good" : pct >= 40 ? "mid" : "poor"}">${a.awarded}/${a.total}</span>
                <span class="attempt-when muted">${formatDateTime(a.created_at)}</span>
              </button>
            </li>`;
        }).join("")}
      </ul>
    </section>`;
}

function stat(label, value, sub) {
  return `
    <div class="stat">
      <span class="stat-value">${esc(value)}</span>
      <span class="stat-label">${esc(label)}</span>
      <span class="stat-sub">${esc(sub)}</span>
    </div>`;
}

function gradeChart({ subject: code, points }) {
  const width = 640, height = 144, pad = 20;
  const start = Date.parse(points[0].at), end = Date.parse(points.at(-1).at);
  const plotted = points.map((p) => ({ ...p,
    x: start === end ? width / 2 : pad + (Date.parse(p.at) - start) / (end - start) * (width - pad * 2),
    y: height - pad - p.value / 9 * (height - pad * 2),
  }));
  const path = plotted.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  return `
    <section class="card plain grade-history" data-grade-subject="${esc(code)}">
      <header><h2>${esc(subjectName(code))}: predicted grades</h2></header>
      <svg viewBox="0 0 ${width} ${height}" class="spark-svg" role="img"
        aria-label="${esc(subjectName(code))} predicted grades: ${points.map((p) => p.grade).join(", ")}">
        <path d="${path}" class="spark-line"></path>
        ${plotted.map((p, i) => `<circle cx="${p.x}" cy="${p.y}" r="4" class="spark-dot">
          <title>${esc(formatDateTime(p.at))}: grade ${p.grade}</title></circle>
          ${i === plotted.length - 1 ? `<text x="${p.x}" y="${p.y - 8}" text-anchor="middle" fill="currentColor" font-size="12">${p.grade}</text>` : ""}`).join("")}
      </svg>
      <ul class="attempt-list">
        ${points.slice(-5).reverse().map((p) => `<li><button data-goto="${esc(p.route)}">
          <span class="attempt-ref">${esc(p.title)}</span><span class="attempt-score">Grade ${p.grade}</span>
          <span class="attempt-when muted">${formatDateTime(p.at)}</span>
        </button></li>`).join("")}
      </ul>
    </section>`;
}

/** Readiness as three real numbers (coverage, accuracy, mocks sat), not one made-up score. */
function readinessCard(r) {
  const coverage = r.topics_total ? Math.round((r.topics_seen / r.topics_total) * 100) : 0;
  const strong = r.topics_total ? Math.round((r.topics_strong / r.topics_total) * 100) : 0;
  const pct = Number(r.pct ?? 0);

  return `
    <section class="card plain readiness">
      <header><h2>How ready you are for ${esc(subjectName(subject))}</h2></header>
      <div class="readiness-grid">
        <div class="readiness-leg">
          <span class="readiness-n">${coverage}%</span>
          <span class="readiness-label">of the syllabus touched</span>
          <span class="readiness-sub muted">${r.topics_seen} of ${r.topics_total} topics have been marked at least once</span>
        </div>
        <div class="readiness-leg">
          <span class="readiness-n ${pct >= 70 ? "good" : pct >= 40 ? "mid" : "poor"}">${pct || 0}%</span>
          <span class="readiness-label">of the marks you attempted</span>
          <span class="readiness-sub muted">${r.marks_awarded ?? 0} of ${r.marks_total ?? 0} marks</span>
        </div>
        <div class="readiness-leg">
          <span class="readiness-n">${strong}%</span>
          <span class="readiness-label">of topics at 70% or better</span>
          <span class="readiness-sub muted">${r.topics_strong} topic${r.topics_strong === 1 ? "" : "s"} solid</span>
        </div>
        <div class="readiness-leg">
          <span class="readiness-n">${r.mocks_marked ?? 0}</span>
          <span class="readiness-label">mock${r.mocks_marked === 1 ? "" : "s"} sat</span>
          <span class="readiness-sub muted">${
            r.last_activity ? `last worked ${formatDateTime(r.last_activity)}` : "nothing yet"}</span>
        </div>
      </div>
      ${coverage < 40 ? `
        <p class="field-hint">
          Most of the syllabus has never been marked, so the percentage above describes the
          corner of it you have practised, not the subject.
        </p>` : ""}
    </section>`;
}

/** Weekly percentage as an inline SVG polyline; not worth a chart library. */
function sparkline(series) {
  const W = 640;
  const H = 120;
  const pad = 8;
  const points = series.map((row, i) => {
    const x = series.length === 1 ? W / 2 : pad + (i * (W - pad * 2)) / (series.length - 1);
    const y = H - pad - (Number(row.pct ?? 0) / 100) * (H - pad * 2);
    return { x, y, row };
  });
  const path = points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const area = `${path} L${points[points.length - 1].x.toFixed(1)} ${H - pad} L${points[0].x.toFixed(1)} ${H - pad} Z`;

  const first = Number(series[0].pct ?? 0);
  const last = Number(series[series.length - 1].pct ?? 0);
  const delta = Math.round(last - first);

  return `
    <div class="spark">
      <svg viewBox="0 0 ${W} ${H}" class="spark-svg" role="img"
           aria-label="Weekly percentage, from ${first}% to ${last}%">
        <line x1="${pad}" x2="${W - pad}" y1="${H - pad - 0.5 * (H - pad * 2)}" y2="${H - pad - 0.5 * (H - pad * 2)}" class="spark-mid"></line>
        <path d="${area}" class="spark-area"></path>
        <path d="${path}" class="spark-line"></path>
        ${points.map((p) => `
          <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" class="spark-dot">
            <title>${esc(p.row.week_start)}: ${p.row.pct}% over ${p.row.attempts} question${p.row.attempts === 1 ? "" : "s"}</title>
          </circle>`).join("")}
      </svg>
      <p class="spark-caption">
        <strong class="${delta >= 0 ? "good" : "poor"}">${delta >= 0 ? "+" : ""}${delta} points</strong>
        since ${esc(series[0].week_start)} · now ${last}%
      </p>
    </div>`;
}

async function showAttempt(id) {
  openModal({
    title: "Marked answer",
    width: "wide",
    body: '<div class="loading"><span class="spinner"></span>Loading…</div>',
    async onMount(dialog) {
      const target = dialog.querySelector(".modal-body");
      try {
        const a = await getAttempt(id);
        if (!a) throw new Error("That attempt no longer exists.");
        const pct = a.total ? Math.round((a.awarded / a.total) * 100) : 0;
        dialog.querySelector("#modalTitle").textContent = a.question_ref ?? "Marked answer";

        target.innerHTML = `
          <div class="source-doc">
            <div class="score ${pct >= 80 ? "good" : pct >= 50 ? "mid" : "poor"} inline">
              <span class="score-value">${a.awarded}<span class="score-of">/${a.total}</span></span>
            </div>
            <h4>Question</h4>
            <pre class="verbatim">${esc(a.question_text ?? "")}</pre>
            <h4>Your answer</h4>
            <pre class="verbatim your">${esc(a.answer_text)}</pre>
            ${a.breakdown?.length ? `
              <h4>Marking points</h4>
              <ul class="breakdown compact">
                ${a.breakdown.map((b) => `
                  <li class="${b.earned ? "earned" : "lost"}">
                    <span class="tick" aria-hidden="true">${b.earned ? "✓" : "✗"}</span>
                    <div><p class="point">${esc(b.point)}</p><p class="why">${esc(b.why)}</p></div>
                  </li>`).join("")}
              </ul>` : ""}
            ${a.model_answer ? `<h4>Full-mark answer</h4><blockquote class="model-answer">${esc(a.model_answer)}</blockquote>` : ""}
          </div>`;
      } catch (e) {
        target.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
      }
    },
  });
}

/** Forget the subject filter. Called on sign-in and sign-out. */
export function invalidate() {
  subject = null;
}
