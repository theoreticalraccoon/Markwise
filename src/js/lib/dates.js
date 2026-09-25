/** Date helpers. All dates are stored as plain ISO days, in local time. */

export function iso(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export function today() {
  return iso(new Date());
}

export function parseISO(value) {
  if (!value) return null;
  const [y, m, d] = String(value).split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

export function daysUntil(value) {
  const target = parseISO(value);
  if (!target) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((target - now) / 86400000);
}

/** { text, cls } for a due-date pill, or null when there is no due date. */
export function dueLabel(value) {
  const diff = daysUntil(value);
  if (diff === null) return null;
  if (diff < 0) return { text: `${-diff} day${diff === -1 ? "" : "s"} overdue`, cls: "overdue" };
  if (diff === 0) return { text: "Today", cls: "today" };
  if (diff === 1) return { text: "Tomorrow", cls: "soon" };
  if (diff < 7) return { text: parseISO(value).toLocaleDateString(undefined, { weekday: "short" }), cls: "soon" };
  if (diff < 30) return { text: `${diff} days`, cls: "" };
  return { text: parseISO(value).toLocaleDateString(undefined, { day: "numeric", month: "short" }), cls: "" };
}

export function formatDateTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Monday-first week containing `date`. */
export function weekOf(date) {
  const d = new Date(date);
  const offset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - offset);
  d.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => addDays(d, i));
}

/** Weeks covering the whole month grid containing `date`, Monday-first. */
export function monthGrid(date) {
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const start = weekOf(first)[0];
  const weeks = [];
  let cursor = start;
  for (let w = 0; w < 6; w++) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(cursor, i)));
    cursor = addDays(cursor, 7);
    if (cursor.getMonth() !== date.getMonth() && w >= 3 && cursor > new Date(date.getFullYear(), date.getMonth() + 1, 0)) {
      break;
    }
  }
  return weeks;
}

export function formatTime(value) {
  if (!value) return "";
  const [h, m] = String(value).split(":").map(Number);
  const d = new Date();
  d.setHours(h, m ?? 0, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function minutesToHuman(mins) {
  if (!mins) return "";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * When an exam series starts, from free text like "Jun 2027" or "Oct/Nov 2026".
 * Edexcel sits January, May/June and October/November, so "June" anchors to
 * early May. Only the first month of a range counts. Returns null if unreadable.
 */
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function examStart(session) {
  const text = String(session ?? "");
  const year = text.match(/\b(20\d\d)\b/)?.[1];
  const month = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/i)?.[1];
  if (!year || !month) return null;

  const index = MONTHS.indexOf(month.toLowerCase());
  // June is the tail of the summer series and November of the autumn one.
  const anchor = index === 5 ? 4 : index === 10 ? 9 : index;
  return new Date(Number(year), anchor, 1);
}
