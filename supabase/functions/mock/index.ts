/**
 * POST /functions/v1/mock
 *
 * Builds a mock paper out of real past questions.
 *
 * The important design choice: the model never emits question text. It is
 * given a candidate pool (id, marks, topic, first line) and returns an ordered
 * list of ids plus a title and rubric. The server then reconstitutes each
 * question verbatim from the database. A model that can rewrite a question can
 * rewrite it wrong, and a mock paper made of subtly-wrong questions is worse
 * than no mock paper at all.
 *
 * Selection is SQL-side and can be biased to the student's weak topics, which
 * is what turns "generate a mock" into "generate the mock I actually need".
 *
 * Body: { subject, marks?, topics?, weakFirst?, durationMin?, paperNo? }
 */

import { preflight, fail, json } from "../_shared/http.ts";
import { requireUser, adminClient } from "../_shared/db.ts";
import { claim, release, QuotaExceeded } from "../_shared/quota.ts";
import { generateJSON } from "../_shared/gemini.ts";
import { label, type Chunk } from "../_shared/retrieve.ts";
import { MOCK_SYSTEM } from "../_shared/prompts.ts";

interface Body {
  subject: string;
  marks?: number;
  topics?: string[];
  weakFirst?: boolean;
  durationMin?: number;
  title?: string;
  /** "H" or "F": draw only from that tier's papers. */
  tier?: string;
  /** Draw only from one paper, e.g. "1H". */
  paperRef?: string;
}

/** The model orders and titles; it does not author. */
const PLAN_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    instructions: { type: "string" },
    order: {
      type: "array",
      items: { type: "string" },
      description: "Candidate ids, in the order they should appear on the paper.",
    },
  },
  required: ["title", "instructions", "order"],
} as const;

interface Plan {
  title: string;
  instructions: string;
  order: string[];
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

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return fail(req, "Invalid JSON body.");
  }

  const subject = (body.subject ?? "").trim();
  if (!subject) return fail(req, "Pick a subject.");

  const targetMarks = clamp(body.marks ?? 40, 10, 120);

  try {
    await claim(user, "mock");
  } catch (e) {
    if (e instanceof QuotaExceeded) return fail(req, e.message, 429);
    throw e;
  }

  const admin = adminClient();

  // ---- choose the topic mix ----------------------------------------------
  let topics = body.topics?.filter(Boolean) ?? [];
  if (body.weakFirst) {
    const { data } = await user.db.rpc("weak_topics", { p_subject: subject, p_limit: 5 });
    const weak = ((data ?? []) as { topic: string }[]).map((r) => r.topic);
    topics = [...new Set([...topics, ...weak])];
  }

  // ---- pull a candidate pool ---------------------------------------------
  // Over-sample: some candidates will be dropped to hit the mark target. A
  // hundred-mark paper needs a bigger pool than a ten-mark quiz.
  const tier = body.tier === "H" || body.tier === "F" ? body.tier : null;
  const paperRef = body.paperRef?.trim() || null;
  const limit = Math.min(120, Math.max(40, targetMarks * 2));

  const sample = async (topicList: string[] | null, textOnly: boolean): Promise<Chunk[]> => {
    const { data, error } = await admin.rpc("sample_questions", {
      p_subject: subject,
      p_topics: topicList,
      p_limit: limit,
      p_min_marks: 1,
      p_max_marks: 20,
      p_tier: tier,
      p_paper_ref: paperRef,
      // Questions that lean on a figure are unanswerable as plain text, so they
      // are left out unless the subject has too little else to build a paper.
      p_no_figure: textOnly,
    });
    if (error) throw new Error(`Could not sample questions: ${error.message}`);
    return (data ?? []) as Chunk[];
  };

  let pool: Chunk[];
  try {
    pool = await sample(topics.length ? topics : null, true);
    // Asking for weak topics only works once there is a corpus for them; widen
    // rather than returning an empty paper.
    if (pool.length < 4 && topics.length) pool = await sample(null, true);
    if (pool.length < 4) pool = await sample(null, false);
  } catch (e) {
    await release(user, "mock");
    return fail(req, e instanceof Error ? e.message : "Could not sample questions.", 502);
  }

  if (pool.length === 0) {
    await release(user, "mock");
    return json(req, {
      error: "empty_corpus",
      message: `There are no questions with a stored mark scheme for this subject yet, so a paper cannot be built. Add some past papers first.`,
    }, 409);
  }

  // ---- fit the mark budget ------------------------------------------------
  const selected = fitToMarks(pool, targetMarks);
  const totalMarks = selected.reduce((n, c) => n + (c.marks ?? 0), 0);

  // ---- let the model sequence it -----------------------------------------
  const candidates = selected.map((c) => ({
    id: c.id,
    marks: c.marks ?? 0,
    topic: c.topic ?? "unclassified",
    command: c.command_word ?? "",
    opening: c.content.replace(/\s+/g, " ").slice(0, 160),
  }));

  let plan: Plan;
  try {
    plan = await generateJSON<Plan>(
      [
        `SUBJECT: ${subject}`,
        `TARGET: ${totalMarks} marks, ${body.durationMin ?? suggestDuration(totalMarks)} minutes.`,
        `CANDIDATES (order these; do not add or invent any):`,
        JSON.stringify(candidates, null, 1),
      ].join("\n\n"),
      PLAN_SCHEMA as unknown as Record<string, unknown>,
      { system: MOCK_SYSTEM, temperature: 0.3, maxOutputTokens: 1200 },
    );
  } catch {
    // Sequencing is a nicety. If the model is unavailable, fall back to the
    // conventional ordering (short recall first) rather than failing the whole
    // request. The questions are the product, not the rubric.
    plan = {
      title: body.title ?? `${subject} mock: ${totalMarks} marks`,
      instructions: defaultRubric(totalMarks, body.durationMin ?? suggestDuration(totalMarks)),
      order: selected.map((c) => c.id),
    };
  }

  // Reconstitute verbatim, honouring the model's order but ignoring anything
  // it invented or dropped.
  const byId = new Map(selected.map((c) => [c.id, c]));
  const ordered: Chunk[] = [];
  for (const id of plan.order ?? []) {
    const c = byId.get(id);
    if (c && !ordered.includes(c)) ordered.push(c);
  }
  for (const c of selected) if (!ordered.includes(c)) ordered.push(c);

  const questions = ordered.map((c, i) => ({
    n: i + 1,
    chunkId: c.id,
    text: c.content,
    markScheme: c.ms_content,
    marks: c.marks ?? 0,
    paperRef: label(c),
    paperCode: c.paper_code,
    // The last part of the paper code is the paper's reference ("E-4PH1_s24_qp_1P" -> "1P").
    paperReference: paperRefOf(c.paper_code),
    paperNo: c.paper_no,
    questionNo: c.question_no,
    topic: c.topic,
    commandWord: c.command_word,
  }));

  const durationMin = body.durationMin ?? suggestDuration(totalMarks);
  const instructions = plan.instructions || defaultRubric(totalMarks, durationMin);

  // Which paper number to predict a grade against. A mock draws from several
  // papers, so the modal paper number is the honest answer: the boundaries of
  // the paper most of these marks actually came from.
  const paperNo = modalPaperNo(ordered);

  // ---- save ---------------------------------------------------------------
  const { data: saved, error: saveError } = await user.db.from("mocks").insert({
    subject_code: subject,
    title: plan.title || `${subject} mock`,
    spec: { topics, targetMarks, weakFirst: !!body.weakFirst },
    questions,
    instructions,
    paper_no: paperNo,
    total_marks: totalMarks,
    duration_min: durationMin,
    status: "ready",
  }).select("id").single();

  if (saveError) {
    await release(user, "mock");
    return fail(req, `Could not save the mock: ${saveError.message}`, 500);
  }

  return json(req, {
    id: saved.id,
    title: plan.title,
    instructions,
    subject,
    totalMarks,
    durationMin,
    paperNo,
    topics,
    questions,
  });
});

/**
 * The paper number most of this mock's marks came from.
 *
 * Grade boundaries are published per paper, so predicting a grade needs one.
 * Taking question 1's paper number, as the client used to, meant a 40-mark
 * paper built mostly from Paper 4 questions could be graded against Paper 2's
 * boundaries because the first short question happened to come from there.
 */
function modalPaperNo(chunks: Chunk[]): number | null {
  const weight = new Map<number, number>();
  for (const c of chunks) {
    if (c.paper_no == null) continue;
    weight.set(c.paper_no, (weight.get(c.paper_no) ?? 0) + (c.marks ?? 0));
  }
  let best: number | null = null;
  let bestWeight = -1;
  for (const [no, w] of weight) {
    if (w > bestWeight) {
      bestWeight = w;
      best = no;
    }
  }
  return best;
}

/* ---------------------------------------------------------------- helpers -- */

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/**
 * A part that cannot stand on its own.
 *
 * "Hence, solve x² + 9x − 22 = 0" is unanswerable without the part above it,
 * and a mock paper that asks it in isolation is not a mock paper. These are
 * dropped rather than reworded: rewording a question is exactly what this
 * route refuses to do.
 */
function dependsOnSibling(c: Chunk): boolean {
  const opening = c.content.replace(/\s+/g, " ").trim().slice(0, 60).toLowerCase();
  return /^(hence|use (your|this) answer|using (your|this|part)|from your answer|write down another|repeat (this|the)|use the (graph|diagram|figure|table|result)|from (part|question)|in part)/
    .test(opening);
}

/**
 * Fit the mark target with a realistic spread of question sizes.
 *
 * Filling greedily from the shortest questions technically hits the target but
 * produces a paper of fifteen one-mark fragments, which tests recall and
 * nothing else. Real papers spend roughly 40% of their marks on short recall,
 * 35% on middling method questions and 25% on extended ones, so marks are
 * drawn from three buckets against that budget.
 */
function fitToMarks(pool: Chunk[], target: number): Chunk[] {
  const usable = pool.filter((c) => (c.marks ?? 0) > 0 && !dependsOnSibling(c));
  if (!usable.length) return pool.slice(0, 1);

  const buckets = [
    { max: 2, share: 0.4, items: [] as Chunk[] },   // short recall
    { max: 4, share: 0.35, items: [] as Chunk[] },  // method
    { max: 99, share: 0.25, items: [] as Chunk[] }, // extended
  ];
  for (const c of usable) {
    (buckets.find((b) => (c.marks ?? 0) <= b.max) ?? buckets[2]).items.push(c);
  }
  for (const b of buckets) b.items.sort(() => Math.random() - 0.5);

  const picked: Chunk[] = [];
  const spent = buckets.map(() => 0);
  let total = 0;

  // Repeatedly draw from whichever bucket is furthest below its share of the
  // target, so the paper stays balanced even when one size is scarce.
  for (let guard = 0; guard < 200 && total < target - 1; guard++) {
    const order = buckets
      .map((b, i) => ({ i, b, deficit: b.share * target - spent[i] }))
      .filter(({ b }) => b.items.length > 0)
      .sort((x, y) => y.deficit - x.deficit);
    if (!order.length) break;

    let placed = false;
    for (const { i, b } of order) {
      const idx = b.items.findIndex((c) => total + (c.marks ?? 0) <= target + 2);
      if (idx < 0) continue;
      const [c] = b.items.splice(idx, 1);
      picked.push(c);
      spent[i] += c.marks ?? 0;
      total += c.marks ?? 0;
      placed = true;
      break;
    }
    if (!placed) break;
  }

  if (!picked.length) picked.push(usable[0]);
  return picked;
}

/** Edexcel papers run at roughly 1.1 minutes a mark (100 marks in 2 hours, 110 in 2). */
function suggestDuration(marks: number): number {
  return Math.max(15, Math.round(marks * 1.1));
}

function defaultRubric(marks: number, minutes: number): string {
  return [
    `Answer all questions.`,
    `The marks for each question are shown in brackets, for example (3).`,
    `Time allowed: ${minutes} minutes. Total: ${marks} marks.`,
  ].join("\n");
}

/** "E-4PH1_s24_qp_1P" -> "1P". Null when the code has no reference part. */
function paperRefOf(code: string | null): string | null {
  const parts = (code ?? "").split("_");
  return parts.length === 4 ? parts[3].toUpperCase() : null;
}
