/**
 * POST /functions/v1/ingest
 *
 * Adds one past-paper PDF to the corpus, straight from the browser.
 *
 * The student supplies a file and nothing else. No filename convention, no
 * subject code, no CLI. Gemini reads the cover page to work out what the
 * document is, then extracts either the questions or the marking points,
 * and the result is embedded and stored.
 *
 * Mark schemes are matched to a question paper that is already in the corpus
 * and fill in its `ms_content`. A mark scheme that arrives first is stored on
 * its own so the question paper can pair with it later. The student should
 * not have to care which order they dragged the files in.
 *
 * Body: { file: { mimeType, data }, fileName? }
 */

import { preflight, fail, json } from "../_shared/http.ts";
import { requireUser, adminClient } from "../_shared/db.ts";
import { claim, release, QuotaExceeded } from "../_shared/quota.ts";
import { embedBatch } from "../_shared/gemini.ts";
import { readFiles, validate, type Attachment } from "../_shared/files.ts";

const IDENTIFY_SYSTEM = `
You identify Pearson Edexcel International GCSE exam documents from their cover
page and contents.

- kind: "qp" a question paper, "ms" a mark scheme, "sy" a specification, "er"
  an examiner report, "other" for anything else.
- subjectName is the subject as printed ("Mathematics A", "Physics").
- subjectCode is the code exactly as printed WITHOUT the paper part: the cover
  reads "4PH1/1P", so the subjectCode is "4PH1". Null if you cannot see one.
- paperRef is the paper reference exactly as printed, letters included: the
  "1P" of "4PH1/1P", the "2H" of "4MA1/2H", "1PR" for a reserve paper, "01" for
  a single-tier paper. NEVER reduce it to a number: 1F and 1H are different
  papers, and so are 1P and 1PR. Null if there is none.
- session is the exam series: "Jan" for January, "Jun" for May/June, "Nov" for
  October/November. A cover prints a date ("Wednesday 15 May 2024"), so work the
  series out from the month if it is not named. year is the year of that date.
  Null for a specification.
Report only what is printed. Guess nothing.
`.trim();

const IDENTIFY_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["qp", "ms", "sy", "er", "other"] },
    board: { type: "string" },
    subjectName: { type: "string" },
    subjectCode: { type: "string", nullable: true },
    year: { type: "number", nullable: true },
    session: { type: "string", nullable: true, enum: ["Jan", "Jun", "Nov"] },
    paperRef: { type: "string", nullable: true },
  },
  required: ["kind", "subjectName", "board"],
} as const;

const QP_SYSTEM = `
You split a Pearson Edexcel International GCSE question paper into its markable parts.

- One entry per part that carries its own marks. If 4(a) has (i) and (ii),
  emit 4(a)(i) and 4(a)(ii), never 4(a).
- text is the question VERBATIM. Never summarise, correct or complete it.
  Where a part depends on a stem ("Fig. 2.1 shows a circuit", "450 students
  were asked…"), repeat that stem at the top of the part so it can be read and
  answered on its own.
- Describe any diagram the question depends on in one bracketed line, e.g.
  [Diagram: a ray of light entering a glass block at 40 degrees].
- marks is the mark allocation. Edexcel prints (3) on its own line after the
  part. "(Total for Question 1 is 3 marks)" closes a whole question: it is NOT
  a part, never emit it as one, and never use it as the marks of a part.
- Questions marked with an asterisk (*18) are extended-response: keep the
  asterisk out of questionNo but keep the text and marks as printed.
- topic is the syllabus topic the question tests, in three words or fewer.
- Skip cover pages, formulae sheets, blank pages and answer lines.
- A part with no mark allocation is not markable. Leave it out.
`.trim();

const QP_SCHEMA = {
  type: "object",
  properties: {
    parts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          questionNo: { type: "string" },
          text: { type: "string" },
          marks: { type: "number" },
          topic: { type: "string", nullable: true },
        },
        required: ["questionNo", "text", "marks"],
      },
    },
  },
  required: ["parts"],
} as const;

const MS_SYSTEM = `
You transcribe a Pearson Edexcel International GCSE mark scheme into rows, one
per question part.

- Copy each row VERBATIM: the working, the answer, the notes and the mark
  column together, including the mark codes (M1, A1, B1, P1, C1, "dep", "ft",
  "cao", "awrt", "oe", "isw", "sc", "bod", "NB") and every "accept", "reject",
  "allow" and "ignore" instruction. The notes column is where the rules that
  decide a mark live.
- questionNo must match the question paper's numbering: 4(b)(ii), not "4b ii".
  Starred questions ("16*") are numbered without the asterisk.
- marks is the allocation for that part.
- Never paraphrase. A paraphrased mark scheme cannot be marked against.
`.trim();

const MS_SCHEMA = {
  type: "object",
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          questionNo: { type: "string" },
          text: { type: "string" },
          marks: { type: "number", nullable: true },
        },
        required: ["questionNo", "text"],
      },
    },
  },
  required: ["rows"],
} as const;

interface Identity {
  kind: string; board?: string; subjectName: string; subjectCode?: string | null;
  year?: number | null; session?: string | null;
  /** The paper reference as printed: "1H", "2PR", "01". The whole identity of a paper. */
  paperRef?: string | null;
  paperNo?: number | null; variant?: number | null; tier?: string | null;
}

const SERIES = new Set(["Jan", "Mar", "Jun", "Nov"]);

/** "4PH1/1P" -> "1P", "1 P" -> "1P". Empty string when there is no reference. */
function normaliseRef(ref: string | null | undefined): string {
  const r = String(ref ?? "").toUpperCase().replace(/^.*\//, "").replace(/[^A-Z0-9]/g, "");
  return /^\d/.test(r) ? r : "";
}

const key = (n: string) => String(n ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return fail(req, "POST only", 405);

  let user;
  try {
    user = await requireUser(req);
  } catch {
    return fail(req, "Sign in first.", 401);
  }

  let body: { file?: Attachment; fileName?: string };
  try {
    body = await req.json();
  } catch {
    return fail(req, "Invalid request.");
  }
  const file = body.file;
  if (!file) return fail(req, "No file received.");
  const invalid = validate([file]);
  if (invalid) return fail(req, invalid);

  // The corpus is shared by every student, and this route replaces papers and
  // mark schemes in it. Letting any signed-in user do that meant anyone could
  // overwrite the scheme everyone else is marked against. Adding papers is for
  // the person who runs the deployment.
  const { data: isAdmin } = await adminClient().rpc("is_admin", { p_user: user.id });
  if (!isAdmin) {
    return json(req, {
      error: "admin_only",
      message: "Adding papers to the shared library is limited to whoever runs this deployment. Ask them to add it, or use the ingestion command line.",
    }, 403);
  }

  try {
    await claim(user, "ingest");
  } catch (e) {
    if (e instanceof QuotaExceeded) return fail(req, e.message, 429);
    throw e;
  }

  const admin = adminClient();

  // Everything from here can throw (a Gemini call, a database write). Whatever
  // happens, the reservation is handed back rather than spent on nothing.
  const run = async (): Promise<Response> => {

  // ---- what is this document? --------------------------------------------
  let id: Identity;
  try {
    id = await readFiles<Identity>(
      [file],
      `Identify this exam document.${body.fileName ? ` Its filename is "${body.fileName}".` : ""}`,
      IDENTIFY_SCHEMA as unknown as Record<string, unknown>,
      { system: IDENTIFY_SYSTEM, maxOutputTokens: 2048 },
    );
  } catch (e) {
    await release(user, "ingest");
    return fail(req, e instanceof Error ? e.message : "Could not read that file.", 502);
  }

  id.paperRef = normaliseRef(id.paperRef);
  id.tier = /^\d+([FH])$/.test(id.paperRef) ? id.paperRef.slice(-1) : null;
  id.paperNo = id.paperRef ? Number(id.paperRef.replace(/^0+/, "")[0]) || null : null;
  id.variant = null;
  if (id.session && !SERIES.has(id.session)) id.session = null;

  if (id.kind === "other") {
    await release(user, "ingest");
    return json(req, { error: "unrecognised", message: "That does not look like a past paper, mark scheme or syllabus." }, 422);
  }
  if (id.kind === "sy" || id.kind === "er") {
    await release(user, "ingest");
    return json(req, {
      error: "unsupported",
      message: `That looks like a ${id.kind === "sy" ? "syllabus" : "examiner report"}. Add question papers and mark schemes for now.`,
    }, 422);
  }

  // A paper with no year or series cannot be told apart from another, and a
  // guess would file it on top of a different paper. Refuse instead.
  if ((id.kind === "qp" || id.kind === "ms") && (!id.year || !id.session)) {
    await release(user, "ingest");
    return json(req, {
      error: "unrecognised_series",
      message: "Could not read the year and exam series (January, June or November) from that document. Nothing was added.",
    }, 422);
  }

  // ---- which subject? -----------------------------------------------------
  const subjectCode = await resolveSubject(admin, id);
  if (!subjectCode) {
    await release(user, "ingest");
    return json(req, {
      error: "unknown_subject",
      message: "That does not look like a Pearson Edexcel International GCSE subject this library covers. Nothing was added.",
    }, 422);
  }

  // ---- extract ------------------------------------------------------------
  const paperCode = buildCode(subjectCode, id);

  if (id.kind === "ms") {
    const { rows } = await readFiles<{ rows: { questionNo: string; text: string; marks?: number | null }[] }>(
      [file], "Transcribe this mark scheme.", MS_SCHEMA as unknown as Record<string, unknown>,
      { system: MS_SYSTEM },
    );

    const attached = await attachMarkScheme(admin, subjectCode, id, rows);
    return json(req, {
      kind: "ms",
      subject: id.subjectName,
      subjectCode,
      paperCode,
      rows: rows.length,
      attached,
      message: attached > 0
        ? `Mark scheme added: ${attached} question${attached === 1 ? "" : "s"} can now be marked.`
        : "Mark scheme saved. Add its question paper and they will be paired automatically.",
    });
  }

  // --- question paper ------------------------------------------------------
  const { parts } = await readFiles<{ parts: { questionNo: string; text: string; marks: number; topic?: string | null }[] }>(
    [file], "Split this question paper into its markable parts.",
    QP_SCHEMA as unknown as Record<string, unknown>, { system: QP_SYSTEM },
  );

  const usable = (parts ?? []).filter((p) => p.text?.trim() && p.marks > 0);
  if (!usable.length) {
    await release(user, "ingest");
    return fail(req, "No questions could be read from that paper.", 422);
  }

  // De-duplicate: a repeated number means the reader lost its place.
  const seen = new Set<string>();
  const clean = usable.filter((p) => {
    const k = key(p.questionNo);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const paperId = await upsertPaper(admin, subjectCode, id, paperCode, body.fileName ?? null);

  // Mark schemes this paper already had, before its rows are replaced.
  // Re-adding a question paper must never silently destroy pairings that took
  // a separate upload, or a whole CLI run, to establish.
  const existing = await loadExistingMarkSchemes(admin, paperId);
  // A mark scheme uploaded before its question paper waits here for it.
  const pending = await loadPendingMarkScheme(admin, subjectCode, id);
  for (const [k, v] of existing) if (!pending.has(k)) pending.set(k, v);

  const rows = clean.map((p) => ({
    paper_id: paperId,
    subject_code: subjectCode,
    kind: "question",
    paper_code: paperCode,
    year: id.year ?? null,
    session: id.session ?? null,
    paper_no: id.paperNo ?? null,
    variant: null,
    paper_ref: id.paperRef ?? "",
    tier: id.tier ?? null,
    question_no: p.questionNo,
    question_root: String(p.questionNo).match(/^\d+/)?.[0] ?? null,
    marks: p.marks,
    topic: p.topic?.trim() || null,
    content: p.text.trim(),
    ms_content: pending.get(key(p.questionNo)) ?? null,
  }));

  const vectors = await embedBatch(
    rows.map((r) => [r.topic, `Question ${r.question_no} (${r.marks} marks)`, r.content, r.ms_content]
      .filter(Boolean).join("\n").slice(0, 7000)),
    "RETRIEVAL_DOCUMENT",
  ).catch(() => [] as number[][]);

  rows.forEach((r, i) => { (r as Record<string, unknown>).embedding = vectors[i] ?? null; });

  // Upserted on (paper, kind, question number) so a question keeps its id when
  // the paper is added again. Deleting and re-creating gave every question a
  // new id, which wiped each student's recall schedule for it.
  await replaceChunks(admin, paperId, "question", rows);

  const paired = rows.filter((r) => r.ms_content).length;
  return json(req, {
    kind: "qp",
    subject: id.subjectName,
    subjectCode,
    paperCode,
    questions: rows.length,
    paired,
    message: paired
      ? `${rows.length} questions added, ${paired} ready to mark.`
      : `${rows.length} questions added. Add the mark scheme to be able to mark them.`,
  });
  };

  try {
    return await run();
  } catch (e) {
    await release(user, "ingest");
    return fail(req, e instanceof Error ? e.message : "Could not add that paper.", 502);
  }
});

/* ---------------------------------------------------------------- helpers -- */

/**
 * The subject row this document belongs to, or null when it is not one this
 * library covers.
 *
 * Edexcel codes look like 4PH1 and are stored as E-4PH1. A code that matches no
 * pattern is refused: this used to invent a subject from whatever the model
 * read, so one misread number ("2024") created a subject that then appeared in
 * every student's onboarding.
 */
async function resolveSubject(admin: ReturnType<typeof adminClient>, id: Identity): Promise<string | null> {
  const printed = (id.subjectCode ?? "").trim().toUpperCase().replace(/\/.*$/, "").replace(/\s+/g, "");
  const bare = printed.replace(/^E-/, "");
  if (!/^4[A-Z]{2}[0-9]$/.test(bare)) return null;
  const code = `E-${bare}`;

  const { data: existing } = await admin.from("subjects").select("code").eq("code", code).maybeSingle();
  if (existing) return existing.code;

  const { error } = await admin.from("subjects").insert({
    code,
    name: id.subjectName || code,
    board: "Edexcel",
    level: "International GCSE",
  });
  if (error) throw new Error(`Could not add the subject ${code}: ${error.message}`);
  return code;
}

function buildCode(subjectCode: string, id: Identity): string {
  const letter = { Jan: "j", Mar: "m", Jun: "s", Nov: "w" }[id.session ?? ""] ?? "y";
  const yy = id.year ? String(id.year).slice(2) : "00";
  return `${subjectCode}_${letter}${yy}_${id.kind}${id.paperRef ? `_${id.paperRef}` : ""}`;
}

/**
 * Look a paper up by its identity: subject, kind, year, series and reference.
 *
 * `.eq(col, null)` is not "is null" in PostgREST: it becomes `col=eq.null`,
 * which matches nothing, so a paper with any empty field was never found and
 * every upload inserted a duplicate.
 */
function paperMatch(admin: ReturnType<typeof adminClient>, subjectCode: string, id: Identity, kind: string) {
  let q = admin.from("papers").select("id")
    .eq("subject_code", subjectCode).eq("kind", kind).eq("paper_ref", id.paperRef ?? "");
  q = id.year == null ? q.is("year", null) : q.eq("year", id.year);
  q = id.session == null ? q.is("session", null) : q.eq("session", id.session);
  return q.limit(1).maybeSingle();
}

async function upsertPaper(
  admin: ReturnType<typeof adminClient>, subjectCode: string, id: Identity,
  paperCode: string, fileName: string | null,
): Promise<string> {
  const row = {
    subject_code: subjectCode, kind: id.kind, year: id.year ?? null,
    session: id.session ?? null, paper_no: id.paperNo ?? null, variant: null,
    paper_ref: id.paperRef ?? "", tier: id.tier ?? null,
    title: [id.subjectName, id.session && id.year ? `${id.session} ${id.year}` : id.year,
      id.paperRef ? `Paper ${id.paperRef}` : null].filter(Boolean).join(" · "),
    code: paperCode, source_url: fileName, ingested_at: new Date().toISOString(),
  };
  const { data: existing } = await paperMatch(admin, subjectCode, id, id.kind);
  if (existing) {
    const { error } = await admin.from("papers").update(row).eq("id", existing.id);
    if (error) throw new Error(`Could not update that paper: ${error.message}`);
    return existing.id;
  }
  const { data, error } = await admin.from("papers").insert(row).select("id").single();
  if (error) throw new Error(`Could not save that paper: ${error.message}`);
  return data.id;
}

/**
 * Replace a paper's chunks of one kind, keeping the ids of those that stay.
 * See the note where it is called: ids matter to every student's history.
 */
async function replaceChunks(
  admin: ReturnType<typeof adminClient>, paperId: string, kind: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await admin.from("chunks")
      .upsert(rows.slice(i, i + 100), { onConflict: "paper_id,kind,question_no" });
    if (error) throw new Error(`Could not save those questions: ${error.message}`);
  }
  const keep = new Set(rows.map((r) => String(r.question_no)));
  const { data: existing } = await admin.from("chunks")
    .select("id,question_no").eq("paper_id", paperId).eq("kind", kind);
  const stale = (existing ?? []).filter((c) => !keep.has(String(c.question_no))).map((c) => c.id);
  for (let i = 0; i < stale.length; i += 100) {
    await admin.from("chunks").delete().in("id", stale.slice(i, i + 100));
  }
}

/** Mark schemes already attached to this paper's questions, by question number. */
async function loadExistingMarkSchemes(
  admin: ReturnType<typeof adminClient>, paperId: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const { data } = await admin.from("chunks")
    .select("question_no,ms_content").eq("paper_id", paperId).not("ms_content", "is", null);
  for (const row of data ?? []) map.set(key(row.question_no), row.ms_content);
  return map;
}

/**
 * Mark-scheme rows waiting for their question paper, keyed by question number.
 * Held as a `markscheme` chunk so nothing is lost when the files arrive in the
 * order the student happened to pick them.
 */
async function loadPendingMarkScheme(
  admin: ReturnType<typeof adminClient>, subjectCode: string, id: Identity,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const { data: msPaper } = await paperMatch(admin, subjectCode, id, "ms");
  if (!msPaper) return map;
  const { data } = await admin.from("chunks")
    .select("question_no,content").eq("paper_id", msPaper.id).eq("kind", "markscheme");
  for (const row of data ?? []) map.set(key(row.question_no), row.content);
  return map;
}

/** Store a mark scheme and fill in any question paper already ingested. */
async function attachMarkScheme(
  admin: ReturnType<typeof adminClient>, subjectCode: string, id: Identity,
  rows: { questionNo: string; text: string; marks?: number | null }[],
): Promise<number> {
  const msPaperId = await upsertPaper(admin, subjectCode, id, buildCode(subjectCode, id), null);

  const clean = (rows ?? []).filter((r) => r.questionNo && r.text?.trim());
  await replaceChunks(admin, msPaperId, "markscheme", clean.map((r) => ({
    paper_id: msPaperId, subject_code: subjectCode, kind: "markscheme",
    paper_code: buildCode(subjectCode, id), year: id.year ?? null, session: id.session ?? null,
    paper_no: id.paperNo ?? null, variant: null, paper_ref: id.paperRef ?? "", tier: id.tier ?? null,
    question_no: r.questionNo, marks: r.marks ?? null, content: r.text.trim(),
  })));

  // Now fill in the question paper, if it is already here.
  const { data: qpPaper } = await paperMatch(admin, subjectCode, { ...id, kind: "qp" }, "qp");
  if (!qpPaper) return 0;

  const { data: questions } = await admin.from("chunks")
    .select("id,question_no").eq("paper_id", qpPaper.id).eq("kind", "question");

  const byKey = new Map(clean.map((r) => [key(r.questionNo), r.text.trim()]));
  let attached = 0;
  for (const q of questions ?? []) {
    const ms = byKey.get(key(q.question_no));
    if (!ms) continue;
    const { error } = await admin.from("chunks").update({ ms_content: ms }).eq("id", q.id);
    if (!error) attached++;
  }
  return attached;
}
