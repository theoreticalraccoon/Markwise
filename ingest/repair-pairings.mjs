/**
 * Fill only missing mark-scheme text from deterministic local PDF pairings.
 * Existing pairings, question text, classifications and embeddings are never
 * touched. Run with --dry to inspect the count without writing.
 */
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import pLimit from "p-limit";

import { db } from "./lib/db.js";
import { extractPages } from "./lib/pdf.js";
import { dropCoverPage, parseMarkScheme, parseQuestionPaper } from "./lib/parse.js";
import { pairQuestions } from "./lib/pair.js";
import { selectPairingRepairs } from "./lib/repair.js";

const dry = process.argv.includes("--dry");

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    else if (/\.pdf$/i.test(entry.name)) out.push(path);
  }
  return out;
}

const { data: missing, error } = await db
  .from("chunks")
  .select("id,paper_code,question_no,ms_content")
  .eq("kind", "question")
  .is("ms_content", null)
  .limit(1000);
if (error) throw new Error(error.message);

const files = await walk(new URL("./pdfs", import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
const byName = new Map(files.map((file) => [basename(file).toLowerCase(), file]));
const byPaper = new Map();
for (const chunk of missing ?? []) {
  if (!byPaper.has(chunk.paper_code)) byPaper.set(chunk.paper_code, []);
  byPaper.get(chunk.paper_code).push(chunk);
}

const repairs = [];
const unresolved = [];
for (const [paperCode, chunks] of byPaper) {
  const qp = byName.get(`${paperCode}.pdf`.toLowerCase());
  const ms = byName.get(`${paperCode.replace("_qp_", "_ms_")}.pdf`.toLowerCase());
  if (!qp || !ms) {
    unresolved.push(...chunks);
    continue;
  }

  const { pages: qpPages } = await extractPages(qp, { markers: true });
  const { pages: msPages } = await extractPages(ms);
  const questions = parseQuestionPaper(dropCoverPage(qpPages));
  const { paired } = pairQuestions(questions, parseMarkScheme(msPages));
  const found = selectPairingRepairs(chunks, paired);
  repairs.push(...found);
  const foundIds = new Set(found.map((repair) => repair.id));
  unresolved.push(...chunks.filter((chunk) => !foundIds.has(chunk.id)));
}

if (!dry) {
  const limit = pLimit(10);
  await Promise.all(repairs.map((repair) => limit(async () => {
    const { error: updateError } = await db
      .from("chunks")
      .update({ ms_content: repair.ms_content })
      .eq("id", repair.id)
      .is("ms_content", null);
    if (updateError) throw new Error(`Pairing repair failed for ${repair.id}: ${updateError.message}`);
  })));
}

console.log(`${dry ? "Would repair" : "Repaired"} ${repairs.length} exact pairing(s).`);
console.log(`${unresolved.length} remain unpaired after deterministic repair.`);
if (unresolved.length) {
  const counts = new Map();
  for (const chunk of unresolved) counts.set(chunk.paper_code, (counts.get(chunk.paper_code) ?? 0) + 1);
  for (const [paper, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${paper}: ${count}`);
  }
}
