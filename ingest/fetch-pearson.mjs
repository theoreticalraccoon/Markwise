/**
 * Download Edexcel International GCSE past papers from Pearson's own site.
 *
 *   node fetch-pearson.mjs --subjects 4PH1,4CH1 --years 2021-2025 [--series Jun]
 *                          [--kinds qp,ms,er] [--dry] [--refresh]
 *
 * Only qualifications.pearson.com, one request every couple of seconds, nothing
 * behind a teacher login or inside the 12-month embargo. Files already on disk
 * are skipped, so a run can stop and restart anywhere.
 */
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openCatalogue, tagOf, isGated, parseSeries, markwiseName, sleep, SITE, USER_AGENT, POLITE_DELAY_MS,
} from "./lib/pearson.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "pdfs");
const CATALOGUE = join(HERE, ".pearson-catalogue.json");

/* ------------------------------------------------------------------- args -- */

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return null;
  const next = args[i + 1];
  return next && !next.startsWith("--") ? next : true;
};

const subjects = String(flag("subjects") ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
if (!subjects.length) {
  console.error("Say which subjects: --subjects 4PH1,4CH1");
  process.exit(2);
}
const [yearFrom, yearTo] = String(flag("years") ?? "2021-2025").split("-").map(Number);
const series = String(flag("series") ?? "Jun");
const kinds = String(flag("kinds") ?? "qp,ms,er").split(",");
const dry = !!flag("dry");
const refresh = !!flag("refresh");

/** Pearson holds the most recent 12 months back for teachers. */
const EMBARGO = new Date();
EMBARGO.setMonth(EMBARGO.getMonth() - 12);

const KIND = { "Question-paper": "qp", "Mark-scheme": "ms", "Examiner-report": "er" };

/* -------------------------------------------------------------- the plan -- */

async function loadCatalogue() {
  if (!refresh) {
    try {
      return JSON.parse(await readFile(CATALOGUE, "utf8"));
    } catch { /* fall through and ask Pearson */ }
  }
  const cat = await openCatalogue();
  const docs = await cat.search(
    `category:"Pearson-UK:Qualification-Family/International-GCSE" AND category:"Pearson-UK:Category/Exam-materials"`,
  );
  await cat.close();
  await writeFile(CATALOGUE, JSON.stringify(docs));
  return docs;
}

/** "4ph1-1p-que-20240523.pdf" -> { code: "4PH1", ref: "1P" } */
function fromUrl(url) {
  const m = decodeURIComponent(url).match(/\/(4[a-z]{2}\d)[-_]([0-9][0-9a-z]{0,3})[-_](?:que|rms|pef|msc|er)[-_]/i);
  return m ? { code: m[1].toUpperCase(), ref: m[2].toUpperCase() } : null;
}

function plan(docs) {
  const wanted = [];
  const skipped = { gated: 0, embargo: 0, unnamed: 0 };
  for (const d of docs) {
    const kind = KIND[tagOf(d, "Document-Type")];
    if (!kind || !kinds.includes(kind)) continue;
    if (!/\.pdf$/i.test(d.url)) continue;

    const id = fromUrl(d.url);
    if (!id || !subjects.includes(id.code)) continue;

    const s = parseSeries(tagOf(d, "Exam-Series"));
    if (!s || s.session !== series || s.year < yearFrom || s.year > yearTo) continue;

    if (isGated(d)) { skipped.gated++; continue; }
    // Belt and braces: a June series in range is always past the embargo.
    if (new Date(s.year, s.session === "Jun" ? 5 : s.session === "Jan" ? 0 : 10, 1) > EMBARGO) { skipped.embargo++; continue; }

    wanted.push({
      code: id.code,
      kind,
      year: s.year,
      session: s.session,
      ref: id.ref,
      url: new URL(encodeURI(decodeURI(d.url)), SITE).href,
      file: markwiseName({ code: id.code, session: s.session, year: s.year, kind, ref: id.ref }),
    });
  }
  // The same paper can appear twice in the catalogue; keep one.
  const seen = new Set();
  const unique = wanted.filter((w) => (seen.has(w.file) ? false : (seen.add(w.file), true)));
  unique.sort((a, b) => a.code.localeCompare(b.code) || b.year - a.year || a.file.localeCompare(b.file));
  return { unique, skipped };
}

/* ---------------------------------------------------------------- download -- */

async function exists(path) {
  try {
    const s = await stat(path);
    return s.size > 5000;
  } catch {
    return false;
  }
}

async function download(item) {
  const path = join(OUT, item.code, item.file);
  if (await exists(path)) return { status: "have", bytes: (await stat(path)).size };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(item.url, { headers: { "User-Agent": USER_AGENT }, redirect: "follow" });
      const type = res.headers.get("content-type") ?? "";
      if (res.status === 404 || /text\/html/i.test(type)) return { status: "missing", detail: `${res.status} ${type}` };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const buf = Buffer.from(await res.arrayBuffer());
      // A real PDF starts with "%PDF". Anything else is an error page.
      if (buf.length < 5000 || buf.subarray(0, 4).toString() !== "%PDF") {
        return { status: "missing", detail: `not a PDF (${buf.length} bytes)` };
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, buf);
      return { status: "got", bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
    } catch (e) {
      if (attempt === 3) return { status: "failed", detail: e.message };
      await sleep(3000 * attempt);
    }
  }
  return { status: "failed", detail: "unreachable" };
}

/* -------------------------------------------------------------------- run -- */

const docs = await loadCatalogue();
const { unique, skipped } = plan(docs);

const bySubject = new Map();
for (const w of unique) bySubject.set(w.code, (bySubject.get(w.code) ?? 0) + 1);
console.log(`Plan: ${unique.length} files for ${subjects.join(", ")}, ${series} ${yearFrom}-${yearTo}`);
for (const [code, n] of bySubject) console.log(`  ${code}: ${n}`);
if (skipped.gated || skipped.embargo) console.log(`  (left alone: ${skipped.gated} gated, ${skipped.embargo} under embargo)`);
const missingSubjects = subjects.filter((s) => !bySubject.has(s));
if (missingSubjects.length) console.log(`  NOTHING FOUND for: ${missingSubjects.join(", ")}`);

if (dry) {
  console.log("\n(dry run: nothing downloaded)");
  process.exit(0);
}

/* ----------------------------------------------------- the specification -- */

/** Fetch each subject's specification once. It has to be ingested before the papers. */
async function fetchSpecs() {
  // The spec tag for each subject, read off papers we already have.
  const slugs = new Map();
  for (const d of docs) {
    const id = fromUrl(d.url);
    const spec = tagOf(d, "Specification-Code");
    if (id && spec && /^International-GCSE\/\d{4}\//.test(spec) && !slugs.has(id.code)) slugs.set(id.code, spec);
  }

  const cat = await openCatalogue();
  const results = [];
  try {
    for (const code of subjects) {
      const spec = slugs.get(code);
      if (!spec) { results.push({ code, status: "missing", detail: "no specification tag" }); continue; }
      const found = await cat.search(
        `category:"Pearson-UK:Specification-Code/${spec}" AND category:"Pearson-UK:Document-Type/Specification"`,
      );
      const doc = found.find((d) => /\.pdf$/i.test(d.url));
      if (!doc) { results.push({ code, status: "missing", detail: "no specification PDF listed" }); continue; }

      const from = tagOf(doc, "Accreditation-From-date") ?? spec.match(/\/(\d{4})\//)?.[1] ?? "17";
      const file = `E-${code}_y${String(from).slice(-2)}_sy.pdf`;
      const item = { code, kind: "sy", file, url: new URL(encodeURI(decodeURI(doc.url)), SITE).href };
      const r = await download(item);
      results.push({ code, file, ...r });
      if (r.status !== "have") await sleep(POLITE_DELAY_MS);
    }
  } finally {
    await cat.close();
  }
  return results;
}

const tally = { got: 0, have: 0, missing: 0, failed: 0 };
const problems = [];
let bytes = 0;
for (let i = 0; i < unique.length; i++) {
  const item = unique[i];
  const r = await download(item);
  tally[r.status]++;
  bytes += r.bytes ?? 0;
  if (r.status === "missing" || r.status === "failed") problems.push(`${item.file}: ${r.detail}`);
  if (r.status !== "have") {
    console.log(`  [${String(i + 1).padStart(3)}/${unique.length}] ${r.status.padEnd(7)} ${item.file}${r.bytes ? `  ${(r.bytes / 1024).toFixed(0)} KB` : ""}${r.detail ? "  " + r.detail : ""}`);
    await sleep(POLITE_DELAY_MS);
  }
}

if (!flag("no-spec")) {
  console.log("\nSpecifications:");
  for (const r of await fetchSpecs()) {
    console.log(`  ${r.code.padEnd(5)} ${r.status.padEnd(7)} ${r.file ?? ""}${r.bytes ? `  ${(r.bytes / 1024).toFixed(0)} KB` : ""}${r.detail ? "  " + r.detail : ""}`);
    if (r.status === "missing" || r.status === "failed") problems.push(`${r.code} specification: ${r.detail}`);
  }
}

console.log(`\nDone. ${tally.got} downloaded, ${tally.have} already on disk, ${tally.missing} missing, ${tally.failed} failed (${(bytes / 1048576).toFixed(0)} MB new).`);
if (problems.length) {
  console.log("\nProblems:");
  for (const p of problems) console.log("  " + p);
}
process.exit(tally.failed ? 1 : 0);
