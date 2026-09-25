/**
 * POST /functions/v1/mark-paper: mark a whole past paper from photos.
 * 1. Read: images go to Gemini once, returning the paper's identity and the
 *    answers by question number.
 * 2. Mark: the text is marked in small batches against the stored schemes.
 * A question with no scheme is reported unmarkable, never guessed.
 *
 * Body: { subject, files: [{ mimeType, data }], paperId? }
 */

import { preflight, fail, json } from "../_shared/http.ts";
import { requireUser, adminClient } from "../_shared/db.ts";
import { claim, release, QuotaExceeded } from "../_shared/quota.ts";
import { generateJSON } from "../_shared/gemini.ts";
import { readFiles, validate, type Attachment } from "../_shared/files.ts";
import { MARK_SYSTEM } from "../_shared/prompts.ts";

const TRANSCRIBE_SYSTEM = `
You read a student's completed exam paper from photographs or a scan, and
report both which paper it is and what they wrote.

Identifying the paper:
- Read the printed header or cover of a Pearson Edexcel International GCSE
  paper. paperRef is the paper reference EXACTLY as printed, letters included:
  "Paper Reference 4PH1/1P" gives "1P", "4MA1/2H" gives "2H", "4PH1/1PR" gives
  "1PR". Never reduce it to a number: 1F and 1H are different papers, and so
  are 1P and 1PR.
- session is the exam series: Jan for January, Jun for May/June, Nov for
  October/November. The cover prints a date ("Wednesday 15 May 2024"), so work
  the series out from the month if it is not named. year is the year of that date.
- Report only what is printed; use null for anything you cannot see.

Transcribing the answers:

- One entry per question the student attempted, in the order they appear.
- questionNo is the number the student wrote against the answer: "4", "4(b)",
  "4(b)(ii)". Copy the paper's numbering exactly.
- answer is what they wrote, TRANSCRIBED VERBATIM: including working,
  crossings-out that are still legible, units and wrong answers. You are not
  correcting or improving it; a transcription that tidies up the student's
  mistakes gets them marks they did not earn.
- Transcribe mathematics linearly: x^2, 3/4, 5.2 x 10^-3.
- If a question is clearly left blank, leave it out entirely.
- If handwriting is genuinely illegible, transcribe what you can and put
  [illegible] where it is not.
`.trim();

const TRANSCRIBE_SCHEMA = {
  type: "object",
  properties: {
    paper: {
      type: "object",
      properties: {
        year: { type: "number", nullable: true },
        session: { type: "string", nullable: true, enum: ["Jan", "Jun", "Nov"] },
        paperNo: { type: "number", nullable: true },
        variant: { type: "number", nullable: true },
        paperRef: { type: "string", nullable: true },
      },
    },
    answers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          questionNo: { type: "string" },
          answer: { type: "string" },
        },
        required: ["questionNo", "answer"],
      },
    },
  },
  required: ["answers"],
} as const;

const BATCH_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          questionNo: { type: "string" },
          awarded: { type: "number" },
          breakdown: {
            type: "array",
            items: {
              type: "object",
              properties: {
                point: { type: "string" },
                earned: { type: "boolean" },
                why: { type: "string" },
              },
              required: ["point", "earned", "why"],
            },
          },
          feedback: { type: "string" },
        },
        required: ["questionNo", "awarded", "breakdown", "feedback"],
      },
    },
  },
  required: ["results"],
} as const;

const BATCH_SIZE = 5;
const key = (n: string) => String(n ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

interface Question {
  id: string; question_no: string; marks: number | null;
  content: string; ms_content: string | null; topic: string | null;
}

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

  let body: { subject?: string; paperId?: string; files?: Attachment[] };
  try {
    body = await req.json();
  } catch {
    return fail(req, "Invalid request.");
  }
  if (!body.subject) return fail(req, "Choose a subject.");
  const invalid = validate(body.files ?? []);
  if (invalid) return fail(req, invalid);

  try {
    await claim(user, "markpaper");
  } catch (e) {
    if (e instanceof QuotaExceeded) return fail(req, e.message, 429);
    throw e;
  }

  const admin = adminClient();

  // ---- 1. read: which paper is this, and what did they write? -------------
  interface Read {
    paper?: { year?: number | null; session?: string | null; paperNo?: number | null; variant?: number | null; paperRef?: string | null };
    answers: { questionNo: string; answer: string }[];
  }
  let read: Read;
  try {
    read = await readFiles<Read>(
      body.files!,
      "This is a student's completed exam paper. Identify which paper it is, and transcribe their answers.",
      TRANSCRIBE_SCHEMA as unknown as Record<string, unknown>,
      { system: TRANSCRIBE_SYSTEM },
    );
  } catch (e) {
    await release(user, "markpaper");
    return fail(req, e instanceof Error ? e.message : "Could not read that paper.", 502);
  }
  const transcribed = (read.answers ?? []).filter((a) => a.answer?.trim());

  // ---- 2. match it to a paper we hold -------------------------------------
  const { data: candidates } = await admin.from("papers")
    .select("id,subject_code,title,code,year,session,paper_no,variant,paper_ref,tier,total_marks")
    .eq("subject_code", body.subject).eq("kind", "qp");

  const held = candidates ?? [];
  if (!held.length) {
    await release(user, "markpaper");
    return json(req, {
      error: "no_papers",
      message: "No papers have been added for this subject yet. Add the question paper and its mark scheme under Your papers first.",
    }, 409);
  }

  const paper = body.paperId
    ? held.find((p) => p.id === body.paperId)
    : matchPaper(held, read.paper ?? {});

  if (!paper) {
    await release(user, "markpaper");
    const wanted = describe(read.paper ?? {});
    return json(req, {
      error: "paper_not_held",
      message: `That looks like ${wanted}, which hasn't been added yet. Add its question paper and mark scheme under Your papers, then try again.`,
      available: held.map((p) => p.title).slice(0, 8),
    }, 409);
  }

  const { data: qData } = await admin.from("chunks")
    .select("id,question_no,marks,content,ms_content,topic")
    .eq("paper_id", paper.id).eq("kind", "question");

  const questions = (qData ?? []) as Question[];
  if (!questions.length) {
    await release(user, "markpaper");
    return fail(req, "That paper has no questions stored.", 409);
  }

  questions.sort((a, b) => naturalOrder(a.question_no, b.question_no));

  if (!transcribed.length) {
    await release(user, "markpaper");
    return json(req, {
      error: "no_answers",
      message: "No answers could be read from those images. Try clearer, closer photos of each page.",
    }, 422);
  }

  const written = new Map(transcribed.map((a) => [key(a.questionNo), a.answer.trim()]));

  /**
   * The student's answer for a part. One answer written against 4(b) is used for
   * 4(b)(i) and (ii) too; each is still marked against its own scheme.
   */
  const answerOf = (questionNo: string): string | null => {
    let n = String(questionNo ?? "");
    for (;;) {
      const hit = written.get(key(n));
      if (hit) return hit;
      const shorter = n.replace(/\([^)]*\)\s*$/, "");
      if (shorter === n || !shorter) return null;
      n = shorter;
    }
  };

  // ---- 2. mark, in batches ------------------------------------------------
  const attempted = questions.filter((q) => answerOf(q.question_no) !== null);
  const markable = attempted.filter((q) => q.ms_content);
  const results = new Map<string, { awarded: number; breakdown: unknown[]; feedback: string }>();
  let batchesRun = 0;
  let batchesFailed = 0;

  for (let i = 0; i < markable.length; i += BATCH_SIZE) {
    const batch = markable.slice(i, i + BATCH_SIZE);
    batchesRun++;
    const prompt = batch.map((q) => [
      `QUESTION ${q.question_no} (${q.marks ?? 0} marks)`,
      q.content,
      `MARK SCHEME:`,
      q.ms_content,
      `STUDENT ANSWER:`,
      answerOf(q.question_no),
    ].join("\n")).join("\n\n---\n\n");

    try {
      const out = await generateJSON<{ results: { questionNo: string; awarded: number; breakdown: unknown[]; feedback: string }[] }>(
        `Mark each of these answers against its own mark scheme.\n\n${prompt}`,
        BATCH_SCHEMA as unknown as Record<string, unknown>,
        { system: MARK_SYSTEM, temperature: 0, maxOutputTokens: 8192 },
      );
      for (const r of out.results ?? []) {
        results.set(key(r.questionNo), {
          awarded: Number(r.awarded) || 0,
          breakdown: r.breakdown ?? [],
          feedback: r.feedback ?? "",
        });
      }
    } catch (e) {
      console.error(`batch ${i} failed:`, e);
      batchesFailed++;
      // One bad batch must not lose the rest of the paper.
    }
  }

  // Every batch failed: refund rather than bill a paper of zeros.
  if (batchesRun > 0 && batchesFailed === batchesRun) {
    await release(user, "markpaper");
    return fail(req, "Marking is unavailable right now. Your photos were not used up: try again shortly.", 502);
  }
  // Nothing had a mark scheme, so nothing was marked: return the result, don't charge for it.
  if (batchesRun === 0) await release(user, "markpaper");

  // ---- assemble -----------------------------------------------------------
  let awarded = 0;
  let total = 0;
  const perQuestion = questions.map((q) => {
    const answer = answerOf(q.question_no) ?? null;
    const marked = results.get(key(q.question_no));
    const cap = q.marks ?? 0;
    total += cap;

    // Clamped: a marking tool that can award 9/6 is worse than useless.
    const got = marked ? Math.max(0, Math.min(cap, marked.awarded)) : 0;
    if (marked) awarded += got;

    return {
      chunkId: q.id,
      questionNo: q.question_no,
      marks: cap,
      topic: q.topic,
      question: q.content,
      markScheme: q.ms_content,
      answer,
      awarded: marked ? got : null,
      breakdown: marked?.breakdown ?? [],
      feedback: marked?.feedback ?? "",
      status: !answer ? "blank" : !q.ms_content ? "no_markscheme" : marked ? "marked" : "failed",
    };
  });

  const pct = total ? Math.round((awarded / total) * 100) : 0;
  let grade: string | null = null;
  try {
    const { data } = await admin.rpc("predict_grade", {
      p_subject: paper.subject_code,
      p_paper_ref: paper.paper_ref ?? "",
      p_pct: pct,
      p_tier: paper.tier ?? null,
      p_year: paper.year ?? null,
      p_session: paper.session ?? null,
    });
    grade = (data as string | null) ?? null;
  } catch { /* boundaries are optional */ }

  // ---- record, so Progress and the weak-topic profile learn from it -------
  const rows = perQuestion
    .filter((q) => q.status === "marked")
    .map((q) => ({
      chunk_id: q.chunkId,
      subject_code: paper.subject_code,
      question_ref: `${paper.code ?? paper.title} Q${q.questionNo}`,
      question_text: q.question,
      answer_text: q.answer,
      awarded: q.awarded,
      total: q.marks,
      breakdown: q.breakdown,
      topic: q.topic,
    }));
  if (rows.length) {
    const { error } = await user.db.from("attempts").insert(rows);
    if (error) console.error("attempts insert failed:", error.message);
  }

  // Save the whole result too, or a refresh loses it.
  const summary = {
    paper_id: paper.id,
    subject_code: paper.subject_code,
    title: paper.title,
    awarded,
    total,
    pct,
    grade,
    answered: attempted.length,
    marked: rows.length,
    unmarkable: perQuestion.filter((q) => q.status === "no_markscheme").length,
    questions: perQuestion,
  };

  let attemptId: string | null = null;
  const { data: savedPaper, error: saveError } = await user.db
    .from("paper_attempts").insert(summary).select("id").single();
  if (saveError) console.error("paper_attempts insert failed:", saveError.message);
  else attemptId = savedPaper.id;

  return json(req, {
    id: attemptId,
    paper: { id: paper.id, title: paper.title, code: paper.code, subject: paper.subject_code },
    awarded,
    total,
    pct,
    grade,
    answered: attempted.length,
    marked: rows.length,
    unmarkable: summary.unmarkable,
    questions: perQuestion,
  });
});

interface HeldPaper {
  id: string; subject_code: string; title: string; code: string | null;
  year: number | null; session: string | null; paper_no: number | null; variant: number | null;
  paper_ref?: string | null; tier?: string | null; total_marks?: number | null;
}

/**
 * Which stored paper is this? Scored, because a photographed cover rarely shows
 * every field. A candidate that contradicts anything we did read is out.
 */
function matchPaper(
  held: HeldPaper[],
  want: {
    year?: number | null; session?: string | null; paperNo?: number | null;
    variant?: number | null; paperRef?: string | null;
  },
): HeldPaper | null {
  // A reference read off the cover is decisive: 1H and 1F sit the same day.
  const ref = want.paperRef?.trim().toUpperCase();
  if (ref) {
    const sameRef = held.filter((p) => (p.paper_ref ?? "").toUpperCase() === ref);
    const fits = sameRef.filter((p) =>
      (want.year == null || p.year === want.year) &&
      (want.session == null || p.session === want.session)
    );
    if (fits.length === 1) return fits[0];
    return null;   // several series fit, or the reference read is not one we hold
  }

  const known = [want.year, want.session, want.paperNo].filter((v) => v != null).length;
  if (known === 0) return held.length === 1 ? held[0] : null;

  let bestScore = 0;
  let best: HeldPaper[] = [];

  for (const p of held) {
    let score = 0;
    if (want.year != null) {
      if (p.year !== want.year) continue;
      score += 3;
    }
    if (want.paperNo != null) {
      if (p.paper_no !== want.paperNo) continue;
      score += 3;
    }
    if (want.session != null) {
      if (p.session !== want.session) continue;
      score += 2;
    }
    if (want.variant != null && p.variant === want.variant) score += 1;

    if (score > bestScore) {
      bestScore = score;
      best = [p];
    } else if (score === bestScore && score > 0) {
      best.push(p);
    }
  }
  // Two fields must agree and exactly one paper fit; a 1F/1H tie is not a match.
  return bestScore >= 5 && best.length === 1 ? best[0] : null;
}

function describe(p: {
  year?: number | null; session?: string | null; paperNo?: number | null;
  variant?: number | null; paperRef?: string | null;
}): string {
  const bits = [
    p.session && p.year ? `${p.session} ${p.year}` : p.year ? String(p.year) : null,
    p.paperRef ? `Paper ${p.paperRef}` : p.paperNo ? `Paper ${p.paperNo}${p.variant ?? ""}` : null,
  ].filter(Boolean);
  return bits.length ? bits.join(" ") : "a paper we could not identify";
}

/** 2 before 10, and 4(b) before 4(b)(ii). */
function naturalOrder(a: string, b: string): number {
  const parse = (s: string) => {
    const m = String(s ?? "").match(/^(\d+)\s*\(?([a-h])?\)?\s*\(?((?:i|v|x)+)?\)?/i);
    return [Number(m?.[1] ?? 0), m?.[2] ?? "", m?.[3] ?? ""];
  };
  const [an, ap, as_] = parse(a);
  const [bn, bp, bs] = parse(b);
  if (an !== bn) return (an as number) - (bn as number);
  if (ap !== bp) return String(ap).localeCompare(String(bp));
  return String(as_).localeCompare(String(bs));
}
