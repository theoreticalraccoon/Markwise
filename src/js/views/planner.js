/**
 * Planner. The original homework board, unchanged in shape.
 *
 * One card per subject, School / Tuition / My own tabs, blue pen for homework,
 * red for assessments and green for revision, with a coloured spine so a glance
 * at the board tells you where the pressure is. Tuition has no assessments, so
 * that tab shows homework only and the add form hides the type choice.
 *
 * The form carries what the schema always allowed and the old form never asked
 * for: a priority, a rough estimate and a topic. The estimate is what makes the
 * calendar's workload heatmap mean anything, so it is offered as one-tap chips
 * rather than a number field nobody fills in.
 */

import { esc, on } from "../ui/dom.js";
import { toast, openModal, closeModal, confirmModal, emptyState, skeleton } from "../ui/feedback.js";
import { store, savePrefs, subjectName, mySubjectRows, courseFor } from "../store.js";
import {
  loadTasks, createTask, updateTask, setTaskDone, deleteTask, clearCompleted, syncPrefs,
  dueRevisions,
} from "../api/data.js";
import { dueLabel, iso, addDays, formatTime, minutesToHuman } from "../lib/dates.js";
import { SOURCES, TASK_TYPES, PRIORITIES, ESTIMATES } from "../config.js";
import { navigate } from "../router.js";

let root = null;
let loaded = false;
let revisions = [];

export async function render(container) {
  root = container;
  container.innerHTML = shell();
  wire();

  if (!loaded) {
    body().innerHTML = skeleton(3);
    try {
      await loadTasks();
      loaded = true;
    } catch (e) {
      toast(e.message, "error");
    }
  }
  paint();
  void paintRevisions();
}

const body = () => root.querySelector("#plannerBody");

function shell() {
  return `
    <header class="view-head">
      <div>
        <h1>Planner</h1>
        <p class="view-sub" id="plannerSummary">&nbsp;</p>
      </div>
      <button class="btn-primary" id="addTask">Add task</button>
    </header>

    <div id="revisionDue"></div>

    <div class="controls">
      <div class="tabs" id="sourceTabs" role="group" aria-label="Where the work came from">
        ${SOURCES.map((s) => `<button type="button" data-source="${s.id}">${s.label}</button>`).join("")}
      </div>
      <label class="toggle">
        <input type="checkbox" id="hideEmpty"> Hide subjects with nothing due
      </label>
      <button class="btn-ghost" id="clearDone" hidden>Clear completed</button>
    </div>

    <div id="plannerBody"></div>`;
}

/* ------------------------------------------------------------------ wiring -- */

function wire() {
  root.querySelector("#addTask").addEventListener("click", () => openTaskForm());

  on(root, "click", "#sourceTabs button", (_, btn) => {
    savePrefs({ source: btn.dataset.source });
    syncPrefs();
    paint();
  });

  root.querySelector("#hideEmpty").addEventListener("change", (e) => {
    savePrefs({ hideEmpty: e.target.checked });
    syncPrefs();
    paint();
  });

  root.querySelector("#clearDone").addEventListener("click", async () => {
    const ok = await confirmModal({
      title: "Clear completed tasks",
      message: "Ticked-off tasks in this tab will be deleted permanently.",
      confirmLabel: "Delete them",
      danger: true,
    });
    if (!ok) return;
    try {
      const n = await clearCompleted(store.prefs.source);
      toast(`${n} task${n === 1 ? "" : "s"} cleared.`);
      paint();
    } catch (e) {
      toast(e.message, "error");
    }
  });

  on(root, "change", "input[data-toggle]", async (_, input) => {
    const id = input.dataset.toggle;
    const task = store.tasks.find((t) => t.id === id);
    if (!task) return;
    const next = input.checked;
    task.done = next;              // optimistic; the row repaints immediately
    paint();
    try {
      await setTaskDone(id, next);
    } catch (e) {
      task.done = !next;
      paint();
      toast(e.message, "error");
    }
  });

  on(root, "click", "[data-edit]", (_, btn) => {
    const task = store.tasks.find((t) => t.id === btn.dataset.edit);
    if (task) openTaskForm(task);
  });

  on(root, "click", "[data-delete]", async (_, btn) => {
    const id = btn.dataset.delete;
    const task = store.tasks.find((t) => t.id === id);
    if (!task) return;
    const snapshot = { ...task };
    store.tasks = store.tasks.filter((t) => t.id !== id);
    paint();
    try {
      await deleteTask(id);
    } catch (e) {
      store.tasks.push(snapshot);
      paint();
      toast(e.message, "error");
    }
  });

  on(root, "click", "[data-add-for]", (_, btn) => openTaskForm(null, btn.dataset.addFor));
  on(root, "click", "[data-goto]", (_, btn) => navigate(btn.dataset.goto));

  on(root, "click", "[data-plan-revision]", async (_, btn) => {
    btn.disabled = true;
    try {
      await addRevisionTask({
        subject: btn.dataset.subject,
        topic: btn.dataset.planRevision,
        text: `Revise ${btn.dataset.planRevision}`,
      });
      paint();
      await paintRevisions();
    } catch (e) {
      btn.disabled = false;
      toast(e.message, "error");
    }
  });

  on(root, "click", "#planAllRevision", async (_, btn) => {
    btn.disabled = true;
    btn.textContent = "Adding…";
    let added = 0;
    for (const r of revisions) {
      try {
        await addRevisionTask({ subject: r.subject_code, topic: r.topic, text: `Revise ${r.topic}` }, false);
        added++;
      } catch {
        /* one failure must not stop the rest */
      }
    }
    toast(`${added} revision task${added === 1 ? "" : "s"} added.`);
    paint();
    await paintRevisions();
  });
}

/* ---------------------------------------------------------------- painting -- */

function paint() {
  const valid = SOURCES.map((s) => s.id);
  const source = valid.includes(store.prefs.source) ? store.prefs.source : "school";

  root.querySelectorAll("#sourceTabs button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.source === source))
  );
  root.querySelector("#hideEmpty").checked = !!store.prefs.hideEmpty;

  const inTab = store.tasks.filter((t) => t.source === source);
  const pending = inTab.filter((t) => !t.done);
  root.querySelector("#clearDone").hidden = !inTab.some((t) => t.done);
  root.querySelector("#plannerSummary").textContent = summarise(pending, source);

  if (!store.tasks.length && loaded) {
    body().innerHTML = emptyState({
      icon: "📓",
      title: "Nothing tracked yet",
      message: "Add your first piece of homework and the deadlines stay straight.",
      action: `<button class="btn-primary" id="emptyAdd">Add a task</button>`,
    });
    body().querySelector("#emptyAdd")?.addEventListener("click", () => openTaskForm());
    return;
  }

  // Chosen subjects always show; anything that already holds work shows too, so
  // dropping a subject in Settings never hides tasks you still have.
  const withWork = new Set(inTab.map((t) => t.subject));
  const subjects = mySubjectRows().slice();
  for (const code of withWork) {
    if (!subjects.some((s) => s.code === code)) subjects.push({ code, name: subjectName(code) });
  }

  const cards = subjects.map((s) => subjectCard(s, inTab, source)).filter(Boolean).join("");
  body().innerHTML = cards
    ? `<div class="board">${cards}</div>`
    : emptyState({ icon: "✓", title: "All clear", message: "Nothing pending in this tab." });
}

function summarise(pending, source) {
  if (!pending.length) return "Nothing pending. You are clear.";
  const minutes = pending.reduce((n, t) => n + (t.estimate_min || 0), 0);
  const tail = minutes ? ` · about ${minutesToHuman(minutes)} of it estimated` : "";
  const hw = pending.filter((t) => t.type === "homework").length;
  const rev = pending.filter((t) => t.type === "revision").length;
  const as = pending.length - hw - rev;
  if (source === "tuition") return `${hw} homework task${hw === 1 ? "" : "s"}${tail}`;
  const bits = [`${hw} homework`];
  if (as) bits.push(`${as} assessment${as === 1 ? "" : "s"}`);
  if (rev) bits.push(`${rev} revision`);
  return bits.join(" · ") + tail;
}

/**
 * Topics whose spaced-revision date has come round.
 *
 * The schedule is maintained by the database on every marked answer, so this
 * is a read, not a calculation. It sits above the board because a revision the
 * app worked out for you is worth more than one you remembered to set.
 */
async function paintRevisions() {
  const slot = root?.querySelector("#revisionDue");
  if (!slot) return;
  try {
    revisions = await dueRevisions(null, 6);
  } catch {
    revisions = [];
  }
  const el = root?.querySelector("#revisionDue");
  if (!el) return;

  // Anything already on the board as an open revision task is not "due" again.
  const planned = new Set(
    store.tasks.filter((t) => !t.done && t.type === "revision" && t.topic).map((t) => t.topic),
  );
  const show = revisions.filter((r) => !planned.has(r.topic));
  if (!show.length) {
    el.innerHTML = "";
    return;
  }

  el.innerHTML = `
    <section class="card plain revision-due">
      <header>
        <h2>Due for revision</h2>
        <button class="btn-ghost small" id="planAllRevision">Add all to the planner</button>
      </header>
      <p class="field-hint">
        Worked out from marks you actually lost, and spaced: a topic you keep getting wrong
        comes back sooner than one you have nailed.
      </p>
      <ul class="revision-list">
        ${show.map((r) => `
          <li>
            <span class="revision-topic">${esc(r.topic)}</span>
            <span class="revision-meta muted">${esc(subjectName(r.subject_code))} · ${Math.round(Number(r.pct ?? 0))}%${
              r.days_over > 0 ? ` · ${r.days_over} day${r.days_over === 1 ? "" : "s"} overdue` : " · due today"}</span>
            <button class="link-btn" data-plan-revision="${esc(r.topic)}" data-subject="${esc(r.subject_code)}">Plan it</button>
            <button class="link-btn" data-goto="recall?subject=${encodeURIComponent(r.subject_code)}">Practise now</button>
          </li>`).join("")}
      </ul>
    </section>`;
}

function subjectCard(subject, inTab, source) {
  const mine = inTab.filter((t) => t.subject === subject.code);
  // Tuition never sets assessments, so that tab shows homework only.
  const types = source === "tuition" ? ["homework"] : ["homework", "assessment", "revision"];
  const pending = mine.filter((t) => !t.done && types.includes(t.type));

  if (store.prefs.hideEmpty && pending.length === 0) return "";

  const hasHw = pending.some((t) => t.type === "homework");
  const hasAs = pending.some((t) => t.type === "assessment");
  const hasRev = pending.some((t) => t.type === "revision");
  const spine = [hasHw && "hw", hasAs && "as", hasRev && "rev"].filter(Boolean).join("-") || "none";

  const sections = types.map((type) => {
    const items = mine.filter((t) => t.type === type).sort(sortTasks);
    if (!items.length) return "";
    const label = { homework: "Homework", assessment: "Assessments", revision: "Revision" }[type];
    return `
      <div class="card-group ${type}">
        <p class="eyebrow ${type}">${label}</p>
        <ul class="task-list">${items.map(taskRow).join("")}</ul>
      </div>`;
  }).join("");

  return `
    <section class="card spine-${spine}">
      <header>
        <h2>${esc(subject.name)}</h2>
        <button class="add-here" data-add-for="${esc(subject.code)}">Add</button>
      </header>
      ${sections || '<p class="clear-msg">All clear</p>'}
    </section>`;
}

function sortTasks(a, b) {
  if (a.done !== b.done) return a.done ? 1 : -1;
  // High priority first among things that are not done.
  if (!a.done && (a.priority ?? 1) !== (b.priority ?? 1)) return (b.priority ?? 1) - (a.priority ?? 1);
  const ad = a.due ?? "9999-12-31";
  const bd = b.due ?? "9999-12-31";
  if (ad !== bd) return ad < bd ? -1 : 1;
  return (a.created ?? 0) - (b.created ?? 0);
}

function taskRow(task) {
  const due = dueLabel(task.due);
  const time = task.due_time ? formatTime(task.due_time) : "";
  const meta = [
    task.topic || null,
    task.estimate_min ? minutesToHuman(task.estimate_min) : null,
  ].filter(Boolean).join(" · ");

  return `
    <li class="task${task.done ? " done" : ""}${(task.priority ?? 1) === 2 ? " high" : ""}">
      <input type="checkbox" data-toggle="${task.id}"${task.done ? " checked" : ""}
             aria-label="Mark ${esc(task.text)} done">
      <div class="task-main">
        <span class="task-text">
          ${(task.priority ?? 1) === 2 ? '<span class="prio" title="High priority" aria-label="High priority">!</span>' : ""}
          ${esc(task.text)}
          ${task.origin === "ai" ? '<span class="tag ai">auto</span>' : ""}
        </span>
        ${task.notes ? `<span class="task-notes">${esc(task.notes)}</span>` : ""}
        ${meta ? `<span class="task-meta">${esc(meta)}</span>` : ""}
      </div>
      ${due ? `<span class="due ${due.cls}">${due.text}${time ? ` ${time}` : ""}</span>` : "<span></span>"}
      <span class="task-tools">
        <button class="icon-btn" data-edit="${task.id}" aria-label="Edit ${esc(task.text)}">✎</button>
        <button class="icon-btn" data-delete="${task.id}" aria-label="Delete ${esc(task.text)}">&times;</button>
      </span>
    </li>`;
}

/* ------------------------------------------------------------- task form -- */

/**
 * Add or edit a task.
 *
 * `options.due` preselects a date (the calendar opens the form on a day) and
 * `options.onSaved` lets a caller outside the planner repaint itself, since the
 * planner's own `paint()` only touches the planner's markup.
 */
export function openTaskForm(task = null, presetSubject = null, options = {}) {
  const editing = !!task;
  const list = mySubjectRows().length ? mySubjectRows() : store.subjects;
  const selected = task?.subject ?? presetSubject ?? store.prefs.lastSubject ?? list[0]?.code;
  const validSources = SOURCES.map((s) => s.id);
  const source = task?.source
    ?? (validSources.includes(store.prefs.source) ? store.prefs.source : "school");
  const priority = task?.priority ?? 1;
  const estimate = task?.estimate_min ?? null;

  openModal({
    title: editing ? "Edit task" : "Add a task",
    body: `
      <form id="taskForm">
        <label class="field">
          <span>Subject</span>
          <select id="tSubject">
            ${list.map((s) => `<option value="${esc(s.code)}"${s.code === selected ? " selected" : ""}>${esc(s.name)}</option>`).join("")}
          </select>
        </label>

        <div class="field">
          <span>From</span>
          <div class="chip-row">
            ${SOURCES.map((s) => `
              <input type="radio" name="tSource" id="src-${s.id}" value="${s.id}"${source === s.id ? " checked" : ""}>
              <label class="chip-toggle" for="src-${s.id}">${s.label}</label>`).join("")}
          </div>
        </div>

        <div class="field" id="typeField">
          <span>Type</span>
          <div class="chip-row">
            ${TASK_TYPES.map((t) => `
              <input type="radio" name="tType" id="type-${t.id}" value="${t.id}"${(task?.type ?? "homework") === t.id ? " checked" : ""}>
              <label class="chip-toggle ${t.id}" for="type-${t.id}">${t.label}</label>`).join("")}
          </div>
        </div>

        <label class="field">
          <span>Task</span>
          <input type="text" id="tText" data-autofocus autocomplete="off"
                 placeholder="e.g. Textbook pg 41, Q1–9" value="${esc(task?.text ?? "")}">
        </label>

        <label class="field">
          <span>Note <span class="muted">(optional)</span></span>
          <input type="text" id="tNotes" autocomplete="off"
                 placeholder="Anything you'll want to remember" value="${esc(task?.notes ?? "")}">
        </label>

        <div class="field-row">
          <label class="field">
            <span>Due date</span>
            <input type="date" id="tDue" value="${esc(task?.due ?? options.due ?? "")}">
          </label>
          <label class="field">
            <span>Time <span class="muted">(optional)</span></span>
            <input type="time" id="tTime" value="${esc((task?.due_time ?? "").slice(0, 5))}">
          </label>
        </div>

        <div class="chips" id="quickDates">
          <button type="button" class="chip" data-days="0">Today</button>
          <button type="button" class="chip" data-days="1">Tomorrow</button>
          <button type="button" class="chip" data-days="7">Next week</button>
          <button type="button" class="chip" data-days="">Clear</button>
        </div>

        <div class="field">
          <span>How long will it take? <span class="muted">(optional, but it drives the calendar)</span></span>
          <div class="chips" id="tEstimate">
            ${ESTIMATES.map((m) => `
              <button type="button" class="chip${estimate === m ? " on" : ""}" data-mins="${m}">${minutesToHuman(m)}</button>`).join("")}
            <button type="button" class="chip${estimate ? "" : " on"}" data-mins="">No idea</button>
          </div>
        </div>

        <div class="field">
          <span>Priority</span>
          <div class="chip-row">
            ${PRIORITIES.map((p) => `
              <input type="radio" name="tPriority" id="prio-${p.id}" value="${p.id}"${priority === p.id ? " checked" : ""}>
              <label class="chip-toggle" for="prio-${p.id}">${p.label}</label>`).join("")}
          </div>
        </div>

        <label class="field">
          <span>Topic <span class="muted">(optional)</span></span>
          <input type="text" id="tTopic" autocomplete="off" placeholder="e.g. Electromagnetism"
                 value="${esc(task?.topic ?? "")}">
        </label>
      </form>`,
    actions: `
      <button class="btn-ghost" data-modal-close>Cancel</button>
      <button class="btn-primary" id="taskSave">${editing ? "Save changes" : "Add task"}</button>`,
    onMount(dialog) {
      const q = (sel) => dialog.querySelector(sel);
      let estimateMin = estimate;

      // Tuition homework only: hide the choice rather than offer a
      // combination the tab would never display.
      const syncType = () => {
        const tuition = q("#src-tuition").checked;
        q("#typeField").hidden = tuition;
        if (tuition) q("#type-homework").checked = true;
      };
      dialog.querySelectorAll('input[name="tSource"]').forEach((r) => r.addEventListener("change", syncType));
      syncType();

      q("#quickDates").addEventListener("click", (e) => {
        const chip = e.target.closest(".chip");
        if (!chip) return;
        const days = chip.dataset.days;
        q("#tDue").value = days === "" ? "" : iso(addDays(new Date(), Number(days)));
      });

      q("#tEstimate").addEventListener("click", (e) => {
        const chip = e.target.closest(".chip");
        if (!chip) return;
        estimateMin = chip.dataset.mins ? Number(chip.dataset.mins) : null;
        q("#tEstimate").querySelectorAll(".chip").forEach((c) => c.classList.remove("on"));
        chip.classList.add("on");
      });

      const submit = async () => {
        const text = q("#tText").value.trim();
        if (!text) {
          q("#tText").focus();
          toast("Give the task a name.", "error");
          return;
        }
        const src = dialog.querySelector('input[name="tSource"]:checked')?.value ?? "school";
        const fields = {
          subject: q("#tSubject").value,
          source: src,
          type: src === "tuition"
            ? "homework"
            : (dialog.querySelector('input[name="tType"]:checked')?.value ?? "homework"),
          text,
          notes: q("#tNotes").value.trim() || null,
          due: q("#tDue").value || null,
          dueTime: q("#tTime").value || null,
          estimateMin,
          topic: q("#tTopic").value.trim() || null,
          priority: Number(dialog.querySelector('input[name="tPriority"]:checked')?.value ?? 1),
        };

        const save = q("#taskSave");
        save.disabled = true;
        save.textContent = "Saving…";
        try {
          if (editing) {
            await updateTask(task.id, {
              subject: fields.subject, source: fields.source, type: fields.type,
              text: fields.text, notes: fields.notes,
              due: fields.due, due_time: fields.dueTime,
              estimate_min: fields.estimateMin, topic: fields.topic, priority: fields.priority,
            });
          } else {
            await createTask(fields);
            savePrefs({ lastSubject: fields.subject });
          }
          closeModal();
          // The form is shared with the calendar, so `root` may belong to a
          // view the planner no longer owns. Only repaint what is really ours.
          if (root?.querySelector("#plannerBody")) paint();
          options.onSaved?.();
        } catch (e) {
          save.disabled = false;
          save.textContent = editing ? "Save changes" : "Add task";
          toast(e.message, "error");
        }
      };

      q("#taskSave").addEventListener("click", submit);
      q("#taskForm").addEventListener("submit", (e) => {
        e.preventDefault();
        submit();
      });
    },
  });
}

/**
 * Turn a weakness into a revision task.
 *
 * Used by Progress, by the assistant and by the spaced-revision list. Marked
 * `origin: "ai"` so the board can show that Markwise set it rather than the
 * student, and carrying the topic so the same topic is not queued twice.
 */
export async function addRevisionTask({ subject, topic, text, due }, announce = true) {
  await createTask({
    // Weak topics are recorded against the corpus subject. File the task under
    // a course the student actually has.
    subject: courseFor(subject),
    type: "revision",
    source: "self",
    text,
    notes: topic ? `Revision: ${topic}` : null,
    topic: topic ?? null,
    estimateMin: 30,
    origin: "ai",
    due: due ?? iso(addDays(new Date(), 2)),
  });
  if (announce) toast("Added to your planner.");
}

/** Called after sign-in so the board reloads for the new account. */
export function invalidate() {
  loaded = false;
  revisions = [];
}
