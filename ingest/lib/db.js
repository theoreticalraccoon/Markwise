// Corpus writes. Service-role key, so RLS doesn't apply here.

import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SERVICE_KEY } from "./config.js";

export const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export async function getSubject(code) {
  const { data } = await db.from("subjects").select("code,name,board").eq("code", code).maybeSingle();
  return data;
}

// Board from the code prefix. Cambridge codes are bare digits.
const BOARD_PREFIX = { "E-": "Edexcel", "A-": "AQA", "O-": "OCR", "X-": "School" };

function boardFor(code) {
  for (const [prefix, board] of Object.entries(BOARD_PREFIX)) {
    if (code.toUpperCase().startsWith(prefix)) return board;
  }
  return /^\d{4}$/.test(code) ? "Cambridge" : "Other";
}

/** Make sure a subject row exists. Auto-created rows are named after their code, so warn. */
export async function ensureSubject(code, name = null) {
  const existing = await getSubject(code);
  if (existing) return existing;
  const { data, error } = await db
    .from("subjects")
    .insert({ code, name: name ?? code, board: boardFor(code) })
    .select("code,name,board")
    .single();
  if (error) throw new Error(`Could not create subject ${code}: ${error.message}`);
  console.warn(`  ! created subject "${code}" (board: ${boardFor(code)}). Give it a real name:`);
  console.warn(`    update public.subjects set name = 'Your Subject Name' where code = '${code}';`);
  return data;
}

// PostgREST's .eq(col, null) matches nothing; nullable columns need .is().
// Using .eq everywhere made every re-ingest insert a duplicate paper.
function matchOrNull(query, column, value) {
  return value === null || value === undefined || value === "" ? query.is(column, null) : query.eq(column, value);
}

/** A paper is identified by subject, kind, year, series and its paper reference. */
export async function findPaper(meta) {
  let q = db
    .from("papers")
    .select("id,sha256")
    .eq("subject_code", meta.subjectCode)
    .eq("kind", meta.kind)
    .eq("paper_ref", meta.paperRef ?? "");
  q = matchOrNull(q, "year", meta.year);
  q = matchOrNull(q, "session", meta.session);
  const { data, error } = await q.limit(1);
  if (error) throw new Error(`Paper lookup failed: ${error.message}`);
  return data?.[0] ?? null;
}

async function chunkCount(paperId) {
  const { count, error } = await db
    .from("chunks")
    .select("id", { count: "exact", head: true })
    .eq("paper_id", paperId);
  if (error) throw new Error(`Chunk count failed: ${error.message}`);
  return count ?? 0;
}

/**
 * Find or create a paper row. `unchanged` is only true when the same files were
 * ingested completely: the hash is written last, by markIngested.
 */
export async function upsertPaper(meta, { title, sha256, pages, sourceUrl = null, force = false }) {
  const existing = await findPaper(meta);

  if (existing && !force && existing.sha256 === sha256 && (await chunkCount(existing.id)) > 0) {
    return { paper: existing, unchanged: true };
  }

  const row = {
    subject_code: meta.subjectCode,
    kind: meta.kind,
    year: meta.year,
    session: meta.session,
    paper_no: meta.paperNo,
    variant: meta.variant,
    paper_ref: meta.paperRef ?? "",
    tier: meta.tier ?? null,
    title,
    code: meta.code,
    source_url: sourceUrl,
    pages,
    // Cleared until the run succeeds; see markIngested.
    sha256: null,
    ingested_at: new Date().toISOString(),
  };

  if (existing) {
    const { data, error } = await db.from("papers").update(row).eq("id", existing.id).select("id").single();
    if (error) throw new Error(`Paper update failed: ${error.message}`);
    return { paper: data, unchanged: false };
  }

  const { data, error } = await db.from("papers").insert(row).select("id").single();
  if (error) throw new Error(`Paper insert failed: ${error.message}`);
  return { paper: data, unchanged: false };
}

/** Record that a paper was ingested in full. The last write of a successful run. */
export async function markIngested(paperId, sha256, { totalMarks = null } = {}) {
  const patch = { sha256, ingested_at: new Date().toISOString() };
  // The printed total is the marking denominator, so a lost question can't
  // inflate a student's percentage.
  if (totalMarks) patch.total_marks = totalMarks;
  const { error } = await db.from("papers").update(patch).eq("id", paperId);
  if (error) throw new Error(`Could not mark the paper as ingested: ${error.message}`);
}

/** Insert chunks in batches small enough to stay under the request size cap. */
export async function insertChunks(rows, batch = 100) {
  let written = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch);
    const { error } = await db.from("chunks").insert(slice);
    if (error) throw new Error(`Chunk insert failed: ${error.message}`);
    written += slice.length;
  }
  return written;
}

/**
 * Replace a paper's question chunks but keep the ids of the ones that stay.
 * Recall schedules, attempts and saved mocks all point at chunk ids, so rows
 * are upserted on (paper, kind, question) and only vanished ones are deleted.
 */
export async function replaceQuestionChunks(paperId, kind, rows, batch = 100) {
  let written = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch);
    const { error } = await db.from("chunks").upsert(slice, { onConflict: "paper_id,kind,question_no" });
    if (error) throw new Error(`Chunk upsert failed: ${error.message}`);
    written += slice.length;
  }

  const keep = new Set(rows.map((r) => r.question_no));
  const { data: existing, error } = await db
    .from("chunks")
    .select("id,question_no")
    .eq("paper_id", paperId)
    .eq("kind", kind);
  if (error) throw new Error(`Chunk listing failed: ${error.message}`);
  const stale = (existing ?? []).filter((c) => !keep.has(c.question_no)).map((c) => c.id);
  for (let i = 0; i < stale.length; i += 100) {
    await db.from("chunks").delete().in("id", stale.slice(i, i + 100));
  }
  return written;
}

/** For content with no stable per-row key (syllabus sections): swap the lot. */
export async function replaceAllChunks(paperId, kind, rows) {
  const { error } = await db.from("chunks").delete().eq("paper_id", paperId).eq("kind", kind);
  if (error) throw new Error(`Could not clear old ${kind} chunks: ${error.message}`);
  return insertChunks(rows);
}

export async function coverage() {
  const { data, error } = await db.from("corpus_coverage").select("*").order("questions", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Chunks that were written before embedding succeeded, for `reembed`. */
export async function chunksMissingEmbedding(subjectCode, limit = 500) {
  let q = db.from("chunks").select("id,content,ms_content,topic,question_no").is("embedding", null).limit(limit);
  if (subjectCode) q = q.eq("subject_code", subjectCode);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function setEmbedding(id, embedding) {
  const { error } = await db.from("chunks").update({ embedding }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function upsertGradeBoundaries(rows) {
  if (!rows.length) return 0;
  const { error } = await db
    .from("grade_boundaries")
    .upsert(rows, { onConflict: "subject_code,year,session,paper_ref,tier,grade" });
  if (error) throw new Error(`Grade boundary upsert failed: ${error.message}`);
  return rows.length;
}
