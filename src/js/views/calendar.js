/**
 * Calendar: the month, shaded by how much work each day carries.
 *
 * The planner answers "what do I owe?". This answers "when does it all land?",
 * which is the question that actually causes the panic. Three assessments in
 * one week is invisible on a board grouped by subject and obvious the moment
 * the month is drawn.
 *
 * Load is measured in minutes, not task count: four ten-minute exercises are
 * not the same day as one three-hour assessment. Tasks with no estimate fall
 * back to a default by type, because a day that looks empty because nobody
 * typed a number is worse than a day that is roughly right.
 */

import { esc, on } from "../ui/dom.js";
import { toast, skeleton, openModal } from "../ui/feedback.js";
import { store, subjectName } from "../store.js";
import { loadTasks, loadTuition, setTaskDone } from "../api/data.js";
import {
  iso, today, parseISO, monthGrid, weekOf, formatTime, minutesToHuman, daysUntil,
  examStart,
} from "../lib/dates.js";
import { WEEKDAYS } from "../config.js";
import { openTaskForm } from "./planner.js";
import { navigate } from "../router.js";

/** Minutes assumed when a task carries no estimate. */
const DEFAULT_MINUTES = { homework: 30, revision: 30, assessment: 90 };

/** Minutes at which a day is considered full. Sets the top of the heat scale. */
const FULL_DAY = 180;

let root = null;
let cursor = new Date();
let loaded = false;

export async function render(container) {
  root = container;
  container.innerHTML = shell();
  wire();

  if (!loaded) {
    root.querySelector("#calBody").innerHTML = skeleton(4);
    try {
      await Promise.all([loadTasks(), loadTuition()]);
      loaded = true;
    } catch (e) {
      toast(e.message, "error");
    }
  }
  paint();
}

function shell() {
  return `
    <header class="view-head">
      <div>
        <h1>Calendar</h1>
        <p class="view-sub" id="calSub">Every deadline, and how heavy each day is.</p>
      </div>
      <div class="view-actions">
        <div class="segmented" id="calNav" role="group" aria-label="Month">
          <button type="button" data-move="-1" aria-label="Previous month">‹</button>
          <button type="button" data-move="0">Today</button>
          <button type="button" data-move="1" aria-label="Next month">›</button>
        </div>
        <button class="btn-primary" id="calAdd">Add task</button>
      </div>
    </header>

    <div id="calCountdown"></div>
    <div id="calBody"></div>
    <div id="calWeek"></div>`;
}

function wire() {
  on(root, "click", "#calNav button", (_, btn) => {
    const move = Number(btn.dataset.move);
    cursor = move === 0 ? new Date() : new Date(cursor.getFullYear(), cursor.getMonth() + move, 1);
    paint();
  });

  root.querySelector("#calAdd").addEventListener("click", () => openTaskForm(null, null, { onSaved: refresh }));

  on(root, "click", "[data-day]", (_, cell) => {
    // A day with work opens that day; an empty one offers to fill it.
    const day = cell.dataset.day;
    const has = store.tasks.some((t) => t.due === day && !t.done);
    if (has) showDay(day);
    else openTaskForm(null, null, { due: day, onSaved: refresh });
  });

  on(root, "change", "input[data-toggle]", async (_, input) => {
    const id = input.dataset.toggle;
    const task = store.tasks.find((t) => t.id === id);
    if (!task) return;
    const next = input.checked;
    task.done = next;
    paint();
    try {
      await setTaskDone(id, next);
    } catch (e) {
      task.done = !next;
      paint();
      toast(e.message, "error");
    }
  });

  on(root, "click", "[data-goto]", (_, b) => navigate(b.dataset.goto));
}

function refresh() {
  paint();
}

/* ---------------------------------------------------------------- painting -- */

function paint() {
  paintCountdown();
  paintMonth();
  paintWeek();
}

/** Minutes of work due on one ISO day. */
function loadFor(day) {
  return store.tasks
    .filter((t) => !t.done && t.due === day)
    .reduce((n, t) => n + (t.estimate_min || DEFAULT_MINUTES[t.type] || 30), 0);
}

function heatClass(minutes) {
  if (!minutes) return "";
  const share = minutes / FULL_DAY;
  if (share >= 1) return "heat-4";
  if (share >= 0.66) return "heat-3";
  if (share >= 0.33) return "heat-2";
  return "heat-1";
}

/**
 * The exam series, counted down.
 *
 * `profiles.exam_session` is free text like "Jun 2027", which is exactly how a
 * student says it. Cambridge sits May/June from early May, Oct/Nov from early
 * October and Feb/March from late February, so the first of those months is a
 * close enough anchor for a number whose job is to create urgency, not to
 * schedule a flight.
 */
function paintCountdown() {
  const slot = root.querySelector("#calCountdown");
  const session = store.profile?.exam_session;
  if (!session) {
    slot.innerHTML = `
      <p class="cal-hint muted">
        Set which exam series you are sitting in
        <button class="link-btn" data-goto="settings">Settings</button>
        and this counts down to it.
      </p>`;
    return;
  }

  const start = examStart(session);
  if (!start) {
    slot.innerHTML = "";
    return;
  }
  const days = daysUntil(iso(start));
  slot.innerHTML = days >= 0
    ? `<div class="countdown">
         <span class="countdown-n">${days}</span>
         <span class="countdown-label">day${days === 1 ? "" : "s"} until ${esc(session)}</span>
         <span class="countdown-sub muted">about ${Math.max(0, Math.round(days / 7))} weeks</span>
       </div>`
    : `<div class="countdown past"><span class="countdown-label">${esc(session)} has started or passed.</span></div>`;
}

function paintMonth() {
  const body = root.querySelector("#calBody");
  const weeks = monthGrid(cursor);
  const now = today();
  const month = cursor.getMonth();

  const monthTotal = weeks.flat()
    .filter((d) => d.getMonth() === month)
    .reduce((n, d) => n + loadFor(iso(d)), 0);

  root.querySelector("#calSub").textContent = monthTotal
    ? `${minutesToHuman(monthTotal)} of work due this month`
    : "Nothing due this month.";

  body.innerHTML = `
    <div class="cal-title">
      <h2>${cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2>
      <span class="cal-legend">
        Lighter days are lighter
        <span class="heat-key heat-1"></span><span class="heat-key heat-2"></span>
        <span class="heat-key heat-3"></span><span class="heat-key heat-4"></span>
      </span>
    </div>
    <div class="cal-grid" role="group" aria-label="Month">
      ${WEEKDAYS.slice(1).concat(WEEKDAYS[0]).map((d) => `<div class="cal-dow">${d}</div>`).join("")}
      ${weeks.flat().map((date) => {
        const day = iso(date);
        const mins = loadFor(day);
        const items = store.tasks.filter((t) => t.due === day && !t.done);
        const assessment = items.some((t) => t.type === "assessment");
        return `
          <button class="cal-day ${heatClass(mins)}${date.getMonth() !== month ? " outside" : ""}${
            day === now ? " is-today" : ""}${assessment ? " has-assessment" : ""}"
            data-day="${day}"
            aria-label="${date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}${
              mins ? `, ${minutesToHuman(mins)} of work` : ", nothing due"}">
            <span class="cal-date">${date.getDate()}</span>
            ${items.length ? `<span class="cal-load">${minutesToHuman(mins)}</span>` : ""}
            ${items.slice(0, 3).map((t) => `
              <span class="cal-chip ${esc(t.type)}">${esc(subjectName(t.subject))}</span>`).join("")}
            ${items.length > 3 ? `<span class="cal-more">+${items.length - 3}</span>` : ""}
          </button>`;
      }).join("")}
    </div>`;
}

/** This week in detail, including the recurring tuition timetable. */
function paintWeek() {
  const slot = root.querySelector("#calWeek");
  const days = weekOf(new Date());
  const now = today();

  slot.innerHTML = `
    <h2 class="section-title">This week</h2>
    <div class="week">
      ${days.map((date) => {
        const day = iso(date);
        const items = store.tasks.filter((t) => t.due === day).sort((a, b) => Number(a.done) - Number(b.done));
        const sessions = store.tuition.filter((s) => s.weekday === date.getDay());
        return `
          <div class="week-day${day === now ? " is-today" : ""}">
            <header>
              <span class="week-dow">${WEEKDAYS[date.getDay()]}</span>
              <span class="week-date">${date.getDate()}</span>
            </header>
            ${sessions.map((s) => `
              <span class="tuition-chip" title="${esc(s.tutor ?? "")}">
                ${formatTime(s.start_time)} ${esc(subjectName(s.subject))}
              </span>`).join("")}
            ${items.length ? `
              <ul class="task-list compact">
                ${items.map((t) => `
                  <li class="task${t.done ? " done" : ""}">
                    <input type="checkbox" data-toggle="${t.id}"${t.done ? " checked" : ""}
                           aria-label="Mark ${esc(t.text)} done">
                    <div class="task-main">
                      <span class="task-text">${esc(t.text)}</span>
                      <span class="task-meta">${esc(subjectName(t.subject))}${
                        t.due_time ? ` · ${formatTime(t.due_time)}` : ""}</span>
                    </div>
                  </li>`).join("")}
              </ul>`
              : sessions.length ? "" : '<p class="week-clear">·</p>'}
          </div>`;
      }).join("")}
    </div>`;
}

/* -------------------------------------------------------------- one day -- */

function showDay(day) {
  const date = parseISO(day);
  const items = store.tasks.filter((t) => t.due === day);
  const mins = loadFor(day);

  openModal({
    title: date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }),
    body: `
        <p class="muted">${mins ? `${minutesToHuman(mins)} of work still to do.` : "Nothing outstanding."}</p>
        <ul class="task-list">
          ${items.map((t) => `
            <li class="task${t.done ? " done" : ""}">
              <input type="checkbox" data-toggle="${t.id}"${t.done ? " checked" : ""}
                     aria-label="Mark ${esc(t.text)} done">
              <div class="task-main">
                <span class="task-text">${esc(t.text)}</span>
                <span class="task-meta">${esc(subjectName(t.subject))} · ${esc(t.type)}${
                  t.estimate_min ? ` · ${minutesToHuman(t.estimate_min)}` : ""}</span>
              </div>
            </li>`).join("")}
        </ul>`,
    actions: `<button class="btn-primary" data-add-day>Add something for this day</button>`,
    onMount(dialog) {
      dialog.querySelector("[data-add-day]").addEventListener("click", () => {
        openTaskForm(null, null, { due: day, onSaved: refresh });
      });

      // The modal lives in the overlay, outside this view's root, so the
      // delegated handler in wire() cannot reach these. Wire them here.
      dialog.querySelectorAll("input[data-toggle]").forEach((input) => {
        input.addEventListener("change", async () => {
          const task = store.tasks.find((t) => t.id === input.dataset.toggle);
          if (!task) return;
          const next = input.checked;
          task.done = next;
          input.closest(".task")?.classList.toggle("done", next);
          paint();
          try {
            await setTaskDone(task.id, next);
          } catch (e) {
            task.done = !next;
            input.checked = !next;
            input.closest(".task")?.classList.toggle("done", !next);
            paint();
            toast(e.message, "error");
          }
        });
      });
    },
  });
}

/** Called after sign-in so the calendar reloads for the new account. */
export function invalidate() {
  loaded = false;
  cursor = new Date();
}
