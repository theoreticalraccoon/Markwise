// Specification ingestion. Its headings become the topic vocabulary every
// question is classified against, so ingest it before the papers.

import { generateJSON } from "./gemini.js";
import { cleanLines } from "./parse.js";

/* ---------------------------------------------------------------- syllabus -- */

// A top-level topic ("3 Waves", "B4 Enzymes"). Must not end in a digit, which
// rules out contents-page entries ("1 About this specification 1").
const TOPIC = /^([A-Z]?\d{1,2})\s+([A-Z][A-Za-z][A-Za-z ,&'’\-()/]{3,70})$/;

// "1.1 Integers". Edexcel puts the name in its own column, often the next line.
const SUBSECTION = /^([A-Z]?\d{1,2}\.\d{1,2}(?:\.\d{1,2})?)\s*(.*)$/;

// Anchored to line start: "subject content" also appears in assessment prose.
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
 * One chunk per numbered subsection. `topic` is the top-level heading, so the
 * vocabulary stays a handful of buckets a student recognises.
 * @returns {{ref,topic,content}[]}
 */
export function parseSyllabus(pages) {
  const lines = pages.flatMap((p) => cleanLines(p.text).map((l) => l.trim()));

  // The marker sits under the first topic heading, so start a little above it.
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
    // These headings also appear in the contents pages; ignore them early on.
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
 * The science layout: "1 Forces and motion", "(a) Units", "Students should:",
 * then "1.1 ...", "1.2P ...". One chunk per lettered sub-topic, since single
 * statements are too small to retrieve on their own.
 * @returns {{ref,topic,content}[]}
 */
export function parseSyllabusStatements(pages) {
  const lines = pages.flatMap((p) => cleanLines(p.text).map((l) => l.trim()));

  const TOPIC_LINE = /^(\d{1,2})\s+([A-Z][A-Za-z][A-Za-z ,&'’\-()/]{3,70})$/;
  const SUBTOPIC = /^\(([a-z])\)\s+(\S.{1,80})$/;
  const STATEMENT = /^(\d{1,2}\.\d{1,2}[A-Za-z]?)\s+(\S.*)$/;
  const STOP = /^(assessment (information|overview)|command words|glossary|appendix|grade descriptors?|the sample assessment)/i;

  // Content starts at the first "Students should:" and ends at the next section.
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

    // The heading version of "(a) Units" is the one followed by "Students should:";
    // the copy in the topic's list must not open a section.
    const s = line.match(SUBTOPIC);
    if (s && topic && /^students should:?$/i.test(lines[i + 1] ?? "")) {
      flush();
      current = { letter: s[1], title: s[2].trim(), statements: [] };
      continue;
    }

    if (!current) continue;
    if (STATEMENT.test(line)) current.statements.push(line);
    // Wrapped statements and formulae stay with the statement above.
    else if (current.statements.length) current.statements.push(line);
  }
  flush();

  return sections.filter((s) => s.content.length > 60);
}

/**
 * ICT's two-column content table. Text interleaves, but `1.2` opens a
 * subsection and `1.2.1` a statement, and `Topic N:` names the topic.
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
      // The contents page lists every "Topic N:" first; don't stop on that index.
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

// For comparing a topic with the subject name, ignoring case and punctuation.
const fold = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export async function llmParseSyllabus(pages, subjectName) {
  // A whole spec in one call overflows the output limit, so go 8 pages at a time.
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
      // A topic that's just the subject's name (English Language A did this) isn't vocabulary.
      if (fold(s.topic) === subjectFold) return false;
      return true;
    }));
  }
  return out;
}
