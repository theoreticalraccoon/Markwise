#!/usr/bin/env node
/**
 * Markwise ingestion CLI.
 *
 *   node ingest.js papers     --dir ./pdfs/4PH1 --subject E-4PH1 [--force] [--no-embed]
 *   node ingest.js syllabus   --file ./pdfs/4PH1/E-4PH1_y17_sy.pdf
 *   node ingest.js boundaries --file <pearson grade boundaries pdf> [--year --session]
 *   node ingest.js classify | reembed | status [--subject E-4PH1]
 *
 * Resumable: a paper whose hash already matches the database is skipped.
 */

import { readdir, stat } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import pLimit from "p-limit";

import { CONCURRENCY, EMBED_BATCH } from "./lib/config.js";
import { extractPages, renderPagePng, sha256 } from "./lib/pdf.js";
import { ocrPage, embedAll } from "./lib/gemini.js";
import { parseFilename, titleFor } from "./lib/filename.js";
import {
  parseQuestionPaper, parseMarkScheme, llmParseQuestions, llmParseMarkScheme,
  looksParsed, dropCoverPage, consistency, printedTotal,
} from "./lib/parse.js";
import { pairQuestions, attachExaminerReport, combineMarkSchemeVariants } from "./lib/pair.js";
import { attachLanguageSchemeVariants } from "./lib/groups.js";
import { commandWord, classifyBatch, topicVocabulary } from "./lib/classify.js";
import { parseSyllabus, parseSyllabusStatements, parseSyllabusTable, llmParseSyllabus } from "./lib/syllabus.js";
import { parsePearsonBoundaries, tierOfBoundaryRef, seriesFromBoundaryFilename } from "./lib/boundaries.js";
import { STALL_LIMIT, nextStalls } from "./lib/reembed.js";
import {
  db, ensureSubject, getSubject, upsertPaper, markIngested, replaceQuestionChunks, replaceAllChunks, coverage,
  chunksMissingEmbedding, setEmbedding, upsertGradeBoundaries,
} from "./lib/db.js";

/* ------------------------------------------------------------------- args -- */

const argv = process.argv.slice(2);
const command = argv[0];
const flags = Object.fromEntries(
  argv.slice(1).reduce((acc, a, i, arr) => {
    if (!a.startsWith("--")) return acc;
    const key = a.slice(2);
    const next = arr[i + 1];
    acc.push([key, next && !next.startsWith("--") ? next : true]);
    return acc;
  }, []),
);

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn("  !", ...a);

/** Questions per classification call. Smaller batches survive tight quotas. */
const CLASSIFY_BATCH = Number(process.env.CLASSIFY_BATCH || 25);

/** Below this share of question parts paired, the model re-reads the scheme. */
const MS_PAIR_TARGET = 0.85;

/** One hash for the question paper, mark scheme and examiner report together. */
async function groupHash(files) {
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256");
  for (const kind of ["qp", "ms", "er"]) {
    if (files[kind]) h.update(`${kind}:${await sha256(files[kind])};`);
  }
  for (const variant of files.msVariants ?? []) {
    h.update(`ms:${variant.paperRef}:${await sha256(variant.path)};`);
  }
  return h.digest("hex");
}

/** "(Q3 missing, 86/100 marks)" for the log. */
function describe(c) {
  const bits = [];
  if (c.missing.length) bits.push(`questions ${c.missing.join(",")} missing`);
  if (c.printed !== null && c.sum !== c.printed) bits.push(`${c.sum}/${c.printed} marks`);
  if (c.mismatched.length) bits.push(`${c.mismatched.length} question total(s) off`);
  return bits.length ? ` (${bits.join(", ")})` : "";
}

/** Higher is a more complete reading of the paper. */
function quality(c) {
  const drift = c.printed === null ? 0 : Math.abs(c.sum - c.printed);
  return (c.ok ? 1000 : 0) - c.missing.length * 10 - c.mismatched.length * 5 - drift;
}

/** Pair one set of mark-scheme rows and score the result. */
function attempt(questions, msRows) {
  const { paired, stats } = pairQuestions(questions, msRows);
  const hit = paired.filter((p) => p.msText).length;
  return { paired, stats, rate: questions.length ? hit / questions.length : 0 };
}

/* ------------------------------------------------------------------- main -- */

const COMMANDS = { papers, syllabus, boundaries, reembed, classify, status };

if (!command || !COMMANDS[command]) {
  log(`Markwise ingestion

  node ingest.js papers     --dir <folder> [--subject 0625] [--dry] [--ocr]
  node ingest.js syllabus   --file <file.pdf> [--subject 0625]
  node ingest.js boundaries --dir <folder>
  node ingest.js reembed    [--subject 0625]
  node ingest.js classify   [--subject 0625] [--all]
  node ingest.js status
`);
  process.exit(command ? 1 : 0);
}

try {
  await COMMANDS[command]();
  process.exit(0);
} catch (e) {
  console.error(`\nFailed: ${e.message}`);
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
}

/* ----------------------------------------------------------------- papers -- */

async function papers() {
  const dir = flags.dir;
  if (!dir) throw new Error("--dir is required.");

  const files = await listPdfs(dir);
  log(`Found ${files.length} PDF${files.length === 1 ? "" : "s"} in ${dir}\n`);

  // Group by paper identity so a question paper meets its mark scheme.
  const groups = new Map();
  const skipped = [];

  for (const file of files) {
    const meta = parseFilename(basename(file));
    if (!meta || !meta.subjectCode) {
      skipped.push(basename(file));
      continue;
    }
    if (flags.subject && meta.subjectCode.toUpperCase() !== String(flags.subject).toUpperCase()) continue;
    if (!["qp", "ms", "er"].includes(meta.kind)) continue;

    const id = `${meta.subjectCode}|${meta.year}|${meta.session}|${meta.paperRef ?? ''}`;
    if (!groups.has(id)) groups.set(id, { meta, files: {} });
    const group = groups.get(id);
    group.files[meta.kind] = file;
    // The question paper's code is what every chunk is cited by, so it wins.
    if (meta.kind === "qp") group.meta = meta;
  }

  attachLanguageSchemeVariants(groups);

  if (skipped.length) {
    warn(`${skipped.length} file(s) had unrecognisable names and were skipped, e.g. ${skipped[0]}`);
  }
  log(`${groups.size} paper group(s) to process.\n`);

  const limit = pLimit(Math.max(1, CONCURRENCY));
  const totals = { papers: 0, chunks: 0, paired: 0, unpaired: 0, skipped: 0, flagged: 0 };

  await Promise.all(
    [...groups.values()].map((g) =>
      limit(async () => {
        try {
          const r = await ingestGroup(g);
          totals.papers += r.papers;
          totals.chunks += r.chunks;
          totals.paired += r.paired;
          totals.unpaired += r.unpaired;
          totals.skipped += r.skipped;
          totals.flagged += r.flagged ?? 0;
        } catch (e) {
          warn(`${g.meta.code}: ${e.message}`);
        }
      })
    ),
  );

  log(`
Done.
  papers ingested : ${totals.papers} (${totals.skipped} unchanged, skipped)
  question chunks : ${totals.chunks}
  with mark scheme: ${totals.paired}
  without         : ${totals.unpaired}
  flagged         : ${totals.flagged} paper(s) that do not add up: re-check these`);

  if (totals.unpaired > totals.paired && totals.paired > 0) {
    warn("More unpaired than paired questions: are the mark scheme PDFs in this folder?");
  }
}

async function ingestGroup({ meta, files }) {
  const tag = meta.code ?? `${meta.subjectCode} ${meta.session} ${meta.year}`;
  const result = { papers: 0, chunks: 0, paired: 0, unpaired: 0, skipped: 0, flagged: 0 };

  if (!files.qp) {
    warn(`${tag}: no question paper, only a mark scheme: skipping`);
    return result;
  }

  const subject = (await getSubject(meta.subjectCode)) ?? (await ensureSubject(meta.subjectCode));

  // Hash the whole group, so a fixed mark scheme still triggers a re-ingest.
  const hash = await groupHash(files);
  // markers: question papers only. See extractPages.
  const { pages: qpPagesRaw, pageCount } = await extractPages(files.qp, { markers: true });
  const { paper, unchanged } = await upsertPaper(meta, {
    title: titleFor(meta, subject.name),
    sha256: hash,
    pages: pageCount,
    force: !!flags.force,
  });
  if (unchanged) {
    result.skipped = 1;
    return result;
  }
  result.papers = 1;

  // --- extract, with OCR where the text layer is missing -------------------
  const qpPages = await maybeOcr(files.qp, qpPagesRaw, tag);
  const body = dropCoverPage(qpPages);

  // --- parse questions -----------------------------------------------------
  let questions = parseQuestionPaper(body);
  // looksParsed also checks for gaps and the printed total, not just part count.
  if (!looksParsed(questions, body)) {
    const before = consistency(questions, body);
    log(`  ${tag}: parse does not add up${describe(before)}: retrying with the model`);
    // If the re-read fails (rate limit, output limit), keep the deterministic parse.
    try {
      const viaLlm = await llmParseQuestions(body, titleFor(meta, subject.name));
      // Keep whichever reading is the more complete, not merely the longer one.
      if (viaLlm.length && quality(consistency(viaLlm, body)) > quality(before)) questions = viaLlm;
    } catch (e) {
      warn(`${tag}: model re-read failed (${e.message}). Keeping the deterministic parse`);
    }
  }
  if (questions.length === 0) {
    warn(`${tag}: no questions extracted`);
    return result;
  }
  const check = consistency(questions, body);
  result.flagged = check.ok ? 0 : 1;
  if (!check.ok) {
    warn(`${tag}: stored, but incomplete${describe(check)}. Check it before relying on it.`);
  }

  // Decide on a model re-read from the pairing rate, not the row count: a
  // flattened table can give a row per question and still label them wrong.
  let best = {
    paired: questions.map((q) => ({ ...q, msText: null, msMarks: null })),
    stats: { exact: 0, normalised: 0, root: 0, unmatched: questions.length },
    rate: 0,
  };

  const schemeSources = files.msVariants ?? (files.ms ? [{ label: null, path: files.ms }] : []);
  if (schemeSources.length) {
    const parsed = [];
    for (const source of schemeSources) {
      const { pages: msRaw } = await extractPages(source.path);
      const pages = await maybeOcr(source.path, msRaw, `${tag} ms${source.label ? ` ${source.label}` : ""}`);
      parsed.push({ ...source, pages, rows: parseMarkScheme(pages) });
    }
    const deterministicRows = parsed.length === 1
      ? parsed[0].rows
      : combineMarkSchemeVariants(parsed);

    best = attempt(questions, deterministicRows);

    if (best.rate < MS_PAIR_TARGET) {
      log(`  ${tag}: ${Math.round(best.rate * 100)}% of parts paired: re-reading the mark scheme with the model`);
      try {
        const repaired = [];
        for (const source of parsed) {
          repaired.push({
            ...source,
            rows: await llmParseMarkScheme(source.pages, `${tag} mark scheme${source.label ? ` (${source.label})` : ""}`),
          });
        }
        const repairedRows = repaired.length === 1 ? repaired[0].rows : combineMarkSchemeVariants(repaired);
        const viaLlm = attempt(questions, repairedRows);
        if (viaLlm.rate > best.rate) best = viaLlm;
      } catch (e) {
        warn(`${tag}: model re-read failed (${e.message}). Keeping the deterministic pairing`);
      }
    }
  }

  const { paired, stats } = best;
  result.paired = paired.filter((p) => p.msText).length;
  result.unpaired = paired.length - result.paired;

  // --- examiner report -----------------------------------------------------
  let enriched = paired;
  if (files.er) {
    const { pages: erPages } = await extractPages(files.er);
    enriched = attachExaminerReport(paired, erPages);
  }

  // --- classify ------------------------------------------------------------
  const topics = await topicVocabulary(db, meta.subjectCode);
  const labels = await classifyBatch(enriched, topics, subject.name);

  // --- embed ---------------------------------------------------------------
  const texts = enriched.map((q, i) => embedText(q, labels[i], subject.name));
  const vectors = await embedAll(texts, { noEmbed: !!flags["no-embed"], batchSize: EMBED_BATCH, onWarn: warn });

  // --- write ---------------------------------------------------------------
  const rows = enriched.map((q, i) => ({
    paper_id: paper.id,
    subject_code: meta.subjectCode,
    kind: "question",
    paper_code: meta.code,
    year: meta.year,
    session: meta.session,
    paper_no: meta.paperNo,
    variant: meta.variant,
    paper_ref: meta.paperRef ?? "",
    tier: meta.tier ?? null,
    question_no: q.questionNo,
    question_root: q.questionRoot,
    marks: q.marks ?? null,
    command_word: commandWord(q.text),
    topic: labels[i]?.topic ?? null,
    syllabus_refs: labels[i]?.refs ?? [],
    content: q.text,
    ms_content: q.msText ?? null,
    er_content: q.erText ?? null,
    page: q.page ?? null,
    embedding: vectors[i] ?? null,
  }));

  result.chunks = await replaceQuestionChunks(paper.id, "question", rows);
  // Written last, so a run that dies halfway gets redone rather than skipped.
  await markIngested(paper.id, hash, { totalMarks: printedTotal(body) });
  log(
    `  ${tag}: ${result.chunks} parts · ${result.paired} with mark scheme ` +
      `(exact ${stats.exact}, fuzzy ${stats.normalised}, root ${stats.root})`,
  );
  return result;
}

// Fold the mark scheme, topic and paper ref into the embedded text so a
// student's paraphrase of the answer still finds the question.
function embedText(q, label, subjectName) {
  return [
    `${subjectName} · ${label?.topic ?? "IGCSE"}`,
    `Question ${q.questionNo}${q.marks ? ` (${q.marks} marks)` : ""}`,
    q.text,
    q.msText ? `Marking points: ${q.msText}` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 7000);
}

/* --------------------------------------------------------------- syllabus -- */

async function syllabus() {
  const file = flags.file;
  if (!file) throw new Error("--file is required.");

  const meta = parseFilename(basename(file));
  const code = String(flags.subject ?? meta?.subjectCode ?? "");
  if (!code) throw new Error("Could not tell which subject this is: pass --subject.");

  const subject = (await getSubject(code)) ?? (await ensureSubject(code));
  const hash = await sha256(file);
  const { pages, pageCount } = await extractPages(file);

  const { paper, unchanged } = await upsertPaper(
    { subjectCode: code, kind: "sy", year: meta?.year ?? null, session: null, paperNo: null, variant: null, paperRef: "", tier: null, code: meta?.code ?? basename(file, extname(file)) },
    { title: `${subject.name} syllabus${meta?.year ? ` ${meta.year}` : ""}`, sha256: hash, pages: pageCount, force: !!flags.force },
  );
  if (unchanged) {
    log("Already ingested and unchanged.");
    return;
  }

  let sections = parseSyllabus(pages);
  if (sections.length < 5) sections = parseSyllabusStatements(pages);
  if (sections.length < 5) sections = parseSyllabusTable(pages);
  if (sections.length < 5) {
    log("Structural parse was thin: using the model.");
    sections = await llmParseSyllabus(pages, subject.name);
  }
  if (!sections.length) throw new Error("No syllabus sections found.");

  const vectors = await embedAll(
    sections.map((s) => `${subject.name} syllabus · ${s.topic}\n${s.content}`),
    { noEmbed: !!flags["no-embed"], batchSize: EMBED_BATCH, onWarn: warn },
  );

  const rows = sections.map((s, i) => ({
    paper_id: paper.id,
    subject_code: code,
    kind: "syllabus",
    paper_code: meta?.code ?? null,
    year: meta?.year ?? null,
    topic: s.topic,
    syllabus_refs: [s.ref],
    content: s.content,
    embedding: vectors[i] ?? null,
  }));

  const n = await replaceAllChunks(paper.id, "syllabus", rows);
  await markIngested(paper.id, hash);
  log(`${n} syllabus sections ingested for ${subject.name}.`);
  log(`Topic vocabulary is now: ${[...new Set(sections.map((s) => s.topic))].join(", ")}`);
  log(`\nIngest this subject's papers next. They will be classified against these topics.`);
}

/* ------------------------------------------------------------- boundaries -- */

/** Pearson ships one grade-boundary PDF per series for every subject. Rows for subjects we don't carry are skipped. */
async function boundaries() {
  const file = flags.file;
  if (!file) throw new Error("--file is required (a Pearson grade-boundaries PDF).");

  const named = seriesFromBoundaryFilename(basename(file));
  const year = flags.year ? Number(flags.year) : named?.year;
  const session = flags.session ? String(flags.session) : named?.session;
  if (!year || !session) {
    throw new Error("Could not tell the series from the filename; pass --year and --session.");
  }

  const { pages } = await extractPages(file);
  const parsed = parsePearsonBoundaries(pages);
  if (!parsed.length) throw new Error("No grade-boundary rows found in this PDF.");

  const rows = [];
  const unknown = new Set();
  for (const r of parsed) {
    const code = `E-${r.code}`;
    const subject = await getSubject(code);
    if (!subject) { unknown.add(r.code); continue; }
    const tier = tierOfBoundaryRef(r.paperRef) ?? "";
    for (const [grade, min_marks] of Object.entries(r.boundaries)) {
      rows.push({
        subject_code: code, year, session, paper_ref: r.paperRef, tier, grade,
        min_marks, max_marks: r.maxMark, total_marks: r.maxMark,
      });
    }
  }

  const total = await upsertGradeBoundaries(rows);
  log(`${basename(file)}: ${session} ${year}`);
  log(`${total} grade boundaries stored for ${new Set(rows.map((r) => r.subject_code)).size} subject(s).`);
  if (unknown.size) log(`  (skipped, not in our catalogue: ${[...unknown].join(", ")})`);
}

/* ---------------------------------------------------------------- reembed -- */

async function reembed() {
  const subject = flags.subject ? String(flags.subject) : null;
  let total = 0;
  let stalls = 0;
  for (;;) {
    const rows = await chunksMissingEmbedding(subject, 200);
    if (!rows.length) break;
    const vectors = await embedAll(
      rows.map((r) => [r.topic, r.question_no, r.content, r.ms_content].filter(Boolean).join("\n").slice(0, 7000)),
      { batchSize: EMBED_BATCH, onWarn: warn },
    );
    let embedded = 0;
    for (let i = 0; i < rows.length; i++) {
      if (vectors[i]) {
        await setEmbedding(rows[i].id, vectors[i]);
        total++;
        embedded++;
      }
    }
    log(`  embedded ${total}…`);

    // Stop when a whole pass embeds nothing, otherwise a dead quota loops forever.
    stalls = nextStalls(stalls, embedded);
    if (stalls >= STALL_LIMIT) {
      warn(`no progress after ${stalls} passes (quota likely exhausted for now); ${rows.length}+ chunk(s) still unembedded. Run 'reembed' again later.`);
      break;
    }
  }
  log(`${total} chunk(s) embedded.`);
}

/* --------------------------------------------------------------- classify -- */

/** Tag questions with their syllabus topic. Separate from ingestion because it's the first thing to run out of quota. */
async function classify() {
  const subject = flags.subject ? String(flags.subject) : null;

  let q = db.from("chunks").select("id,subject_code,content").eq("kind", "question");
  if (subject) q = q.eq("subject_code", subject);
  if (!flags.all) q = q.is("topic", null);
  const { data: rows, error } = await q.limit(5000);
  if (error) throw new Error(error.message);

  if (!rows.length) {
    log(flags.all ? "No questions found." : "Every question already has a topic. Pass --all to redo them.");
    return;
  }

  // Topic vocabularies are per subject; never mix them.
  const bySubject = new Map();
  for (const r of rows) {
    if (!bySubject.has(r.subject_code)) bySubject.set(r.subject_code, []);
    bySubject.get(r.subject_code).push(r);
  }

  let tagged = 0;
  for (const [code, items] of bySubject) {
    const info = await getSubject(code);
    const name = info?.name ?? code;
    const topics = await topicVocabulary(db, code);
    if (!topics.length) {
      warn(`${code}: no topic vocabulary: ingest the syllabus for this subject first`);
      continue;
    }
    log(`${name}: ${items.length} question(s) against ${topics.length} topics`);

    for (let i = 0; i < items.length; i += CLASSIFY_BATCH) {
      const slice = items.slice(i, i + CLASSIFY_BATCH);
      const labels = await classifyBatch(slice.map((r) => ({ text: r.content })), topics, name);
      let batchTagged = 0;
      for (let j = 0; j < slice.length; j++) {
        const label = labels[j];
        if (!label?.topic) continue;
        const { error: e } = await db.from("chunks")
          .update({ topic: label.topic, syllabus_refs: label.refs ?? [] })
          .eq("id", slice[j].id);
        if (!e) {
          tagged++;
          batchTagged++;
        }
      }
      log(`  ${Math.min(i + CLASSIFY_BATCH, items.length)}/${items.length}: ${batchTagged} tagged`);
    }
  }
  log(`\n${tagged} question(s) classified.`);
}

/* ----------------------------------------------------------------- status -- */

async function status() {
  const rows = await coverage();
  const withCorpus = rows.filter((r) => r.questions > 0);

  if (!withCorpus.length) {
    log("No corpus ingested yet. Start with:\n  node ingest.js syllabus --file <subject syllabus>.pdf");
    return;
  }

  const pad = (s, n) => String(s ?? "").padEnd(n);
  log(pad("SUBJECT", 30) + pad("QUESTIONS", 11) + pad("SYLLABUS", 10) + pad("PAPERS", 8) + "YEARS");
  log("-".repeat(72));
  for (const r of withCorpus) {
    log(
      pad(`${r.subject_name} (${r.subject_code})`, 30) +
        pad(r.questions, 11) +
        pad(r.syllabus_sections, 10) +
        pad(r.papers, 8) +
        (r.from_year ? `${r.from_year}–${r.to_year}` : ": "),
    );
  }

  const { count: unembedded } = await db
    .from("chunks")
    .select("id", { count: "exact", head: true })
    .is("embedding", null);
  if (unembedded) warn(`${unembedded} chunk(s) have no embedding: run: node ingest.js reembed`);

  const { count: unpaired } = await db
    .from("chunks")
    .select("id", { count: "exact", head: true })
    .eq("kind", "question")
    .is("ms_content", null);
  if (unpaired) {
    log(`\n${unpaired} question(s) have no mark scheme attached. They are searchable but cannot be marked.`);
  }
}

/* ---------------------------------------------------------------- helpers -- */

async function listPdfs(dir) {
  const out = [];
  const walk = async (d) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (extname(entry.name).toLowerCase() === ".pdf") out.push(full);
    }
  };
  const s = await stat(dir).catch(() => null);
  if (!s) throw new Error(`No such folder: ${dir}`);
  await walk(dir);
  return out.sort();
}

/** OCR only the pages that need it, and only when --ocr is passed. */
async function maybeOcr(file, pages, tag) {
  const thin = pages.filter((p) => p.thin);
  if (!flags.ocr || thin.length === 0) return pages;
  if (thin.length > pages.length * 0.8) log(`  ${tag}: scanned paper: OCR'ing ${thin.length} pages`);

  for (const page of thin) {
    const png = await renderPagePng(file, page.n);
    if (!png) {
      warn("OCR needs the optional 'canvas' package: npm i canvas");
      return pages;
    }
    try {
      page.text = await ocrPage(png, tag);
      page.thin = false;
    } catch (e) {
      warn(`OCR failed on page ${page.n}: ${e.message}`);
    }
  }
  return pages;
}
