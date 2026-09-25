/**
 * How well mark schemes pair with their papers, per paper. Read-only.
 * Below ~85% the scheme parse or the pairing is off.
 *
 *   node tools/audit-ms.mjs pdfs/4PH1
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { extractPages } from "../lib/pdf.js";
import { parseQuestionPaper, parseMarkScheme, dropCoverPage } from "../lib/parse.js";
import { pairQuestions } from "../lib/pair.js";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--")) ?? "./pdfs";
const subject = (() => { const i = args.indexOf("--subject"); return i >= 0 ? args[i + 1]?.toLowerCase() : null; })();

async function walk(d) {
  const out = [];
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (/\.pdf$/i.test(e.name)) out.push(p);
  }
  return out;
}

const all = await walk(dir);
const qps = all.filter((f) => /_qp_/i.test(f) && (!subject || f.toLowerCase().includes(subject))).sort();
let low = 0;
for (const qp of qps) {
  const ms = all.find((f) => f === qp.replace(/_qp_/i, "_ms_"));
  const name = qp.split(/[\/]/).pop();
  if (!ms) { console.log(`--- ${name.padEnd(34)} no mark scheme file`); low++; continue; }
  const { pages } = await extractPages(qp, { markers: true });
  const questions = parseQuestionPaper(dropCoverPage(pages));
  const { pages: msPages } = await extractPages(ms);
  const rows = parseMarkScheme(msPages);
  const { paired, stats } = pairQuestions(questions, rows);
  const hit = paired.filter((p) => p.msText).length;
  const pct = questions.length ? Math.round((hit / questions.length) * 100) : 0;
  if (pct < 85) low++;
  const unpaired = paired.filter((p) => !p.msText).map((p) => p.questionNo);
  console.log(
    `${pct >= 85 ? "ok " : "LOW"} ${name.padEnd(34)} ${hit}/${questions.length} paired (${pct}%) ` +
    `rows=${rows.length} exact=${stats.exact} norm=${stats.normalised} root=${stats.root}` +
    (unpaired.length ? `  unpaired: ${unpaired.join(" ")}` : ""),
  );
}
console.log(`\n${qps.length - low} of ${qps.length} papers pair at 85% or better`);
process.exit(low ? 1 : 0);
