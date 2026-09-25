/**
 * Split question papers into parts and mark schemes into marking points.
 *
 * A deterministic parser runs first (exam papers are rigidly laid out); the
 * model only re-reads papers it gets wrong. Every emitted part has text AND a
 * mark allocation, because an unmarked fragment would let marking award marks
 * against nothing.
 */

import { generateJSON } from "./gemini.js";
import { LLM_PARSE } from "./config.js";

/* --------------------------------------------------------------- cleaning -- */

const NOISE = [
  // --- Cambridge ---
  /^©\s*UCLES/i,
  /^Permission to reproduce/i,
  /^Cambridge (International|Assessment)/i,
  /^Additional Materials/i,
  /^DO NOT WRITE IN THIS (MARGIN|AREA)$/i,
  // --- Edexcel / Pearson ---
  /\*[A-Z]?\d{4,6}[A-Z]\d{3,6}\*/,             // the *P73990A0328* item code
  /^Pearson (Edexcel|Education)/i,
  /^Answer ALL/i,
  /^Write your answers in the spaces provided/i,
  /^You must write down all the stages/i,
  /^(Total for Paper|TOTAL FOR PAPER)/i,
  /^International GCSE Mathematics?$/i,
  /^Formulae sheet/i,
  // --- both ---
  /^\d+\s*$/,                                  // bare page numbers
  /^\[?Turn over\]?$/i,
  /^BLANK PAGE$/i,
  /^\.{6,}$/,                                  // the answer-line dot leaders
  /^_{6,}$/,
  /^[\s.·]{10,}$/,
];

export function cleanLines(text) {
  return text
    .split("\n")
    // "DO NOT WRITE IN THIS AREA" gets glued onto neighbouring lines and hides
    // mark allocations and part labels, so it goes wherever it appears.
    .map((l) => l.replace(/DO NOT WRITE IN THIS (?:AREA|MARGIN)/gi, " ").replace(/ /g, " ").replace(/\.{4,}/g, " ").trimEnd())
    .filter((l) => l.trim() && !NOISE.some((re) => re.test(l.trim())));
}

/** Drop cover pages and formulae sheets: nothing markable, and they pollute retrieval. */
export function dropCoverPage(pages) {
  return pages.filter((p, i) => {
    if (i > 2) return true;
    const t = p.text.toLowerCase();
    return !(
      t.includes("read these instructions first") ||
      t.includes("candidate number") ||
      t.includes("write your name here") ||
      t.includes("formulae sheet") ||
      t.includes("information for candidates") ||
      (t.includes("this document has") && t.includes("blank"))
    );
  });
}

/* -------------------------------------------------------- question papers -- */

const Q_START = /^([AB]?\d{1,2})\s*(?:[).]|\s)\s*(.*)$/i;   // "3 A car travels…" / "A1 The origins…"
const PART = /^\*?\(([a-h])\s*\)\s*(.*)$/;                    // "(b) Explain…", "(c ) Discuss…"
const SUBPART = /^\(((?:i|v|x)+)\)\s*(.*)$/i;                 // "(ii) Calculate…"

// Cambridge puts marks in [3] at the line end, Edexcel in (3) on its own line.
const MARKS_BRACKET = /\[\s*(\d{1,2})\s*\]\s*$/;              // Cambridge: "… [3]"
const MARKS_ALONE = /^\(?\s*(\d{1,2})\s*\)$/;                 // Edexcel: "(2)"; some text layers lose the opening bracket
// Maths says "is 3 marks", the sciences "= 6 marks". Both close a question.
const MARKS_TOTAL = /\(Total for Question\s+[AB]?\d+\s*(?:is|=)\s*(\d+)\s+marks?\)/i;
const TASK_HEADING = /^Task\s+([AB]\d{1,2})([a-z])?\s*$/i;
const TASK_TOTAL = /^\(?(?:Total for Task)\s+([AB]\d{1,2})\s*(?:is|=)?\s*(\d+)(?:\s+marks?)?\)?$/i;

/**
 * Marks for one buffered block, plus the text without the mark-up. Parts don't
 * take the question total: it trails the last part and would inflate it.
 */
function extractMarks(lines, allowTotal) {
  let marks = null;
  const kept = [];

  for (const line of lines) {
    const alone = line.match(MARKS_ALONE);
    if (alone) {
      marks = Number(alone[1]);   // last one wins: it belongs to this part
      continue;
    }
    if (MARKS_TOTAL.test(line)) {
      if (allowTotal && marks === null) marks = Number(line.match(MARKS_TOTAL)[1]);
      continue;                   // never keep the total line in the text
    }
    kept.push(line);
  }

  let text = kept.join("\n").trim();
  const bracket = text.match(MARKS_BRACKET);
  if (bracket) {
    marks = Number(bracket[1]);
    text = text.replace(MARKS_BRACKET, "").trim();
  }
  return { marks, text };
}

/** @returns {{questionNo,questionRoot,text,marks,page}[]} */
export function parseQuestionPaper(pages) {
  if (isPracticalTaskPaper(pages)) return parsePracticalTaskPaper(pages);

  const out = [];
  let root = null, part = null, sub = null;
  let buf = [];
  let startPage = 1;

  // Stems ("1 A car accelerates from rest.") earn no marks but every part needs
  // them, so they're carried down rather than emitted.
  let rootStem = "", partStem = "";

  const flush = () => {
    if (!root) { buf = []; return; }
    const lines = buf;
    buf = [];
    if (!lines.length) return;

    // A "Total for Question" line only counts at whole-question level.
    const { marks, text: clean } = extractMarks(lines, part === null && sub === null);
    if (!clean) return;

    // No mark allocation → this is a stem, not a markable part.
    if (marks === null) {
      if (part === null) rootStem = clean;
      else if (sub === null) partStem = clean;
      // An un-marked sub-part is dropped: there is nothing to mark against it.
      return;
    }

    const stem = [rootStem, sub !== null ? partStem : ""].filter(Boolean).join("\n");
    out.push({
      questionRoot: String(root),
      questionNo: root + (part ? `(${part})` : "") + (sub ? `(${sub})` : ""),
      text: stem ? `${stem}\n${clean}` : clean,
      marks,
      page: startPage,
    });
  };

  // On papers that print "(Total for Question N ...)", a new question can only
  // start after that line. Otherwise a numbered list inside a question looks
  // exactly like the next question starting.
  const printsTotals = pages.some((p) => MARKS_TOTAL.test(p.text));
  let closed = true;   // nothing to close before question 1

  for (const page of pages) {
    // Pages with a question-number margin carry markers from pdf.js. There, a
    // plain "17 chose knitting" line is data, never a question.
    const marked = page.text.includes("⟦Q");

    for (const raw of cleanLines(page.text)) {
      let line = raw.trim();
      if (MARKS_TOTAL.test(line)) closed = true;

      let qm = null;
      const m = line.match(/^⟦Q([AB]?\d{1,2})⟧\s*(.*)$/i);
      if (m) {
        // A margin number is trusted, but only as exactly the next number:
        // diagram labels ("12 cm") sit in the margin too.
        const n = m[1].toUpperCase();
        const exact = isNextQuestion(n, root, { strict: true }) && (!printsTotals || closed);
        if (exact) qm = [null, m[1], m[2] ?? ""];
        else line = (m[2] ?? "").trim();          // stray marker: keep its text
        if (!qm && !line) continue;
      } else if (!marked) {
        // Unmarked page: fall back to reading the text.
        const t = line.match(Q_START);
        if (t && isNextQuestion(t[1], root) && opensAQuestion(t[2]) && (!printsTotals || closed)) qm = t;
      }

      if (qm) {
        flush();
        closed = false;
        root = String(qm[1]).toUpperCase();
        part = null;
        sub = null;
        rootStem = "";
        partStem = "";
        startPage = page.n;
        // "6 (a) Simplify ..." has the number and first part on one line; peel the
        // label or 6(a) comes out as "6" and never pairs.
        const peeled = peelLabels(qm[2] ?? "");
        part = peeled.part;
        sub = peeled.sub;
        if (peeled.rest) buf.push(peeled.rest);
        continue;
      }

      const sm = line.match(SUBPART);
      if (sm && root) {
        flush();
        sub = sm[1].toLowerCase();
        startPage = page.n;
        if (sm[2]) buf.push(sm[2]);
        continue;
      }

      const pm = line.match(PART);
      if (pm && root) {
        flush();
        part = pm[1];
        sub = null;
        partStem = "";
        startPage = page.n;
        // "(a) (i) Work out …". The sub-part can share the line too.
        const peeled = peelLabels(pm[2] ?? "", { partsAlreadyTaken: true });
        sub = peeled.sub;
        if (peeled.rest) buf.push(peeled.rest);
        continue;
      }

      if (root) buf.push(line);
    }
  }
  flush();

  return dedupe(out.filter((q) => q.text.length > 8));
}

function isPracticalTaskPaper(pages) {
  const text = pages.map((page) => page.text).join("\n");
  return /\bTask\s+[AB]\d{1,2}[a-z]?\b/i.test(text) && /Total for Task\s+[AB]\d{1,2}/i.test(text);
}

/** ICT practical papers label assessed work as Task A1a rather than Q1(a). */
function parsePracticalTaskPaper(pages) {
  const out = [];
  const rootStems = new Map();
  let current = null;

  const flush = () => {
    if (!current) return;
    const allocations = [];
    let taskTotal = null;
    const kept = [];
    for (const line of current.lines) {
      const allocation = line.match(MARKS_ALONE);
      if (allocation) {
        allocations.push(Number(allocation[1]));
        continue;
      }
      const total = line.match(TASK_TOTAL);
      if (total) {
        taskTotal = Number(total[2]);
        continue;
      }
      kept.push(line);
    }

    const clean = kept.join("\n").trim();
    const marks = allocations.length
      ? allocations.reduce((sum, value) => sum + value, 0)
      : (!current.part ? taskTotal : null);

    if (marks && clean.length > 8) {
      const stem = current.part ? rootStems.get(current.root) : "";
      out.push({
        questionRoot: current.root,
        questionNo: current.root + (current.part ? `(${current.part})` : ""),
        text: stem ? `${stem}\n${clean}` : clean,
        marks,
        page: current.page,
      });
    } else if (!current.part && clean) {
      rootStems.set(current.root, clean);
    }
    current = null;
  };

  for (const page of pages) {
    for (const raw of cleanLines(page.text)) {
      const line = raw.trim();
      const task = line.match(TASK_HEADING);
      if (task) {
        flush();
        const root = task[1].toUpperCase();
        const part = task[2]?.toLowerCase() ?? null;
        if (!part) rootStems.delete(root);
        current = { root, part, page: page.n, lines: [] };
        continue;
      }
      if (current) current.lines.push(line);
    }
  }
  flush();
  return dedupe(out.filter((task) => task.text.length > 8));
}

/**
 * Keep the first of each question number. A repeat means the parser lost its
 * place; drops are counted so looksParsed can hand the paper to the model.
 */
function dedupe(parts) {
  const seen = new Set();
  const out = [];
  let dropped = 0;
  for (const p of parts) {
    const key = p.questionNo;
    if (seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    out.push(p);
  }
  out.duplicatesDropped = dropped;
  return out;
}

/** Peel leading "(a)" / "(ii)" labels so each part gets its own chunk. */
function peelLabels(text, { partsAlreadyTaken = false } = {}) {
  let rest = text.trim();
  let part = null;
  let sub = null;

  if (!partsAlreadyTaken) {
    const p = rest.match(PART);
    if (p) {
      part = p[1];
      rest = p[2].trim();
    }
  }
  const s = rest.match(SUBPART);
  if (s) {
    sub = s[1].toLowerCase();
    rest = s[2].trim();
  }
  return { part, sub, rest };
}

/** "B3" -> { prefix: "B", number: 3 }. */
function splitQuestionRoot(value) {
  const match = String(value ?? "").toUpperCase().match(/^([AB]?)(\d{1,2})$/);
  return match ? { prefix: match[1], number: Number(match[2]) } : null;
}

// A small forward jump lets the parser resync after missing a question; it never
// goes backwards, so a "1 4 7 10" list inside a question can't reset it.
function isNextQuestion(value, current, { strict = false } = {}) {
  const next = splitQuestionRoot(value);
  const previous = splitQuestionRoot(current);
  if (!next || next.number < 1) return false;
  if (!previous) return next.number <= 2; // papers occasionally start at 2
  if (next.prefix === previous.prefix) {
    return next.number > previous.number && next.number <= previous.number + (strict ? 1 : 3);
  }
  return previous.prefix &&
    next.prefix.charCodeAt(0) === previous.prefix.charCodeAt(0) + 1 &&
    next.number <= 2;
}

/** Part label, or enough prose to rule out diagram units like "12 m". */
function opensAQuestion(rest) {
  const text = (rest ?? "").trim();
  return text.startsWith("(") || text.length >= 10;
}

/* ------------------------------------------------------------ mark schemes -- */

// Mark schemes are tables (ref | answer | marks | guidance). Flattened, the ref
// still starts a row and the mark count ends it.
// \*? handles starred questions ("1*"), which otherwise lose the whole question.
const MS_ROW = /^([AB]?\d{1,2})\*?\s*(?:\(([a-h])\))?\s*(?:\(((?:i|v|x)+)\))?(?:\s+(.*))?$/i;
const MS_COMPACT_ROW = /^([AB]?\d{1,2})([a-h])(?:(?:\(((?:i|v|x)+)\))|((?:i|v|x)+))?(?:\s+(\S.*))?$/i;

// Edexcel repeats the table header above every question. Where it does, that
// is the safest row boundary: working like "2 card = 6" looks just like Q2.
const MS_HEADER = /^(?:(?:q|question)\b.*\b(?:answer|working|indicative content|mark scheme)\b.*|question\s+mp\b.*\bmarks?|question(?:\s+number)?|answer\b.*\bmarks?)$/i;

// Superscript ordinals ("1st") split onto their own line during extraction.
const MS_TOTAL_ROW = /^Total\s+\d{1,3}\s+marks?\b/i;
const MS_JUNK = /^(st|nd|rd|th|oe|cao|ft|isw|dep|indep|awrt)$/i;
// Rows that give only the part, or only the sub-part, inheriting what is above.
const MS_PART_ONLY = /^\(([a-h])\)\s*(?:\(((?:i|v|x)+)\))?(?:\s+(.*))?$/i;
const MS_SUB_ONLY = /^\(((?:i|v|x)+)\)(?:\s+(.*))?$/i;

export function parseMarkScheme(pages) {
  if (isPracticalTaskMarkScheme(pages)) return parsePracticalTaskMarkScheme(pages);

  const rows = [];
  let current = null;
  let root = null;   // the question number rows are currently under
  let part = null;   // and the part, for rows that give only a sub-part

  const flush = () => {
    if (!current) return;
    const text = current.lines.join("\n").trim();
    if (text) {
      rows.push({
        questionNo: current.questionNo,
        questionRoot: current.questionRoot,
        text: text.replace(/\s*\|\s*/g, " · "),
        marks: current.marks ?? trailingMarks(text),
      });
    }
    current = null;
  };

  const open = (n, p, sub, rest) => {
    flush();
    root = n;
    part = p ?? null;
    current = {
      questionRoot: String(n),
      questionNo: String(n) +
        (p ? `(${p.toLowerCase()})` : "") +
        (sub ? `(${sub.toLowerCase()})` : ""),
      lines: rest ? [rest] : [],
      marks: leadingMarks(rest),
    };
  };

  const all = pages.flatMap((p) => cleanLines(p.text).map((l) => l.trim()));
  const letteredRoots = all.some((line) => /^[AB]\d{1,2}\s*\([a-h]\)/i.test(line));

  // Trust restated headers when there are several; otherwise use numbering.
  const headerGated = all.filter((l) => MS_HEADER.test(l)).length >= 3;
  const markPointLayout = all.some((line) => /^Question\s+mp\b/i.test(line));
  let afterHeader = false;

  for (const line of all) {
    if (MS_HEADER.test(line)) {
      afterHeader = true;
      continue;
    }
    if (MS_JUNK.test(line)) continue;
    if (/^(guidance|mark scheme|notes)$/i.test(line)) continue;

    // "Total 3 marks" closes a question; the next often has no header.
    if (MS_TOTAL_ROW.test(line)) {
      if (current) current.lines.push(line);
      afterHeader = true;
      continue;
    }

    // ICT schemes compact identifiers (1a, 1hi, 2aiii). Only safe under headers.
    const compact = line.match(MS_COMPACT_ROW);
    if (headerGated && afterHeader && compact) {
      const n = compact[1].toUpperCase();
      if (n === root || isNextQuestion(n, root, { strict: true })) {
        open(n, compact[2], compact[3] ?? compact[4], compact[5]);
        afterHeader = false;
        continue;
      }
    }
    if (markPointLayout && /^[A-Z]\d{1,2}$/.test(line)) continue;

    {
      const m = line.match(MS_ROW);
      if (m) {
        const n = m[1].toUpperCase();
        const [, , part, sub, rest] = m;

        // History schemes start with level tables numbered 0, 1, 2 before A1/B1.
        if (letteredRoots && (!/^[AB]/.test(n) || !part)) continue;

        // Schemes run in question order, so only accept the next number (or the same
        // one with a new part). That rejects working like "3 × n + k". Under a header,
        // only the next number is trusted: stacked fractions like "12 12" look like rows.
        const isNext = isNextQuestion(n, root, { strict: true });
        const startsNewQuestion = headerGated ? afterHeader && (markPointLayout || isNext) : isNext;
        const continuesSameQuestion = n === root && (part || sub);

        if (startsNewQuestion || continuesSameQuestion) {
          open(n, part, sub, rest);
          afterHeader = false;
          continue;
        }
        // Falls through: it is body text of the current row.
      }

      // "(b) 1 B1 …" under the question opened above.
      const po = line.match(MS_PART_ONLY);
      if (po && root !== null) {
        open(root, po[1], po[2], po[3]);
        continue;
      }

      // "(ii) 1 B1 …": inherits both the question and the part above it.
      const so = line.match(MS_SUB_ONLY);
      if (so && root !== null) {
        open(root, part, so[1], so[2]);
        continue;
      }
    }

    if (current) current.lines.push(line);
  }
  flush();
  return rows;
}

function isPracticalTaskMarkScheme(pages) {
  const text = pages.map((page) => page.text).join("\n");
  return /\bTask\s+Answer\s+Marks\b/i.test(text) && /Total for Task\s+[AB]\d{1,2}/i.test(text);
}

/** Segment an ICT practical mark scheme on its task and lower-case part rows. */
function parsePracticalTaskMarkScheme(pages) {
  const rows = [];
  const lines = pages.flatMap((page) => cleanLines(page.text).map((line) => line.trim()));
  let root = null;
  let rootStem = "";
  let current = null;
  let readyForRoot = false;
  let sawPart = false;
  const lastPartByRoot = new Map();

  const emit = () => {
    if (!current) return;
    const body = current.lines.join("\n").trim();
    const text = current.part && rootStem ? `${rootStem}\n${body}`.trim() : body;
    if (text.length > 4) {
      rows.push({
        questionRoot: current.root,
        questionNo: current.root + (current.part ? `(${current.part})` : ""),
        text,
        marks: trailingMarks(body),
      });
    }
    if (current.part) lastPartByRoot.set(current.root, current.part);
    current = null;
  };

  for (const line of lines) {
    if (/^Task\s+Answer\s+Marks$/i.test(line)) {
      readyForRoot = true;
      continue;
    }
    if (/^Total for Task\b/i.test(line)) {
      emit();
      readyForRoot = true;
      continue;
    }

    const joinedPartRow = line.match(/^([AB]\d{1,2})([a-h])(?:\s+(.*))?$/);
    if (joinedPartRow) {
      const nextRoot = joinedPartRow[1].toUpperCase();
      const nextPart = joinedPartRow[2].toLowerCase();
      const canOpenRoot = readyForRoot
        && (nextRoot === root || isNextQuestion(nextRoot, root, { strict: true }));
      const canContinueRoot = nextRoot === root
        && current
        && nextPart === String.fromCharCode((current.part ?? "`").charCodeAt(0) + 1);
      if (canOpenRoot || canContinueRoot) {
        emit();
        root = nextRoot;
        rootStem = "";
        current = { root, part: nextPart, lines: joinedPartRow[3] ? [joinedPartRow[3]] : [] };
        readyForRoot = false;
        sawPart = true;
        continue;
      }
    }

    const rootRow = line.match(/^([AB]\d{1,2})(?:\s+(\S.*))?$/i);
    if (readyForRoot && rootRow
        && (rootRow[1].toUpperCase() === root || isNextQuestion(rootRow[1], root, { strict: true }))) {
      emit();
      root = rootRow[1].toUpperCase();
      rootStem = rootRow[2]?.trim() ?? "";
      current = { root, part: null, lines: rootStem ? [rootStem] : [] };
      readyForRoot = false;
      sawPart = false;
      continue;
    }

    const partRow = line.match(/^([a-h])(?:\s*\(((?:i|v|x)+)\))?(?:\s+(.*))?$/);
    const previousPart = current ? lastPartByRoot.get(current.root) : null;
    const expectedPart = current && sawPart
      ? String.fromCharCode(current.part.charCodeAt(0) + 1)
      : (previousPart ? String.fromCharCode(previousPart.charCodeAt(0) + 1) : "a");
    if (current && partRow && partRow[1] === expectedPart
        && (sawPart || previousPart || !partRow[3] || /^[A-Z]/.test(partRow[3]))) {
      if (!sawPart) {
        rootStem = current.lines.join("\n").trim();
      } else {
        emit();
      }
      sawPart = true;
      const firstLine = [partRow[2] ? `(${partRow[2]})` : "", partRow[3] ?? ""].filter(Boolean).join(" ");
      current = { root, part: partRow[1], lines: firstLine ? [firstLine] : [] };
      continue;
    }

    if (current) current.lines.push(line);
  }
  emit();
  return rows;
}


function trailingMarks(text) {
  const m = text.match(/(?:^|\s)(\d{1,2})\s*$/);
  return m ? Number(m[1]) : null;
}

function leadingMarks(text) {
  const m = text?.match(/\b(\d{1,2})\s*marks?\b/i);
  return m ? Number(m[1]) : null;
}

/* ----------------------------------------------------------- LLM fallback -- */

const PARSE_SCHEMA = {
  type: "object",
  properties: {
    parts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          questionNo: { type: "string", description: "e.g. 4(b)(ii)" },
          text: { type: "string", description: "The question text, verbatim." },
          marks: { type: "number" },
        },
        required: ["questionNo", "text", "marks"],
      },
    },
  },
  required: ["parts"],
};

const PARSE_SYSTEM = `
You segment IGCSE exam papers into individual question parts.

Rules:
- Copy the question text VERBATIM. Never summarise, correct, or complete it.
- One entry per markable part. If 4(a) has parts (i) and (ii), emit 4(a)(i) and
  4(a)(ii), not 4(a).
- marks is the number in square brackets at the end of the part.
- Include the parent stem in a part's text when the part cannot be understood
  without it (e.g. repeat "Fig 2.1 shows a circuit." at the top of 2(a)).
- Skip cover pages, blank pages, formula sheets and answer lines.
- If a part has no mark allocation, omit it entirely.
`.trim();

/** Model re-parse for papers the regex pass couldn't read (scans, two-column maths). */
export async function llmParseQuestions(pages, hint = "") {
  if (!LLM_PARSE) return [];
  const text = pages.map((p) => p.text).join("\n\n").slice(0, 60000);
  if (text.replace(/\s/g, "").length < 200) return [];

  // Output is mostly a copy of the input, so budget for it. 8192 truncated a
  // 100-mark Maths B paper mid-JSON.
  const { parts } = await generateJSON(
    `${hint ? `PAPER: ${hint}\n\n` : ""}PAGES:\n${text}`,
    PARSE_SCHEMA,
    { system: PARSE_SYSTEM, maxOutputTokens: 32768 },
  );
  return (parts ?? [])
    .filter((p) => p.text && p.marks > 0)
    .map((p) => ({
      questionNo: p.questionNo,
      questionRoot: String(p.questionNo).match(/^[AB]?\d+/i)?.[0]?.toUpperCase() ?? "",
      text: p.text,
      marks: p.marks,
      page: null,
    }));
}

const MS_SCHEMA = {
  type: "object",
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          questionNo: { type: "string" },
          text: { type: "string", description: "Marking points, verbatim, one per line." },
          marks: { type: "number" },
        },
        required: ["questionNo", "text", "marks"],
      },
    },
  },
  required: ["rows"],
};

const MS_SYSTEM = `
You transcribe IGCSE mark scheme tables into rows.

Rules:
- Copy marking points VERBATIM, including "accept", "reject", "or equivalent",
  "ora", "owtte" and any alternatives separated by "/".
- Keep the guidance column. It is where the accept/reject rules live.
- One row per question part, matching the question numbering of the paper.
- marks is the mark allocation for that part.
- Never paraphrase. A paraphrased mark scheme cannot be marked against.
`.trim();

export async function llmParseMarkScheme(pages, hint = "") {
  if (!LLM_PARSE) return [];
  const text = pages.map((p) => p.text).join("\n\n").slice(0, 60000);
  if (text.replace(/\s/g, "").length < 200) return [];

  const { rows } = await generateJSON(
    `${hint ? `MARK SCHEME: ${hint}\n\n` : ""}PAGES:\n${text}`,
    MS_SCHEMA,
    { system: MS_SYSTEM, maxOutputTokens: 32768 },
  );
  return (rows ?? []).map((r) => ({
    questionNo: r.questionNo,
    questionRoot: String(r.questionNo).match(/^[AB]?\d+/i)?.[0]?.toUpperCase() ?? "",
    text: r.text,
    marks: r.marks ?? null,
  }));
}

/* --------------------------------------------------------------- quality -- */

/** The paper's own printed total: an independent check on the parse. */
export function printedTotal(pages) {
  const text = pages.map((p) => p.text).join("\n");
  const hit =
    text.match(/TOTAL\s+FOR\s+PAPER\s*(?:IS|=|:)?\s*(\d{1,3})\s*MARKS?/i) ??
    text.match(/total\s+mark\s+for\s+this\s+paper\s+is\s+(\d{2,3})/i) ??
    text.match(/maximum\s+mark\s*:?\s*(\d{2,3})/i);
  return hit ? Number(hit[1]) : null;
}

// Papers that offer a choice ("Answer TWO questions from Section A") print more
// marks than their total, so the total check doesn't apply. "Answer ALL" doesn't match.
const OFFERS_CHOICE = /\banswer\s+(?:one|two|three|four|five|\d+)\s+questions?\b/i;
export function offersChoice(pages) {
  return OFFERS_CHOICE.test(pages.map((p) => p.text).join("\n"));
}

/** "(Total for Question 7 is 4 marks)" for every question that prints one. */
export function printedQuestionTotals(pages) {
  const text = pages.map((p) => p.text).join("\n");
  const totals = new Map();
  for (const m of text.matchAll(/\(\s*Total\s+for\s+Question\s+([AB]?\d{1,2})\s*(?:is|=)\s*(\d{1,3})\s*marks?\s*\)/gi)) {
    totals.set(m[1].toUpperCase(), Number(m[2]));
  }
  return totals;
}

function alternativePartGroups(pages) {
  const text = pages.map((p) => p.text).join("\n");
  const groups = [];
  const seen = new Set();
  const patterns = [
    /(?:Answer\s+)?EITHER\s+\(([a-h])\s*\)\s*\(((?:i|v|x)+)\)\s+OR\s+(?:\(\1\s*\)\s*)?\(((?:i|v|x)+)\)/gi,
    /\bEITHER\s+\(([a-h])\s*\)\s*\(((?:i|v|x)+)\)[\s\S]{0,4000}?\nOR\s*\n\s*(?:\(\1\s*\)\s*)?\(((?:i|v|x)+)\)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const key = `${match[1].toLowerCase()}:${match[2].toLowerCase()}:${match[3].toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      groups.push({
        part: match[1].toLowerCase(),
        alternatives: [match[2].toLowerCase(), match[3].toLowerCase()],
      });
    }
  }
  return groups;
}

function candidateMarks(parts, root, alternativeGroups) {
  const matching = parts.filter((part) => String(part.questionRoot).toUpperCase() === root);
  let total = matching.reduce((sum, part) => sum + (part.marks || 0), 0);
  for (const group of alternativeGroups) {
    const alternatives = group.alternatives.map((sub) =>
      matching.find((part) => part.questionNo.toLowerCase() === `${root.toLowerCase()}(${group.part})(${sub})`),
    ).filter(Boolean);
    if (alternatives.length < 2) continue;
    total -= alternatives.reduce((sum, part) => sum + (part.marks || 0), 0);
    total += Math.max(...alternatives.map((part) => part.marks || 0));
  }
  return total;
}

/**
 * Does the parse add up? Question numbers run without gaps, marks sum to the
 * printed total (unless the paper offers a choice), and each question's parts
 * sum to its own printed total. Before this, Maths A papers missing 2-6
 * questions (85/100, 82/100) passed.
 */
export function consistency(parts, pages) {
  const roots = [...new Set(parts.map((p) => String(p.questionRoot).toUpperCase()))]
    .map(splitQuestionRoot)
    .filter(Boolean)
    .sort((a, b) => a.prefix.localeCompare(b.prefix) || a.number - b.number);
  const rootLabels = roots.map((root) => `${root.prefix}${root.number}`);
  const top = roots.length ? rootLabels[rootLabels.length - 1] : 0;
  const missing = [];
  for (const prefix of [...new Set(roots.map((root) => root.prefix))]) {
    const numbers = roots.filter((root) => root.prefix === prefix).map((root) => root.number);
    for (let n = Math.min(...numbers); n <= Math.max(...numbers); n++) {
      if (!numbers.includes(n)) missing.push(prefix ? `${prefix}${n}` : n);
    }
  }

  const sum = parts.reduce((n, p) => n + (p.marks || 0), 0);
  const printed = printedTotal(pages ?? []);
  // Choice papers are meant to exceed the total, so skip that check for them.
  const choice = pages ? offersChoice(pages) : false;
  const totalOk = printed === null || choice ? null : sum === printed;

  // Question by question: the parts of Q7 must add up to Q7's own total.
  const wanted = printedQuestionTotals(pages ?? []);
  const alternatives = alternativePartGroups(pages ?? []);
  const mismatched = [];
  for (const [q, want] of wanted) {
    const got = candidateMarks(parts, q, alternatives);
    if (got !== want) mismatched.push({ question: q, got, want });
  }

  return {
    questions: rootLabels.length,
    lastQuestion: top,
    missing,
    sum,
    printed,
    mismatched,
    ok: missing.length === 0 && totalOk !== false && mismatched.length === 0,
  };
}

/** Did the regex pass work? Enough parts, mostly with marks, and (given pages) consistent. */
export function looksParsed(parts, pages = null) {
  if (parts.length < 3) return false;
  // Lots of duplicates means it lost its place; let the model re-read.
  if ((parts.duplicatesDropped ?? 0) > parts.length * 0.2) return false;
  const withMarks = parts.filter((p) => p.marks > 0).length;
  if (withMarks / parts.length < 0.5) return false;
  if (pages && !consistency(parts, pages).ok) return false;
  return true;
}
