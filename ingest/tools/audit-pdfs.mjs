/**
 * How completely the parser reads real papers: questions found, gaps, and marks
 * against the printed total. Read-only. This is the check that caught the
 * superscript bug (15 questions lost while every unit test passed).
 *
 *   node tools/audit-pdfs.mjs pdfs/4PH1
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { extractPages } from "../lib/pdf.js";
import { parseQuestionPaper, dropCoverPage, consistency, looksParsed } from "../lib/parse.js";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--")) ?? "./pdfs";
const subject = (() => { const i = args.indexOf("--subject"); return i >= 0 ? args[i + 1]?.toLowerCase() : null; })();

async function walk(d) {
  const out = [];
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (/_qp_.*\.pdf$/i.test(e.name) || /_que_.*\.pdf$/i.test(e.name)) out.push(p);
  }
  return out;
}

const files = (await walk(dir)).filter((f) => !subject || f.toLowerCase().includes(subject)).sort();
let bad = 0;
for (const f of files) {
  const { pages } = await extractPages(f, { markers: true });
  const parts = parseQuestionPaper(dropCoverPage(pages));
  const c = consistency(parts, pages);
  const verdict = looksParsed(parts, pages) ? "ok " : "BAD";
  if (verdict === "BAD") bad++;
  console.log(
    `${verdict} ${f.split(/[\/]/).pop().padEnd(34)} parts=${String(parts.length).padStart(3)} ` +
    `questions=${c.questions}/${c.lastQuestion} marks=${c.sum}/${c.printed ?? "?"}` +
    (c.missing.length ? ` MISSING ${c.missing.join(",")}` : "") + (c.mismatched.length ? ` OFF ${c.mismatched.map((m) => `Q${m.question}:${m.got}/${m.want}`).join(" ")}` : ""),
  );
}
console.log(`\n${files.length - bad} of ${files.length} papers read completely`);
process.exit(bad ? 1 : 0);
