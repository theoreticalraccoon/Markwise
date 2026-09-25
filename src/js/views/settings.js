// Settings: subjects, exam series, tuition timetable, papers, appearance,
// AI allowance and account. The allowance is visible up front so students can
// pace a shared free-tier budget.

import { esc, on, debounce } from "../ui/dom.js";
import { toast, confirmModal, openModal, closeModal, spinner } from "../ui/feedback.js";
import { store, coverageFor, subjectName, mySubjectRows } from "../store.js";
import {
  saveProfile, loadUsage, loadTuition, createTuition, deleteTuition,
} from "../api/data.js";
import { sb } from "../api/client.js";
import { applyTheme, currentTheme } from "../theme.js";
import { invalidate as invalidatePlanner } from "./planner.js";
import { invalidate as invalidateCalendar } from "./calendar.js";
import { formatTime } from "../lib/dates.js";
import { WEEKDAYS, WEEKDAYS_LONG } from "../config.js";
import { navigate } from "../router.js";

let root = null;

export async function render(container) {
  root = container;
  container.innerHTML = `
    <header class="view-head"><div><h1>Settings</h1></div></header>

    <section class="card plain">
      <header><h2>Your subjects</h2><span class="muted" id="subjCount"></span></header>
      <input type="search" id="subjSearch" placeholder="Search subjects…" autocomplete="off">
      <div class="subj-grid" id="subjGrid"></div>
      <div class="card-actions">
        <button class="btn-primary" id="saveSubjects">Save subjects</button>
      </div>
    </section>

    <section class="card plain">
      <header><h2>Your exam series</h2></header>
      <p class="field-hint">
        Which series you are sitting. The calendar counts down to it.
      </p>
      <div class="field-row">
        <label class="field">
          <span>Series</span>
          <input type="text" id="examSession" placeholder="e.g. May/Jun 2027 or Jan 2027" autocomplete="off"
                 value="${esc(store.profile?.exam_session ?? "")}">
        </label>
        <label class="field">
          <span>Name <span class="muted">(optional)</span></span>
          <input type="text" id="displayName" placeholder="What should Markwise call you?" autocomplete="name"
                 value="${esc(store.profile?.display_name ?? "")}">
        </label>
      </div>
      <div class="card-actions">
        <button class="btn-primary" id="saveProfileBits">Save</button>
      </div>
    </section>

    <section class="card plain">
      <header>
        <h2>Your papers</h2>
        <button class="btn-ghost small" data-nav="papers">Add past papers</button>
      </header>
      <p class="field-hint">
        Markwise answers, marks and quizzes only from documents it has actually read.
        This is what it has.
      </p>
      <div id="setCoverage"></div>
    </section>

    <section class="card plain">
      <header>
        <h2>Tuition timetable</h2>
        <button class="btn-ghost small" id="addTuition">Add a session</button>
      </header>
      <p class="field-hint">Recurring weekly sessions. They appear on the calendar's week view.</p>
      <div id="tuitionPanel">${spinner("Loading…")}</div>
    </section>

    <section class="card plain">
      <header><h2>Appearance</h2></header>
      <div class="chip-row" id="themeRow">
        ${["system", "light", "dark"].map((t) => `
          <input type="radio" name="theme" id="theme-${t}" value="${t}"${currentTheme() === t ? " checked" : ""}>
          <label class="chip-toggle" for="theme-${t}">${t[0].toUpperCase()}${t.slice(1)}</label>`).join("")}
      </div>
    </section>

    <section class="card plain">
      <header><h2>What you can do today</h2></header>
      <div id="usagePanel">${spinner("Checking…")}</div>
      <p class="field-hint">
        Markwise runs on a free AI allowance that resets every night, so that one heavy
        session doesn't use up everyone else's. Recall practice costs nothing and is
        always available.
      </p>
    </section>

    <section class="card plain">
      <header><h2>Account</h2></header>
      <p class="muted">${esc(store.user?.email ?? "")}</p>
      <div class="card-actions">
        <button class="btn-ghost" id="changePassword">Change password</button>
        <button class="btn-ghost" id="signOutBtn">Sign out</button>
      </div>
    </section>`;

  wire();
  paintSubjects();
  paintCoverage();
  await Promise.all([paintUsage(), paintTuition()]);
}

function wire() {
  on(root, "click", "[data-goto]", (_, btn) => navigate(btn.dataset.goto));

  root.querySelector("#themeRow").addEventListener("change", (e) => {
    const radio = e.target.closest('input[name="theme"]');
    if (radio) applyTheme(radio.value, { persist: true });
  });

  root.querySelector("#subjSearch").addEventListener(
    "input",
    debounce((e) => {
      const q = e.target.value.trim().toLowerCase();
      root.querySelectorAll("#subjGrid .subj").forEach((el) => {
        el.hidden = q && !el.dataset.name.includes(q);
      });
    }, 150),
  );

  on(root, "change", "#subjGrid input", (_, cb) => {
    cb.closest(".subj")?.classList.toggle("on", cb.checked);
    updateCount();
  });

  root.querySelector("#saveSubjects").addEventListener("click", async (e) => {
    const chosen = [...root.querySelectorAll("#subjGrid input:checked")].map((i) => i.value);
    if (!chosen.length) {
      toast("Pick at least one subject.", "error");
      return;
    }
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      await saveProfile({ subjects: chosen });
      invalidatePlanner();
      invalidateCalendar();
      paintCoverage();
      toast("Subjects saved.");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Save subjects";
    }
  });

  root.querySelector("#saveProfileBits").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      await saveProfile({
        exam_session: root.querySelector("#examSession").value.trim() || null,
        display_name: root.querySelector("#displayName").value.trim() || null,
      });
      invalidateCalendar();
      toast("Saved.");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Save";
    }
  });

  root.querySelector("#addTuition").addEventListener("click", openTuitionForm);

  on(root, "click", "[data-del-tuition]", async (_, btn) => {
    const ok = await confirmModal({
      title: "Remove this session",
      message: "It stops appearing on your calendar.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteTuition(btn.dataset.delTuition);
      invalidateCalendar();
      await paintTuition();
    } catch (e) {
      toast(e.message, "error");
    }
  });

  root.querySelector("#changePassword").addEventListener("click", openPasswordForm);

  root.querySelector("#signOutBtn").addEventListener("click", async () => {
    const ok = await confirmModal({
      title: "Sign out",
      message: "You'll need to sign in again on this device.",
      confirmLabel: "Sign out",
    });
    if (ok) await sb.auth.signOut();
  });
}

function paintSubjects() {
  const mine = new Set(store.mySubjects);
  root.querySelector("#subjGrid").innerHTML = store.subjects
    .map((s) => {
      const cov = coverageFor(s.code);
      return `
        <label class="subj${mine.has(s.code) ? " on" : ""}" data-name="${esc(s.name.toLowerCase())}">
          <input type="checkbox" value="${esc(s.code)}"${mine.has(s.code) ? " checked" : ""}>
          <span>
            ${esc(s.name)}
            ${cov ? '<span class="subj-corpus">papers added</span>' : ""}
          </span>
        </label>`;
    })
    .join("");
  updateCount();
}

function updateCount() {
  const n = root.querySelectorAll("#subjGrid input:checked").length;
  root.querySelector("#subjCount").textContent = `${n} selected`;
}

function paintCoverage() {
  const slot = root?.querySelector("#setCoverage");
  if (!slot) return;
  const rows = mySubjectRows();
  if (!rows.length) {
    slot.innerHTML = '<p class="muted">Pick your subjects above first.</p>';
    return;
  }
  slot.innerHTML = `
    <div class="coverage">
      ${rows.map((s) => {
        const cov = coverageFor(s.code);
        return `
          <div class="coverage-row">
            <span class="coverage-name">${esc(s.name)}</span>
            <span class="coverage-count">${
              cov
                ? `${cov.questions.toLocaleString()} questions · ${cov.papers} paper${cov.papers === 1 ? "" : "s"}`
                : "nothing yet"}</span>
            <span class="coverage-years">${cov?.from_year ? `${cov.from_year}–${cov.to_year}` : ""}</span>
          </div>`;
      }).join("")}
    </div>`;
}

/* --------------------------------------------------------------- tuition -- */

async function paintTuition() {
  const panel = root?.querySelector("#tuitionPanel");
  if (!panel) return;
  try {
    await loadTuition();
  } catch (e) {
    panel.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
    return;
  }
  const el = root?.querySelector("#tuitionPanel");
  if (!el) return;

  if (!store.tuition.length) {
    el.innerHTML = '<p class="muted">No sessions yet.</p>';
    return;
  }
  el.innerHTML = `
    <ul class="tuition-list">
      ${store.tuition.map((s) => `
        <li>
          <span class="tuition-day">${esc(WEEKDAYS[s.weekday] ?? "")}</span>
          <span class="tuition-time">${esc(formatTime(s.start_time))}${
            s.end_time ? ` – ${esc(formatTime(s.end_time))}` : ""}</span>
          <span class="tuition-subject">
            ${esc(subjectName(s.subject))}
            ${s.tutor ? `<span class="muted"> · ${esc(s.tutor)}</span>` : ""}
            ${s.location ? `<span class="muted"> · ${esc(s.location)}</span>` : ""}
          </span>
          <button class="icon-btn" data-del-tuition="${esc(s.id)}" aria-label="Remove this session">&times;</button>
        </li>`).join("")}
    </ul>`;
}

function openTuitionForm() {
  const subjects = mySubjectRows().length ? mySubjectRows() : store.subjects;
  openModal({
    title: "Add a tuition session",
    body: `
      <form id="tuitionForm">
        <label class="field">
          <span>Subject</span>
          <select id="tuSubject" data-autofocus>
            ${subjects.map((s) => `<option value="${esc(s.code)}">${esc(s.name)}</option>`).join("")}
          </select>
        </label>
        <label class="field">
          <span>Day</span>
          <select id="tuDay">
            ${WEEKDAYS_LONG.map((d, i) => `<option value="${i}"${i === 6 ? " selected" : ""}>${d}</option>`).join("")}
          </select>
        </label>
        <div class="field-row">
          <label class="field">
            <span>Starts</span>
            <input type="time" id="tuStart" value="16:00">
          </label>
          <label class="field">
            <span>Ends <span class="muted">(optional)</span></span>
            <input type="time" id="tuEnd">
          </label>
        </div>
        <div class="field-row">
          <label class="field">
            <span>Tutor <span class="muted">(optional)</span></span>
            <input type="text" id="tuTutor" autocomplete="off">
          </label>
          <label class="field">
            <span>Where <span class="muted">(optional)</span></span>
            <input type="text" id="tuWhere" autocomplete="off">
          </label>
        </div>
      </form>`,
    actions: `
      <button class="btn-ghost" data-modal-close>Cancel</button>
      <button class="btn-primary" id="tuSave">Add session</button>`,
    onMount(dialog) {
      const save = async () => {
        const btn = dialog.querySelector("#tuSave");
        const start = dialog.querySelector("#tuStart").value;
        if (!start) {
          toast("Give the session a start time.", "error");
          return;
        }
        btn.disabled = true;
        btn.textContent = "Saving…";
        try {
          await createTuition({
            subject: dialog.querySelector("#tuSubject").value,
            weekday: Number(dialog.querySelector("#tuDay").value),
            start_time: start,
            end_time: dialog.querySelector("#tuEnd").value || null,
            tutor: dialog.querySelector("#tuTutor").value.trim() || null,
            location: dialog.querySelector("#tuWhere").value.trim() || null,
          });
          closeModal();
          invalidateCalendar();
          await paintTuition();
          toast("Session added.");
        } catch (e) {
          btn.disabled = false;
          btn.textContent = "Add session";
          toast(e.message, "error");
        }
      };
      dialog.querySelector("#tuSave").addEventListener("click", save);
      dialog.querySelector("#tuitionForm").addEventListener("submit", (e) => {
        e.preventDefault();
        save();
      });
    },
  });
}

/* ----------------------------------------------------------------- usage -- */

async function paintUsage() {
  const panel = root.querySelector("#usagePanel");
  const rows = await loadUsage();
  if (!rows.length) {
    panel.innerHTML = '<p class="muted">No limits are set on this deployment.</p>';
    return;
  }
  const names = {
    ask: "Questions asked",
    mark: "Answers marked",
    mock: "Mock papers made",
    markmock: "Mocks marked",
    markpaper: "Papers marked",
    ingest: "Papers added",
    similar: "Similar questions",
  };
  panel.innerHTML = `
    <div class="usage-grid">
      ${rows.map((r) => {
        const left = Math.max(0, r.per_day - r.used);
        const pct = r.per_day ? Math.round((r.used / r.per_day) * 100) : 0;
        return `
          <div class="usage-row">
            <span class="usage-label">${esc(names[r.route] ?? r.route)}</span>
            <span class="bar"><span style="width:${Math.min(100, pct)}%" class="${pct >= 90 ? "poor" : pct >= 60 ? "mid" : "good"}"></span></span>
            <span class="usage-count">${left} left</span>
          </div>`;
      }).join("")}
    </div>`;
}

function openPasswordForm() {
  openModal({
    title: "Change password",
    body: `
      <label class="field">
        <span>New password</span>
        <input type="password" id="newPw" autocomplete="new-password" data-autofocus placeholder="At least 6 characters">
      </label>
      <p class="auth-msg" id="pwMsg" role="status"></p>`,
    actions: `
      <button class="btn-ghost" data-modal-close>Cancel</button>
      <button class="btn-primary" id="pwSave">Update</button>`,
    onMount(dialog) {
      dialog.querySelector("#pwSave").addEventListener("click", async (e) => {
        const value = dialog.querySelector("#newPw").value;
        const msg = dialog.querySelector("#pwMsg");
        if (value.length < 6) {
          msg.textContent = "Use at least 6 characters.";
          msg.className = "auth-msg error";
          return;
        }
        e.currentTarget.disabled = true;
        const { error } = await sb.auth.updateUser({ password: value });
        if (error) {
          msg.textContent = error.message;
          msg.className = "auth-msg error";
          e.currentTarget.disabled = false;
          return;
        }
        closeModal();
        toast("Password updated.");
      });
    },
  });
}
