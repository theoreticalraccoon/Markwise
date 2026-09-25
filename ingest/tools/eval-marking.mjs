/**
 * Marking calibration check against the deployed /mark function.
 *
 * For a fixed sample of real questions it submits three answers each:
 *   none     "I don't know." (should score 0). The reply includes the marker's
 *            own model answer, which the next two conditions reuse.
 *   ideal    that model answer (should score full marks)
 *   partial  the first half of it (should score in between)
 * Pasting the mark scheme itself is deliberately not used: the marker treats a
 * copied scheme as no working and awards nothing, which is the right call.
 * This is a sanity check on calibration, not agreement with a human examiner.
 * Uses one throwaway user (removed afterwards) and noRecord, so no attempts are saved.
 * Costs 3 Gemini calls per question.
 *
 *   node --env-file=.env tools/eval-marking.mjs [--n 8] [--out file.json]
 */
import { createClient } from "@supabase/supabase-js";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { db } from "../lib/db.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
const N = Number(flag("n", 8));
const OUT = flag("out", null);
const ANON = "sb_publishable_q9kbWXGMCrLKmg-1aqBCMQ_k-i2CR77";
const FN = `${process.env.SUPABASE_URL}/functions/v1/mark`;
const SUBJECTS = ["E-4PH1", "E-4CH1", "E-4BI1", "E-4MA1", "E-4EC1", "E-4GE1", "E-4BS1", "E-4CP0"];

// One question per subject: the first 3-5 mark part with a usable scheme.
const sample = [];
for (const subject of SUBJECTS.slice(0, N)) {
  const { data } = await db.from("chunks")
    .select("id,subject_code,paper_code,question_no,marks,content,ms_content")
    .eq("subject_code", subject).eq("kind", "question")
    .gte("marks", 3).lte("marks", 5).not("ms_content", "is", null)
    .order("id").limit(50);
  const pick = (data ?? []).find((c) => c.ms_content.length > 80 && c.ms_content.length < 1500);
  if (pick) sample.push(pick);
}

// The first half of an answer, by words (model answers are often one paragraph).
const halfOf = (text) => {
  const words = text.split(/\s+/).filter(Boolean);
  return words.slice(0, Math.max(1, Math.floor(words.length / 2))).join(" ");
};

const email = `marking-eval-${Date.now()}@example.com`;
const password = crypto.randomUUID();
const { data: created, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
if (error) throw error;

const results = [];
try {
  const client = createClient(process.env.SUPABASE_URL, ANON, { auth: { persistSession: false } });
  const { data: s, error: signError } = await client.auth.signInWithPassword({ email, password });
  if (signError) throw signError;
  const headers = { Authorization: `Bearer ${s.session.access_token}`, apikey: ANON, "Content-Type": "application/json" };

  for (const q of sample) {
    const row = { subject: q.subject_code.replace(/^E-/, ""), paper: q.paper_code, question: q.question_no, marks: q.marks };
    const mark = async (answer) => {
      const res = await fetch(FN, {
        method: "POST", headers, signal: AbortSignal.timeout(120000),
        body: JSON.stringify({ chunkId: q.id, subject: q.subject_code, answer, noRecord: true }),
      });
      const body = await res.json().catch(() => ({}));
      return res.ok ? body : { error: `HTTP ${res.status}: ${body.error ?? body.message ?? ""}` };
    };
    const blank = await mark("I don't know.");
    row.none = blank.error ?? blank.awarded;
    const ideal = (blank.modelAnswer ?? "").trim();
    if (ideal) {
      const full = await mark(ideal);
      row.ideal = full.error ?? full.awarded;
      const half = await mark(halfOf(ideal));
      row.partial = half.error ?? half.awarded;
      row.modelAnswer = ideal.slice(0, 400);
    } else row.ideal = row.partial = "no model answer returned";
    results.push(row);
    console.log(JSON.stringify(row));
  }
} finally {
  await db.auth.admin.deleteUser(created.user.id);
}

const ok = results.filter((r) => [r.ideal, r.partial, r.none].every((v) => typeof v === "number"));
const avg = (k) => ok.length ? +(ok.reduce((n, r) => n + r[k] / r.marks, 0) / ok.length * 100).toFixed(1) : null;
const summary = {
  generated: new Date().toISOString(),
  questions: results.length,
  scored: ok.length,
  meanPctAwarded: { ideal: avg("ideal"), partial: avg("partial"), none: avg("none") },
  fullMarksForIdealAnswer: ok.filter((r) => r.ideal === r.marks).length,
  zeroForNoAnswer: ok.filter((r) => r.none === 0).length,
  orderedIdealOverPartialOverNone: ok.filter((r) => r.ideal >= r.partial && r.partial >= r.none).length,
};
console.log(JSON.stringify(summary, null, 2));
if (OUT) await writeFile(resolve(OUT), JSON.stringify({ ...summary, results }, null, 2));
