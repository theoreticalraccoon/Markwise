/**
 * POST /functions/v1/mark-mock
 *
 * Marks a whole mock paper in one budgeted request.
 *
 * The client used to loop over the questions and call /mark once each. That
 * was wrong twice over:
 *
 *   - Budget. Each call claimed one "mark" allowance, so sitting a twelve
 *     question paper spent twelve of a forty-a-day cap, and a student who ran
 *     out halfway had the rest of their paper silently scored zero.
 *   - Latency. Twelve sequential Gemini round trips on a free tier is minutes
 *     of staring at a spinner.
 *
 * One claim covers the paper. Questions are marked in batches of five, the
 * same size mark-paper uses, because a whole paper in one response runs out of
 * output tokens halfway down and returns truncated JSON.
 *
 * Every question is still marked against its own stored mark scheme, which was
 * captured verbatim into the mock when it was generated. A question with no
 * scheme is reported unmarkable rather than guessed at.
 *
 * Body: { mockId, answers: { "<question n>": "<what they wrote>" } }
 */

import { preflight, fail, json } from "../_shared/http.ts";
import { requireUser } from "../_shared/db.ts";
import { claim, release, QuotaExceeded } from "../_shared/quota.ts";
import { generateJSON } from "../_shared/gemini.ts";
import { MARK_SYSTEM } from "../_shared/prompts.ts";

const BATCH_SIZE = 5;

const BATCH_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          n: { type: "number" },
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
          missed: { type: "array", items: { type: "string" } },
          modelAnswer: { type: "string" },
          feedback: { type: "string" },
        },
        required: ["n", "awarded", "breakdown", "feedback"],
      },
    },
  },
  required: ["results"],
} as const;

interface MockQuestion {
  n: number;
  chunkId: string;
  text: string;
  markScheme: string | null;
  marks: number;
  paperRef?: string;
  paperCode?: string | null;
  paperReference?: string | null;
  topic?: string | null;
}

interface Marked {
  n: number;
  awarded: number;
  breakdown: { point: string; earned: boolean; why: string }[];
  missed?: string[];
  modelAnswer?: string;
  feedback: string;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return fail(req, "POST only", 405);

  let user;
  try {
    user = await requireUser(req);
  } catch {
    return fail(req, "Sign in to use Markwise AI.", 401);
  }

  let body: { mockId?: string; answers?: Record<string, string> };
  try {
    body = await req.json();
  } catch {
    return fail(req, "Invalid JSON body.");
  }
  if (!body.mockId) return fail(req, "Which mock?");

  // Read through the user client, so RLS proves this mock is theirs.
  const { data: mock, error: mockError } = await user.db
    .from("mocks").select("*").eq("id", body.mockId).maybeSingle();
  if (mockError) return fail(req, `Could not load that mock: ${mockError.message}`, 500);
  if (!mock) return fail(req, "That mock no longer exists.", 404);
  if (mock.status === "marked") return fail(req, "That mock has already been marked.", 409);

  const questions = (mock.questions ?? []) as MockQuestion[];
  if (!questions.length) return fail(req, "That mock has no questions.", 409);

  const answers = body.answers ?? {};
  const answered = questions.filter((q) => (answers[String(q.n)] ?? "").trim());
  if (!answered.length) {
    return json(req, {
      error: "no_answers",
      message: "Nothing was written on this paper, so there is nothing to mark.",
    }, 422);
  }

  try {
    await claim(user, "markmock");
  } catch (e) {
    if (e instanceof QuotaExceeded) return fail(req, e.message, 429);
    throw e;
  }

  // ---- mark, in batches ----------------------------------------------------
  const markable = answered.filter((q) => q.markScheme);
  const results = new Map<number, Marked>();
  let batchesFailed = 0;
  let batchesRun = 0;

  for (let i = 0; i < markable.length; i += BATCH_SIZE) {
    const batch = markable.slice(i, i + BATCH_SIZE);
    batchesRun++;
    const prompt = batch.map((q) => [
      `QUESTION n=${q.n} (${q.marks} marks)`,
      q.text,
      `MARK SCHEME:`,
      q.markScheme,
      `STUDENT ANSWER:`,
      (answers[String(q.n)] ?? "").trim(),
    ].join("\n")).join("\n\n---\n\n");

    try {
      const out = await generateJSON<{ results: Marked[] }>(
        `Mark each of these answers against its own mark scheme. Echo each question's n exactly.\n\n${prompt}`,
        BATCH_SCHEMA as unknown as Record<string, unknown>,
        { system: MARK_SYSTEM, temperature: 0, maxOutputTokens: 8192 },
      );
      for (const r of out.results ?? []) {
        if (typeof r.n === "number") results.set(r.n, r);
      }
    } catch (e) {
      // One bad batch must not lose the other ten questions.
      console.error(`mark-mock batch ${i} failed:`, e);
      batchesFailed++;
    }
  }

  // Every batch failed: the student got nothing, so give the allowance back.
  if (batchesRun > 0 && batchesFailed === batchesRun) {
    await release(user, "markmock");
    return fail(req, "Marking is unavailable right now. Your answers are saved: try again shortly.", 502);
  }

  // ---- assemble ------------------------------------------------------------
  let awarded = 0;
  const marked = questions.map((q) => {
    const answer = (answers[String(q.n)] ?? "").trim();
    const r = results.get(q.n);
    const cap = q.marks ?? 0;
    // Clamped: a marking tool that can award 9/6 is worse than useless.
    const got = r ? Math.max(0, Math.min(cap, Number(r.awarded) || 0)) : 0;
    if (r) awarded += got;

    return {
      ...q,
      result: {
        n: q.n,
        awarded: r ? got : 0,
        total: cap,
        questionRef: q.paperRef ?? null,
        topic: q.topic ?? null,
        breakdown: r?.breakdown ?? [],
        missed: r?.missed ?? [],
        modelAnswer: r?.modelAnswer ?? "",
        feedback: r?.feedback ?? "",
        blank: !answer,
        error: !answer
          ? null
          : !q.markScheme
          ? "No mark scheme is stored for this question, so it was not marked."
          : r
          ? null
          : "Marking failed for this question.",
      },
    };
  });

  const total = mock.total_marks || questions.reduce((n, q) => n + (q.marks ?? 0), 0);
  const pct = total ? Math.round((awarded / total) * 100) : 0;

  // ---- record each answer, so Progress learns from the paper ---------------
  const attemptRows = marked
    .filter((q) => q.result.breakdown.length && !q.result.blank)
    .map((q) => ({
      chunk_id: q.chunkId,
      mock_id: mock.id,
      subject_code: mock.subject_code,
      question_ref: q.paperRef ?? `Mock Q${q.n}`,
      question_text: q.text,
      answer_text: (answers[String(q.n)] ?? "").trim(),
      awarded: q.result.awarded,
      total: q.result.total,
      breakdown: q.result.breakdown,
      missed: q.result.missed ?? [],
      topic: q.topic ?? null,
      model_answer: q.result.modelAnswer || null,
    }));
  // ---- predicted grade -----------------------------------------------------
  //
  // A mock is drawn from questions across many papers, and boundaries belong to
  // one paper. A percentage of a collage graded against one paper's boundaries
  // means nothing, so a grade is only given when EVERY question came from the
  // same paper, and it is given as an estimate.
  let grade: string | null = null;
  const codes = new Set(questions.map((q) => q.paperCode).filter(Boolean));
  const ref = questions.find((q) => q.paperReference)?.paperReference ?? null;
  if (codes.size === 1 && ref) {
    try {
      const { data } = await user.db.rpc("predict_grade", {
        p_subject: mock.subject_code,
        p_paper_ref: ref,
        p_pct: pct,
        p_tier: /[FH]$/.test(ref) ? ref.slice(-1) : null,
        p_year: mock.year ?? null,
        p_session: null,
      });
      grade = (data as string | null) ?? null;
    } catch { /* boundaries are optional */ }
  }

  // Save the result FIRST, and only if nobody else has marked this mock in the
  // meantime. Two simultaneous submits used to both mark it and both write the
  // attempts, so every topic's mastery counted the paper twice.
  const { data: saved, error: updateError } = await user.db.from("mocks").update({
    status: "marked",
    submitted_at: new Date().toISOString(),
    awarded,
    grade,
    questions: marked,
  }).eq("id", mock.id).neq("status", "marked").select("id");
  if (updateError) {
    await release(user, "markmock");
    return fail(req, `Could not save your result: ${updateError.message}`, 500);
  }
  if (!saved?.length) {
    await release(user, "markmock");
    return fail(req, "That mock has already been marked.", 409);
  }

  if (attemptRows.length) {
    const { error } = await user.db.from("attempts").insert(attemptRows);
    if (error) console.error("mock attempts insert failed:", error.message);
  }

  return json(req, {
    id: mock.id,
    awarded,
    total,
    pct,
    grade,
    marked: attemptRows.length,
    unmarkable: answered.filter((q) => !q.markScheme).length,
    failed: marked.filter((q) => q.result.error).length,
  });
});
