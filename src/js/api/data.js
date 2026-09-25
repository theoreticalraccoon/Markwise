// Every table read and write, in one place. RLS keeps each user to their own rows.

import { sb } from "./client.js";
import { store } from "../store.js";
import { readSnapshot, saveSnapshot } from "../lib/offline.js";

const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;
const SUBJECT_ALIASES = Object.freeze({ "X-FPM": "E-4PM1" });

export function canonicalSubjectCode(code) {
  return SUBJECT_ALIASES[code] ?? code;
}

export function normalizeSubjectCodes(codes = []) {
  return [...new Set(codes.map(canonicalSubjectCode))];
}

export function normalizeCatalogue(rows = []) {
  const subjects = new Map();
  for (const row of rows) {
    const code = canonicalSubjectCode(row.code);
    const canonical = row.code === code;
    const next = code === "E-4PM1"
      ? { ...row, code, name: "Further Pure Mathematics", board: "Edexcel", corpus_code: null }
      : { ...row, code };
    if (!subjects.has(code) || canonical) subjects.set(code, next);
  }
  return [...subjects.values()];
}

function saved(name) {
  const value = readSnapshot(store.user?.id, name);
  if (value === null) throw new Error("This is not saved for offline use. Reconnect to open it.");
  return value;
}

function keepMock(mock) {
  saveSnapshot(store.user?.id, `mock:${mock.id}`, mock);
  const list = readSnapshot(store.user?.id, "mocks") ?? [];
  saveSnapshot(store.user?.id, "mocks", [mock, ...list.filter((m) => m.id !== mock.id)].slice(0, 50));
  return mock;
}

const fail = (what, error) => {
  if (error) throw new Error(`${what}: ${error.message}`);
};

/* -------------------------------------------------------------- catalogue -- */

export async function loadCatalogue() {
  if (offline()) {
    const cached = saved("catalogue");
    store.subjects = normalizeCatalogue(cached.subjects);
    store.coverage = cached.coverage;
    return store.subjects;
  }
  const [subjects, coverage] = await Promise.all([
    sb.from("subjects").select("code,name,board,level,corpus_code").eq("active", true).order("name"),
    sb.from("corpus_coverage").select("*"),
  ]);
  fail("Could not load subjects", subjects.error);
  store.subjects = normalizeCatalogue(subjects.data ?? []);
  // Coverage is a nicety. A missing view must not block sign-in.
  store.coverage = coverage.error ? [] : (coverage.data ?? []);
  saveSnapshot(store.user?.id, "catalogue", { subjects: store.subjects, coverage: store.coverage });
  return store.subjects;
}

/** Can this account add papers to the shared library? The UI asks up front; the server decides. */
export async function loadAdmin(userId) {
  if (offline()) { store.isAdmin = false; return false; }
  const { data, error } = await sb.rpc("is_admin", { p_user: userId });
  store.isAdmin = !error && data === true;
  return store.isAdmin;
}

/* ---------------------------------------------------------------- profile -- */

export async function loadProfile(userId) {
  const { data, error } = offline() ? { data: saved("profile"), error: null } : await sb
    .from("profiles")
    .select("subjects,onboarded,prefs,exam_session,board,display_name")
    .eq("id", userId)
    .maybeSingle();
  fail("Could not load your profile", error);

  const normalized = data ? {
    ...data,
    subjects: normalizeSubjectCodes(data.subjects),
    prefs: data.prefs && typeof data.prefs === "object" ? {
      ...data.prefs,
      ...(data.prefs.lastSubject ? { lastSubject: canonicalSubjectCode(data.prefs.lastSubject) } : {}),
      ...(data.prefs.lastCorpus ? { lastCorpus: canonicalSubjectCode(data.prefs.lastCorpus) } : {}),
    } : data.prefs,
  } : null;
  store.profile = normalized;
  if (!offline()) saveSnapshot(userId, "profile", normalized);
  store.mySubjects = normalized?.subjects ?? [];
  if (normalized?.prefs && typeof normalized.prefs === "object") {
    Object.assign(store.prefs, normalized.prefs);
  }
  return normalized;
}

export async function saveProfile(patch) {
  const { error } = await sb.from("profiles").upsert({
    id: store.user.id,
    ...patch,
    onboarded: true,
    updated_at: new Date().toISOString(),
  });
  fail("Could not save your profile", error);
  if (patch.subjects) store.mySubjects = patch.subjects;
  store.profile = { ...(store.profile ?? {}), ...patch };
  saveSnapshot(store.user.id, "profile", store.profile);
}

let prefsTimer = null;
/** Debounced, because tab switches and toggles fire fast. */
export function syncPrefs() {
  if (!store.user) return;
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(async () => {
    const { source, hideEmpty, plannerView, lastSubject, lastCorpus } = store.prefs;
    await sb
      .from("profiles")
      .update({ prefs: { source, hideEmpty, plannerView, lastSubject, lastCorpus }, updated_at: new Date().toISOString() })
      .eq("id", store.user.id);
  }, 600);
}

/* ------------------------------------------------------------------ tasks -- */

const TASK_FIELDS =
  "id,subject,type,source,text,notes,due,due_time,done,done_at,priority,topic,estimate_min,created,origin,origin_ref";

export async function loadTasks() {
  const { data, error } = await sb.from("tasks").select(TASK_FIELDS).order("due", { nullsFirst: false });
  fail("Could not load your tasks", error);
  store.tasks = data ?? [];
  return store.tasks;
}

export async function createTask(fields) {
  const row = {
    subject: fields.subject,
    type: fields.type ?? "homework",
    source: fields.source ?? "school",
    text: fields.text,
    notes: fields.notes ?? null,
    due: fields.due || null,
    due_time: fields.dueTime || null,
    priority: fields.priority ?? 1,
    topic: fields.topic ?? null,
    estimate_min: fields.estimateMin ?? null,
    origin: fields.origin ?? "manual",
    origin_ref: fields.originRef ?? null,
    done: false,
    created: Date.now(),
  };
  const { data, error } = await sb.from("tasks").insert(row).select(TASK_FIELDS).single();
  fail("Could not save that task", error);
  store.tasks.push(data);
  return data;
}

export async function updateTask(id, patch) {
  const { data, error } = await sb.from("tasks").update(patch).eq("id", id).select(TASK_FIELDS).single();
  fail("Could not update that task", error);
  const i = store.tasks.findIndex((t) => t.id === id);
  if (i >= 0) store.tasks[i] = data;
  return data;
}

export async function setTaskDone(id, done) {
  return updateTask(id, { done, done_at: done ? new Date().toISOString() : null });
}

export async function deleteTask(id) {
  const { error } = await sb.from("tasks").delete().eq("id", id);
  fail("Could not delete that task", error);
  store.tasks = store.tasks.filter((t) => t.id !== id);
}

export async function clearCompleted(source) {
  const doomed = store.tasks.filter((t) => t.done && (!source || t.source === source));
  if (!doomed.length) return 0;
  const { error } = await sb.from("tasks").delete().in("id", doomed.map((t) => t.id));
  fail("Could not clear completed tasks", error);
  const gone = new Set(doomed.map((t) => t.id));
  store.tasks = store.tasks.filter((t) => !gone.has(t.id));
  return doomed.length;
}

/* --------------------------------------------------------------- tuition -- */

export async function loadTuition() {
  const { data, error } = await sb
    .from("tuition_sessions")
    .select("id,subject,tutor,weekday,start_time,end_time,location,active")
    .eq("active", true)
    .order("weekday")
    .order("start_time");
  fail("Could not load your tuition timetable", error);
  store.tuition = data ?? [];
  return store.tuition;
}

export async function createTuition(row) {
  const { data, error } = await sb.from("tuition_sessions").insert(row).select("*").single();
  fail("Could not save that session", error);
  store.tuition.push(data);
  return data;
}

export async function deleteTuition(id) {
  const { error } = await sb.from("tuition_sessions").delete().eq("id", id);
  fail("Could not remove that session", error);
  store.tuition = store.tuition.filter((t) => t.id !== id);
}

/* ---------------------------------------------------------------- corpus -- */

const CHUNK_FIELDS =
  "id,subject_code,kind,paper_code,year,session,paper_no,variant,question_no," +
  "question_root,marks,command_word,topic,syllabus_refs,content,ms_content,er_content,page";

/** Browse the corpus. `limit` is clamped: this is the one query that could ask for everything. */
export async function searchLibrary({
  subject, query = "", topic = null, paperId = null, markableOnly = false,
  limit = 25, offset = 0,
}) {
  const size = Math.min(50, Math.max(1, limit));
  let q = sb
    .from("chunks")
    .select(
      "id,subject_code,paper_code,paper_ref,year,session,paper_no,variant,question_no,marks,topic,command_word,content,ms_content",
      { count: "estimated" },
    )
    .eq("kind", "question")
    // Natural order with a tiebreaker, so paging never repeats or skips a row.
    .order("year", { ascending: false })
    .order("session", { ascending: false })
    .order("paper_id")
    .order("q_sort")
    .order("id")
    .range(offset, offset + size);

  if (subject) q = q.eq("subject_code", subject);
  if (topic) q = q.eq("topic", topic);
  if (paperId) q = q.eq("paper_id", paperId);
  if (markableOnly) q = q.not("ms_content", "is", null);
  // Keyword only: semantic search costs a Gemini call.
  if (query.trim()) q = q.textSearch("fts", query.trim(), { type: "websearch" });

  const { data, error, count } = await q;
  fail("Search failed", error);
  // One extra row tells us whether there's another page.
  const all = data ?? [];
  return { rows: all.slice(0, size), total: count ?? 0, pageSize: size, hasMore: all.length > size };
}

export async function getChunk(id) {
  // Explicit columns: select("*") would ship the 768-float embedding too.
  const { data, error } = await sb
    .from("chunks")
    .select(CHUNK_FIELDS)
    .eq("id", id)
    .maybeSingle();
  fail("Could not load that question", error);
  return data;
}

/** Question papers for a subject that actually have questions stored. */
export async function listPapers(subject) {
  const { data, error } = await sb.rpc("subject_papers", { p_subject: subject });
  fail("Could not load papers", error);
  return data ?? [];
}

export async function subjectTopics(subject) {
  const { data, error } = await sb.rpc("subject_topics", { p_subject: subject });
  fail("Could not load topics", error);
  return data ?? [];
}

export async function similarQuestions(chunkId, limit = 6) {
  const { data, error } = await sb.rpc("similar_chunks", { p_chunk_id: chunkId, p_limit: limit });
  fail("Could not find similar questions", error);
  return data ?? [];
}

/* --------------------------------------------------------------- progress -- */

export async function loadAttempts({ subject = null, limit = 100 } = {}) {
  let q = sb
    .from("attempts")
    .select("id,subject_code,question_ref,awarded,total,topic,created_at,missed,mock_id")
    .order("created_at", { ascending: false })
    .limit(Math.min(200, Math.max(1, limit)));
  if (subject) q = q.eq("subject_code", subject);
  const { data, error } = await q;
  fail("Could not load your attempts", error);
  return data ?? [];
}

export async function getAttempt(id) {
  const { data, error } = await sb.from("attempts").select("*").eq("id", id).maybeSingle();
  fail("Could not load that attempt", error);
  return data;
}

export async function loadMastery(subject = null) {
  let q = sb.from("topic_mastery").select("subject_code,topic,attempts,marks_awarded,marks_total");
  if (subject) q = q.eq("subject_code", subject);
  const { data, error } = await q;
  fail("Could not load your topic mastery", error);
  return data ?? [];
}

export async function weakTopics(subject = null, limit = 8) {
  const { data, error } = await sb.rpc("weak_topics", { p_subject: subject, p_limit: limit });
  fail("Could not work out your weak topics", error);
  return data ?? [];
}

/* ------------------------------------------------------------------ mocks -- */

export async function loadMocks(limit = 30) {
  if (offline()) return saved("mocks").slice(0, limit);
  const { data, error } = await sb
    .from("mocks")
    .select("id,subject_code,title,total_marks,duration_min,status,awarded,grade,created_at,submitted_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  fail("Could not load your mocks", error);
  saveSnapshot(store.user?.id, "mocks", data ?? []);
  return data ?? [];
}

export async function getMock(id) {
  if (offline()) return saved(`mock:${id}`);
  const { data, error } = await sb.from("mocks").select("*").eq("id", id).maybeSingle();
  fail("Could not load that mock", error);
  const cached = readSnapshot(store.user?.id, `mock:${id}`);
  if (data?.status === "ready" && cached?.status === "in_progress" && cached.started_at) {
    return updateMock(id, { status: "in_progress", started_at: cached.started_at });
  }
  if (data) return keepMock(data);
  saveSnapshot(store.user?.id, `mock:${id}`, null);
  return null;
}

export async function updateMock(id, patch) {
  if (offline()) {
    if (patch.status !== "in_progress") throw new Error("Reconnect to update this mock.");
    return keepMock({ ...saved(`mock:${id}`), ...patch });
  }
  const { data, error } = await sb.from("mocks").update(patch).eq("id", id).select("*").single();
  fail("Could not update that mock", error);
  return keepMock(data);
}

export async function deleteMock(id) {
  const { error } = await sb.from("mocks").delete().eq("id", id);
  fail("Could not delete that mock", error);
  saveSnapshot(store.user?.id, `mock:${id}`, null);
  const list = readSnapshot(store.user?.id, "mocks") ?? [];
  saveSnapshot(store.user?.id, "mocks", list.filter((m) => m.id !== id));
}

/* ------------------------------------------------------------------ chat -- */

export async function loadThreads(limit = 30) {
  const { data, error } = await sb
    .from("chat_threads")
    .select("id,title,mode,subject_code,updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit);
  fail("Could not load your chats", error);
  return data ?? [];
}

export async function createThread({ title, mode = "ask", subject = null }) {
  const { data, error } = await sb
    .from("chat_threads")
    .insert({ title: title.slice(0, 80), mode, subject_code: subject })
    .select("id,title,mode,subject_code")
    .single();
  fail("Could not start that chat", error);
  return data;
}

export async function loadMessages(threadId, page = 0) {
  const index = Number.isFinite(page) ? Math.max(0, Math.floor(page)) : 0;
  const size = 50;
  const { data, error } = await sb
    .from("chat_messages")
    .select("id,role,content,citations,created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(index * size, index * size + size);
  fail("Could not load that chat", error);
  return { rows: (data ?? []).slice(0, size).reverse(), hasMore: (data ?? []).length > size };
}

export async function deleteThread(id) {
  const { error } = await sb.from("chat_threads").delete().eq("id", id);
  fail("Could not delete that chat", error);
}

/* -------------------------------------------------------- marked papers -- */

const PAPER_ATTEMPT_LIST =
  "id,subject_code,title,awarded,total,pct,grade,answered,marked,unmarkable,created_at";

export async function loadPaperAttempts(limit = 20) {
  const { data, error } = await sb
    .from("paper_attempts")
    .select(PAPER_ATTEMPT_LIST)
    .order("created_at", { ascending: false })
    .limit(Math.min(50, Math.max(1, limit)));
  fail("Could not load your marked papers", error);
  return data ?? [];
}

export async function getPaperAttempt(id) {
  const { data, error } = await sb.from("paper_attempts").select("*").eq("id", id).maybeSingle();
  fail("Could not load that marked paper", error);
  return data;
}

export async function deletePaperAttempt(id) {
  const { error } = await sb.from("paper_attempts").delete().eq("id", id);
  fail("Could not delete that marked paper", error);
}

/* -------------------------------------------------------------- revision -- */

/** Topics whose spaced-revision date has come round. */
export async function dueRevisions(subject = null, limit = 10) {
  const { data, error } = await sb.rpc("due_revisions", { p_subject: subject, p_limit: limit });
  if (error) return [];   // pre-migration databases simply have no schedule yet
  return data ?? [];
}

/* ---------------------------------------------------------------- recall -- */

/** Short real questions to self-test on: due cards first, then unseen ones. */
export async function recallDeck(subject, limit = 15) {
  const { data, error } = await sb.rpc("recall_deck", { p_subject: subject, p_limit: limit });
  fail("Could not build a recall deck", error);
  return data ?? [];
}

/** grade: 0 again · 1 hard · 2 good · 3 easy. */
export async function recordRecall(chunkId, subject, grade) {
  const { error } = await sb.rpc("record_recall", {
    p_chunk_id: chunkId,
    p_subject: subject,
    p_grade: grade,
  });
  fail("Could not save that review", error);
}

/* --------------------------------------------------------------- trends -- */

export async function progressSeries(subject = null, weeks = 12) {
  const { data, error } = await sb.rpc("progress_series", { p_subject: subject, p_weeks: weeks });
  if (error) return [];
  return data ?? [];
}

export async function subjectReadiness(subject) {
  const { data, error } = await sb.rpc("subject_readiness", { p_subject: subject });
  if (error) return null;
  return Array.isArray(data) ? data[0] ?? null : data ?? null;
}

/* ----------------------------------------------------------------- usage -- */

export async function loadUsage() {
  const { data, error } = await sb.rpc("my_ai_usage");
  if (error) return [];
  store.usage = data ?? [];
  return store.usage;
}
