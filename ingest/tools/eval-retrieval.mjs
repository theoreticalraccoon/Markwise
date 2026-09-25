/**
 * Retrieval evaluation against the live corpus, using the app's own search()
 * from supabase/functions/_shared/retrieve.ts. Two tasks:
 *
 *   exact  "4PH1 June 2024 Paper 1P Q3(b)" must return that exact part first.
 *   paste  a question's own opening text must bring that question back (top 1 / top 5).
 *
 * Paste runs keyword-only by default (no Gemini quota). --hybrid also embeds
 * each query, which costs one embedding call per question.
 *
 *   node tools/eval-retrieval.mjs [--per-subject 6] [--hybrid] [--out file.json]
 */
import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { db } from "../lib/db.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true);
};
const PER_SUBJECT = Number(flag("per-subject", 6));
const HYBRID = !!flag("hybrid", false);
const OUT = flag("out", null);

// Load retrieve.ts the same way the unit tests do. A fake key makes the query
// embedding fail, so search() takes its full-text path.
const compiled = await build({
  entryPoints: [resolve(new URL("../../supabase/functions/_shared/retrieve.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))],
  bundle: true, format: "esm", write: false, logLevel: "silent",
});
const key = HYBRID ? process.env.GEMINI_API_KEYS : "no-quota-for-eval";
globalThis.Deno = { env: { get: (name) => (name === "GEMINI_API_KEYS" ? key : undefined) } };
const { search } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const quiet = console.warn;
console.warn = () => {};

const SESSION = { Jan: "January", Jun: "June", Nov: "November", Mar: "March" };
const { data: subjects } = await db.from("subjects").select("code").eq("board", "Edexcel").eq("active", true);

// Deterministic sample: every nth question part per subject.
const sample = [];
for (const { code } of subjects) {
  const { data } = await db.from("chunks")
    .select("id,subject_code,paper_id,paper_code,session,year,question_no,question_root,content")
    .eq("subject_code", code).eq("kind", "question").not("paper_code", "is", null)
    .order("id").limit(1000);
  const rows = (data ?? []).filter((r) => r.paper_code.split("_").length === 4 && r.year && r.session && r.content?.length > 60);
  const step = Math.max(1, Math.floor(rows.length / PER_SUBJECT));
  for (let i = 0; i < rows.length && sample.filter((s) => s.subject_code === code).length < PER_SUBJECT; i += step) sample.push(rows[i]);
}

const results = [];
for (const c of sample) {
  const code = c.subject_code.replace(/^E-/, "");
  const ref = c.paper_code.split("_")[3].toUpperCase();
  const q = /^\d/.test(c.question_no) ? `Q${c.question_no}` : `Question ${c.question_no}`;
  const exactQuery = `${code} ${SESSION[c.session]} ${c.year} Paper ${ref} ${q}`;
  let exact;
  try {
    const hits = await search(db, exactQuery, { subject: c.subject_code, count: 5 });
    exact = hits.ambiguous?.length ? "ambiguous" : hits[0]?.id === c.id ? "top1" : hits.some((h) => h.id === c.id) ? "top5" : "miss";
  } catch (e) { exact = `error: ${e.message}`; }

  const pasteQuery = c.content.replace(/\s+/g, " ").slice(0, 160);
  let paste;
  try {
    const hits = await search(db, pasteQuery, { subject: c.subject_code, count: 5 });
    const same = (h) => h.id === c.id || (h.paper_id === c.paper_id && h.question_root === c.question_root);
    paste = hits[0]?.id === c.id ? "top1" : hits.slice(0, 5).some((h) => h.id === c.id) ? "top5"
      : hits.slice(0, 5).some(same) ? "sameQuestion" : "miss";
  } catch (e) { paste = `error: ${e.message}`; }

  results.push({ subject: code, paper: c.paper_code, question: c.question_no, exactQuery, exact, paste });
  process.stdout.write(".");
}
console.warn = quiet;
console.log();

const rate = (key, pred) => {
  const n = results.length, k = results.filter((r) => pred(r[key])).length;
  return { hits: k, of: n, pct: n ? +(100 * k / n).toFixed(1) : 0 };
};
const summary = {
  generated: new Date().toISOString(),
  mode: HYBRID ? "hybrid (embedding + full text)" : "full text only (no embedding quota used)",
  sampled: results.length,
  exact: { top1: rate("exact", (v) => v === "top1"), refusedAsAmbiguous: rate("exact", (v) => v === "ambiguous") },
  paste: {
    top1: rate("paste", (v) => v === "top1"),
    top5: rate("paste", (v) => v === "top1" || v === "top5"),
    top5SameQuestion: rate("paste", (v) => v === "top1" || v === "top5" || v === "sameQuestion"),
  },
  bySubject: Object.fromEntries([...new Set(results.map((r) => r.subject))].map((s) => {
    const rs = results.filter((r) => r.subject === s);
    return [s, { n: rs.length, exactTop1: rs.filter((r) => r.exact === "top1").length, pasteTop5: rs.filter((r) => r.paste === "top1" || r.paste === "top5").length }];
  })),
  misses: results.filter((r) => r.exact !== "top1" || !["top1", "top5"].includes(r.paste)),
};
console.log(JSON.stringify({ ...summary, misses: summary.misses.length }, null, 2));
if (OUT) await writeFile(resolve(OUT), JSON.stringify({ ...summary, results }, null, 2));
