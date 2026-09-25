/**
 * Corpus report: per-subject counts for the dataset, read-only.
 * Writes JSON and a Markdown table (default: docs/submission/data/).
 *
 *   node tools/corpus-report.mjs [outDir]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { db } from "../lib/db.js";

const outDir = resolve(process.argv[2] ?? new URL("../../docs/submission/data", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const count = async (build) => {
  const { count: n, error } = await build(db.from("chunks").select("id", { count: "exact", head: true }));
  if (error) throw new Error(error.message);
  return n ?? 0;
};
const papers = async (code, kind) => {
  const { count: n, error } = await db.from("papers").select("id", { count: "exact", head: true })
    .eq("subject_code", code).eq("kind", kind);
  if (error) throw new Error(error.message);
  return n ?? 0;
};

const { data: subjects, error } = await db.from("subjects")
  .select("code,name").eq("board", "Edexcel").eq("active", true).order("code");
if (error) throw new Error(error.message);

const rows = [];
for (const s of subjects) {
  const q = (f) => count((b) => f(b.eq("subject_code", s.code).eq("kind", "question")));
  const questions = await q((b) => b);
  if (!questions) continue;
  const { data: yr } = await db.from("papers").select("year").eq("subject_code", s.code).eq("kind", "qp")
    .not("year", "is", null).order("year").limit(1000);
  const years = (yr ?? []).map((r) => r.year);
  const { count: boundaries } = await db.from("grade_boundaries")
    .select("id", { count: "exact", head: true }).eq("subject_code", s.code);
  rows.push({
    code: s.code.replace(/^E-/, ""),
    name: s.name,
    questionPapers: await papers(s.code, "qp"),
    years: years.length ? `${years[0]}-${years[years.length - 1]}` : "",
    questions,
    withMarkScheme: await q((b) => b.not("ms_content", "is", null)),
    withExaminerReport: await q((b) => b.not("er_content", "is", null)),
    topicTagged: await q((b) => b.not("topic", "is", null)),
    embedded: await q((b) => b.not("embedding", "is", null)),
    specSections: await count((b) => b.eq("subject_code", s.code).eq("kind", "syllabus")),
    gradeBoundaryRows: boundaries ?? 0,
  });
}

const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
const total = {
  code: "All", name: `${rows.length} subjects`, questionPapers: sum("questionPapers"), years: "",
  questions: sum("questions"), withMarkScheme: sum("withMarkScheme"), withExaminerReport: sum("withExaminerReport"),
  topicTagged: sum("topicTagged"), embedded: sum("embedded"), specSections: sum("specSections"),
  gradeBoundaryRows: sum("gradeBoundaryRows"),
};

const md = [
  `Generated ${new Date().toISOString().slice(0, 10)} by \`ingest/tools/corpus-report.mjs\` from the live database.`,
  "",
  "| Code | Subject | Papers | Years | Questions | With mark scheme | With examiner report | Topic-tagged | Embedded | Spec sections |",
  "|---|---|---:|---|---:|---:|---:|---:|---:|---:|",
  ...[...rows, total].map((r) => `| ${r.code} | ${r.name} | ${r.questionPapers} | ${r.years} | ${r.questions} | ${r.withMarkScheme} (${pct(r.withMarkScheme, r.questions)}) | ${r.withExaminerReport} (${pct(r.withExaminerReport, r.questions)}) | ${r.topicTagged} (${pct(r.topicTagged, r.questions)}) | ${r.embedded} (${pct(r.embedded, r.questions)}) | ${r.specSections} |`),
  "",
].join("\n");

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "corpus-stats.json"), JSON.stringify({ generated: new Date().toISOString(), subjects: rows, total }, null, 2));
await writeFile(join(outDir, "corpus-stats.md"), md);
console.log(md);
