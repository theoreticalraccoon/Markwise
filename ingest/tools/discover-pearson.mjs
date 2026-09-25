/**
 * What Pearson actually publishes for International GCSE: per subject, the
 * series with a question paper, mark scheme and examiner report. We used this
 * to plan the corpus. Saves the raw catalogue for fetch-pearson.mjs.
 *
 *   node tools/discover-pearson.mjs [4PH1]
 */
import { writeFile } from "node:fs/promises";
import { openCatalogue, tagOf, isGated, parseSeries } from "../lib/pearson.js";

const only = process.argv[2]?.toUpperCase() ?? null;
const cat = await openCatalogue();

const family = `category:"Pearson-UK:Qualification-Family/International-GCSE"`;
const docs = await cat.search(`${family} AND category:"Pearson-UK:Category/Exam-materials"`);
console.log(`${docs.length} exam-material documents in the International GCSE family\n`);
await cat.close();

// Group: spec code -> series -> kind -> [paperRef]
const subjects = new Map();
for (const d of docs) {
  const spec = (tagOf(d, "Specification-Code") ?? "").replace(/^International-GCSE\/\d+\//, "");
  const subj = tagOf(d, "Qualification-Subject");
  const type = tagOf(d, "Document-Type");
  const series = tagOf(d, "Exam-Series");
  const unit = tagOf(d, "Unit");
  const codeMatch = d.url.match(/\/([0-9a-z]{4})[-_]/i);
  const code = codeMatch ? codeMatch[1].toUpperCase() : null;
  if (!spec || !type) continue;

  const s = subjects.get(spec) ?? { spec, subject: subj, codes: new Set(), series: new Map() };
  if (code && /^4[A-Z]{2}\d$/.test(code)) s.codes.add(code);
  const key = series ?? "(none)";
  const row = s.series.get(key) ?? { qp: [], ms: [], er: [], other: [], gated: 0 };
  const kind = { "Question-paper": "qp", "Mark-scheme": "ms", "Examiner-report": "er" }[type] ?? "other";
  row[kind].push({ unit, url: d.url });
  if (isGated(d)) row.gated++;
  s.series.set(key, row);
  subjects.set(spec, s);
}

const rows = [...subjects.values()].sort((a, b) => a.spec.localeCompare(b.spec));
for (const s of rows) {
  if (only && ![...s.codes].includes(only)) continue;
  const summer = [...s.series.entries()]
    .map(([k, v]) => ({ k, p: parseSeries(k), v }))
    .filter((x) => x.p)
    .sort((a, b) => b.p.year - a.p.year);
  const years = (session) => summer.filter((x) => x.p.session === session && x.v.qp.length).map((x) => x.p.year);
  console.log(
    `${[...s.codes].join("/").padEnd(10)} ${(s.subject ?? s.spec).padEnd(34)} ` +
      `Jun: ${years("Jun").join(",") || "-"}   Jan: ${years("Jan").join(",") || "-"}   Nov: ${years("Nov").join(",") || "-"}`,
  );
  if (only) {
    for (const x of summer) {
      console.log(
        `   ${x.k.padEnd(14)} qp=${String(x.v.qp.length).padStart(2)} ms=${String(x.v.ms.length).padStart(2)} er=${String(x.v.er.length).padStart(2)}` +
          `  papers: ${x.v.qp.map((q) => q.unit).join(" ")}`,
      );
    }
  }
}

await writeFile(
  new URL("../.pearson-catalogue.json", import.meta.url),
  JSON.stringify(docs, null, 0),
);
console.log("\nsaved ingest/.pearson-catalogue.json");
