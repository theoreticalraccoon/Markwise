// App state: one observable object. Small enough app that a framework isn't worth a build step.

import { STORAGE } from "./config.js";

const listeners = new Map(); // event -> Set<fn>

export const store = {
  user: null,
  profile: null,          // { subjects, exam_session, board, display_name, prefs }
  subjects: [],           // catalogue rows: { code, name, board, level }
  mySubjects: [],         // codes the user takes
  tasks: [],
  tuition: [],
  coverage: [],           // corpus_coverage rows
  isAdmin: false,         // may add papers to the shared library
  usage: [],              // my_ai_usage rows
  prefs: {
    source: "school",
    hideEmpty: false,
    /** The last COURSE picked on a form (a planner subject). */
    lastSubject: null,
    /** The last CORPUS browsed in library or recall (see corpusCode). */
    lastCorpus: null,
    plannerView: "board",
  },
  ready: false,
};

/** What prefs are before anything has been loaded or saved. */
const DEFAULT_PREFS = {
  source: "school", hideEmpty: false, lastSubject: null, lastCorpus: null, plannerView: "board",
};

export function emit(event, payload) {
  for (const fn of listeners.get(event) ?? []) {
    try {
      fn(payload);
    } catch (e) {
      console.error(`listener for "${event}" failed`, e);
    }
  }
}

export function subscribe(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}

/* ----------------------------------------------------------------- prefs -- */

export function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE.prefs);
    if (raw) Object.assign(store.prefs, JSON.parse(raw));
  } catch {
    /* a blocked or full localStorage must not stop the app */
  }
}

export function savePrefs(patch = {}) {
  Object.assign(store.prefs, patch);
  try {
    localStorage.setItem(STORAGE.prefs, JSON.stringify(store.prefs));
  } catch {
    /* ignore */
  }
  emit("prefs", store.prefs);
}

/* -------------------------------------------------------------- lookups -- */

export function subjectName(code) {
  return store.subjects.find((s) => s.code === code)?.name ?? code ?? "";
}

/**
 * Which subject's papers a course answers from. "Extra Maths" and "Single
 * Science Physics" have no syllabus of their own, so they borrow Maths A's and
 * Physics's. Everything sent to search, ask, mark or mock goes through this.
 */
export function corpusCode(code) {
  const row = store.subjects.find((s) => s.code === code);
  return row?.corpus_code || code;
}

/**
 * The course a student takes that uses this corpus subject, so a revision task
 * lands on a planner card they actually have. Exact course, then any course
 * borrowing this corpus, then the corpus subject itself.
 */
export function courseFor(corpus) {
  const mine = mySubjectRows();
  return (
    mine.find((s) => s.code === corpus) ??
    mine.find((s) => corpusCode(s.code) === corpus) ??
    { code: corpus }
  ).code;
}

/** The subjects a student takes, in catalogue order, as full rows. */
export function mySubjectRows() {
  const mine = new Set(store.mySubjects);
  return store.subjects.filter((s) => mine.has(s.code));
}

/** Corpus coverage for one subject, or null when nothing is ingested. */
export function coverageFor(code) {
  const row = store.coverage.find((c) => c.subject_code === code);
  return row && row.questions > 0 ? row : null;
}

/** Subjects the AI can actually ground answers in. */
export function groundedSubjects() {
  return mySubjectRows().filter((s) => coverageFor(s.code));
}

export function reset() {
  store.user = null;
  store.profile = null;
  store.subjects = [];
  store.mySubjects = [];
  store.tasks = [];
  store.tuition = [];
  store.coverage = [];
  store.usage = [];
  store.isAdmin = false;
  store.ready = false;
  // Prefs belong to the person; the next account mustn't inherit them.
  Object.assign(store.prefs, DEFAULT_PREFS);
}
