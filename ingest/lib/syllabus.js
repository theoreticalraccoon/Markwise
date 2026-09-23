/**
 * Syllabus and grade-threshold ingestion.
 *
 * The syllabus is the smallest and highest-value document in the corpus: it is
 * what answers "is this examinable?", and its section headings become the
 * controlled topic vocabulary that every question is classified against. Get
 * this in first for a subject and every later ingestion is better.
 */

import { generateJSON } from "./gemini.js";
import { cleanLines } from "./parse.js";

/* ---------------------------------------------------------------- syllabus -- */

// "1 Numbers and the number system" / "3 Waves" / "B4 Enzymes". A top-level
// topic. Must not end in a digit, which is what distinguishes a real heading
// from a contents-page entry ("1 About this specification 1").
const TOPIC = /^([A-Z]?\d{1,2})\s+([A-Z][A-Za-z][A-Za-z ,&'’\-()/]{3,70})$/;

// "1.1 Integers" / "2.3". A numbered subsection beneath a topic. Edexcel puts
// the subsection's name in a separate table column, so it often arrives on the
// following line and the title here is empty.
const SUBSECTION = /^([A-Z]?\d{1,2}\.\d{1,2}(?:\.\d{1,2})?)\s*(.*)$/;

// Where the real content begins, strongest signal first. These must be
// anchored to the start of the line: the phrase "subject content" also occurs
// in prose about the assessment ("Questions will assume knowledge from the
// Foundation Tier subject content"), eighty lines before the content itself.
const CONTENT_START = [
  /^students should be taught to/i,
  /^(subject|syllabus|specification) content\b/i,
  /^section \d+:? (subject|syllabus) content/i,
];

const CONTENT_END = /^(assessment objectives|grade descriptions?|grade descriptors|appendix|glossary of command words|what else|assessment information)\b/i;

/** Index of the first line that genuinely opens the content section. */
function findContentStart(lines) {
  for (const marker of CONTENT_START) {
    const i = lines.findIndex((l) => marker.test(l));
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Split a syllabus PDF into one chunk per numbered subsection.
 *
 * `topic` is deliberately the TOP-LEVEL heading, not the subsection name. It
 * becomes the controlled vocabulary every exam question is classified against,
 * and the mastery table is only meaningful if that vocabulary is a handful of
 * buckets a student would recognise: "Algebra and graphs", not "1.4 Use of
 * symbols". Subsection numbers are kept as `ref` so citations stay precise.
 *
 * @returns {{ref,topic,content}[]}
 */
export function parseSyllabus(pages) {
  const lines = pages.flatMap((p) => cleanLines(p.text).map((l) => l.trim()));

  // Begin a few lines before the marker: the marker ("Students should be
  // taught to") sits under the first topic heading, not above it.
  const marker = findContentStart(lines);
  if (marker < 0) return [];
  const start = Math.max(0, marker - 3);

  const sections = [];
  let topic = null;
  let current = null;

  const flush = () => {
    if (current && current.lines.length) {
      const body = current.lines.join("\n").trim();
      if (body) {
        sections.push({
          ref: current.ref,
          topic: current.topic,
          content: `${current.topic}: ${current.ref}${current.title ? ` ${current.title}` : ""}\n${body}`,
        });
      }
    }
    current = null;
  };

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    // The end marker only counts once we are well inside the content: these
    // headings also appear in the front matter and contents pages.
    if (i > start + 20 && CONTENT_END.test(line)) break;
    if (CONTENT_START.some((re) => re.test(line))) continue;

    const t = line.match(TOPIC);
    if (t) {
      flush();
      topic = t[2].trim();
      continue;
    }

    const s = line.match(SUBSECTION);
    if (s && topic) {
      flush();
      // The subsection name is often the next line, in its own column.
      const inlineTitle = s[2].trim();
      const nextLine = (lines[i + 1] ?? "").trim();
      const title = inlineTitle || (/^[A-Z][A-Za-z ,'’\-()]{2,40}$/.test(nextLine) ? nextLine : "");
      current = { ref: s[1], topic, title, lines: inlineTitle ? [inlineTitle] : [] };
      continue;
    }

    if (current) current.lines.push(line);
  }
  flush();

  // Fragments are not retrievable units.
  return sections.filter((s) => s.content.length > 80);
}

const SY_SCHEMA = {
  type: "object",
  properties: {
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Section number, e.g. 2.1" },
          topic: { type: "string", description: "Top-level topic this belongs to." },
          content: { type: "string", description: "The learning outcomes, verbatim." },
        },
        required: ["ref", "topic", "content"],
      },
    },
  },
  required: ["sections"],
};

const SY_SYSTEM = `
You convert an IGCSE syllabus into retrievable sections.

Rules:
- One section per numbered subsection of the SUBJECT CONTENT.
- 'topic' must be the TOP-LEVEL topic name the subsection sits under, repeated
  identically for every subsection of that topic. These become the app's topic
  vocabulary, so consistency matters more than precision.
- 'content' is the learning outcomes VERBATIM. Do not summarise; the exact
  wording ("describe qualitatively…") is what determines examinability.
- Ignore assessment logistics, grade descriptors, and appendices.
`.trim();

/**
 * The Pearson science layout: topic, lettered sub-topic, numbered statements.
 *
 *   1 Forces and motion
 *   (a) Units
 *   Students should:
 *   1.1 use the following units: kilogram (kg), metre (m) ...
 *   1.2P use the following units: newton metre (Nm) ...
 *   (b) Movement and position
 *   Students should:
 *   1.3 plot and explain distance-time graphs
 *
 * Maths puts its content under "Students should be taught to", which the parser
 * above reads. The sciences, and most other International GCSE subjects, do not,
 * and the structural parser found nothing in them ("thin") and fell back to the
 * model, which overflowed its output limit on a 60-page specification.
 *
 * One chunk per lettered sub-topic, keeping its statements together: a single
 * statement ("1.4 know the relationship between average speed, distance and
 * time") is too small to retrieve on its own and loses what it is part of.
 *
 * @returns {{ref,topic,content}[]}
 */
export function parseSyllabusStatements(pages) {
  const lines = pages.flatMap((p) => cleanLines(p.text).map((l) => l.trim()));

  const TOPIC_LINE = /^(\d{1,2})\s+([A-Z][A-Za-z][A-Za-z ,&'’\-()/]{3,70})$/;
  const SUBTOPIC = /^\(([a-z])\)\s+(\S.{1,80})$/;
  const STATEMENT = /^(\d{1,2}\.\d{1,2}[A-Za-z]?)\s+(\S.*)$/;
  const STOP = /^(assessment (information|overview)|command words|glossary|appendix|grade descriptors?|the sample assessment)/i;

  // The content begins at the first "Students should:" (a few lines earlier, at
  // the topic heading) and ends at the next section of the specification.
  const first = lines.findIndex((l) => /^students should:?$/i.test(l));
  if (first < 0) return [];

  const sections = [];
  let topicNo = null;
  let topic = null;
  let current = null;

  const flush = () => {
    if (current && current.statements.length) {
      const body = current.statements.join("\n").trim();
      if (body) {
        sections.push({
          ref: `${topicNo}(${current.letter})`,
          topic,
          content: `${topic}: ${topicNo}(${current.letter}) ${current.title}\nStudents should:\n${body}`,
        });
      }
    }
    current = null;
  };

  for (let i = Math.max(0, first - 12); i < lines.length; i++) {
    const line = lines[i];
    if (i > first && STOP.test(line)) break;
    if (/^specification\b.*(issue|pearson)/i.test(line) || /^students should:?$/i.test(line)) continue;

    // A topic heading is followed by its list of sub-topics.
    const t = line.match(TOPIC_LINE);
    if (t && /^(the following|\(a\))/i.test(lines[i + 1] ?? "")) {
      flush();
      topicNo = t[1];
      topic = t[2].trim();
      continue;
    }

    // A sub-topic HEADING is the one followed by "Students should:". The same
    // "(a) Units" also appears in the topic's list of sub-topics, and that one
    // must not open a section.
    const s = line.match(SUBTOPIC);
    if (s && topic && /^students should:?$/i.test(lines[i + 1] ?? "")) {
      flush();
      current = { letter: s[1], title: s[2].trim(), statements: [] };
      continue;
    }

    if (!current) continue;
    if (STATEMENT.test(line)) current.statements.push(line);
    // Continuation lines (a wrapped statement, or a formula) stay with the last statement.
    else if (current.statements.length) current.statements.push(line);
  }
  flush();

  return sections.filter((s) => s.content.length > 60);
}

/**
 * Pearson's ICT-style two-column content table.
 *
 * The extracted text interleaves the left-hand subsection description with
 * the right-hand learning outcomes, but its identifiers remain reliable:
 * `1.2` opens a subsection and `1.2.1` opens an assessable statement. Keep the
 * extracted wording verbatim and use the `Topic N:` heading as the controlled
 * topic vocabulary.
 */
export function parseSyllabusTable(pages) {
  const lines = pages.flatMap((p) => cleanLines(p.text).map((line) => line.trim()));
  const TOPIC_HEADING = /^Topic\s+(\d{1,2})\s*:\s*(\S.*)$/i;
  const SUBSECTION_ROW = /^(\d{1,2}\.\d{1,2})\s+(\S.*)$/;
  const STATEMENT = /^(\d{1,2}\.\d{1,2}\.\d{1,2}[A-Za-z]?)\s+(\S.*)$/;
  const TABLE_HEADER = /^\d{1,2}\s+.+\s+Students should(?: be able to)?:$/i;
  const SPEC_FOOTER = /^(?:Pearson Edexcel International GCSE|Specification\s+[–-]\s+Issue\b)/i;

  const sections = [];
  let topicNo = null;
  let topic = null;
  let current = null;
  let started = false;

  const flush = () => {
    if (!current || !current.lines.some((line) => STATEMENT.test(line))) {
      current = null;
      return;
    }
    const body = current.lines.join("\n").trim();
    sections.push({
      ref: current.ref,
      topic: current.topic,
      content: `${current.topic}: ${current.ref}${current.title ? ` ${current.title}` : ""}\n${body}`,
    });
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = line.match(TOPIC_HEADING);
    if (heading) {
      flush();
      topicNo = heading[1];
      topic = heading[2].trim();
      const continuation = lines[i + 1] ?? "";
      const afterContinuation = lines[i + 2] ?? "";
      if (continuation.length <= 60 && /^[A-Z][A-Za-z &-]*$/.test(continuation)
          && (/^Students need\b/i.test(afterContinuation) || new RegExp(`^${topicNo}\\s+`).test(afterContinuation))) {
        topic += ` ${continuation}`;
        i++;
      }
      started = true;
      continue;
    }
    if (!started) continue;
    if (CONTENT_END.test(line)) {
      // The contents page lists every `Topic N:` heading before its own
      // "Assessment information" entry. Do not let that index occurrence
      // terminate parsing before we have seen a real numbered table row.
      if (!current && sections.length === 0) {
        topicNo = null;
        topic = null;
        started = false;
        continue;
      }
      flush();
      break;
    }
    if (TABLE_HEADER.test(line)) continue;
    if (SPEC_FOOTER.test(line)) continue;

    const subsection = line.match(SUBSECTION_ROW);
    if (subsection && topic && subsection[1].split(".")[0] === topicNo) {
      flush();
      const ref = subsection[1];
      const rest = subsection[2];
      const statementStart = rest.search(/(?:^|\s)\d{1,2}\.\d{1,2}\.\d{1,2}[A-Za-z]?\s+/);
      const title = statementStart >= 0 ? rest.slice(0, statementStart).trim() : rest.trim();
      const firstStatement = statementStart >= 0 ? rest.slice(statementStart).trim() : "";
      current = { ref, topic, title, lines: firstStatement ? [firstStatement] : [] };
      continue;
    }

    if (current) current.lines.push(line);
  }
  flush();

  return sections.filter((section) => section.content.length > 60);
}

/** "English Language A" ~ "english language a": for rejecting a topic that is
 *  just the subject's own name back again (see llmParseSyllabus below). */
const fold = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export async function llmParseSyllabus(pages, subjectName) {
  // A whole specification in one call overflows the model's output limit, so
  // read it in page batches and join what comes back.
  const BATCH = 8;
  const subjectFold = fold(subjectName);
  const out = [];
  for (let i = 0; i < pages.length; i += BATCH) {
    const text = pages.slice(i, i + BATCH).map((p) => p.text).join("\n\n").slice(0, 30000);
    if (text.trim().length < 400) continue;
    const { sections } = await generateJSON(
      `SUBJECT: ${subjectName}\n\nSYLLABUS (pages ${i + 1}-${Math.min(i + BATCH, pages.length)}):\n${text}`,
      SY_SCHEMA,
      { system: SY_SYSTEM, maxOutputTokens: 8192 },
    );
    out.push(...(sections ?? []).filter((s) => {
      if (!(s.content?.length > 40)) return false;
      // A topic that is just the subject's own name back again isn't a
      // vocabulary term: nothing can be classified as "that", specifically,
      // over anything else in the subject. Observed on English Language A,
      // from a paragraph about the qualification's overall structure rather
      // than its content.
      if (fold(s.topic) === subjectFold) return false;
      return true;
    }));
  }
  return out;
}
