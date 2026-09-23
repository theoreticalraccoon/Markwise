/**
 * Splitting papers into question parts, and mark schemes into marking points.
 *
 * This is the hardest part of the project and the reason a general chatbot
 * cannot do what Markwise does. Two strategies run in order:
 *
 *   1. A deterministic parser. Exam papers are rigidly formatted. A question
 *      starts at column zero with "3", parts are "(a)", sub-parts are "(ii)",
 *      and the mark allocation is "[4]" at the end of the last line of the
 *      part. When this works it is exact, free, and fast.
 *
 *   2. An LLM repair pass, used only on the questions the deterministic parser
 *      rejected (no marks found, implausible length, no part structure). This
 *      keeps token spend proportional to how badly a given paper is laid out
 *      rather than to how many papers there are.
 *
 * Everything downstream assumes the invariant this module enforces: a part is
 * only emitted if it has text AND a mark allocation. An unmarked fragment
 * would pollute retrieval and, worse, let the marking route award marks
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
    // "DO NOT WRITE IN THIS AREA" is printed in the margin and extraction glues
    // it onto whatever shares its line: "(1) DO NOT WRITE IN THIS AREA" hid a
    // mark allocation, and "...AREA(c) Use your graph" hid a part label. Neither
    // is ever content, so it goes wherever it appears.
    .map((l) => l.replace(/DO NOT WRITE IN THIS (?:AREA|MARGIN)/gi, " ").replace(/ /g, " ").replace(/\.{4,}/g, " ").trimEnd())
    .filter((l) => l.trim() && !NOISE.some((re) => re.test(l.trim())));
}

/**
 * Strip the front matter. Both boards open with a cover page of candidate
 * details and instructions, and Edexcel maths papers add a formulae sheet
 * none of it is markable and all of it pollutes retrieval.
 */
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

// The two boards mark up mark allocations differently and both must be read.
const MARKS_BRACKET = /\[\s*(\d{1,2})\s*\]\s*$/;              // Cambridge: "… [3]"
const MARKS_ALONE = /^\(?\s*(\d{1,2})\s*\)$/;                 // Edexcel: "(2)"; some text layers lose the opening bracket
// Maths prints "(Total for Question 1 is 3 marks)"; the sciences print
// "(Total for Question 8 = 6 marks)". Only the first was recognised, so on a
// Physics paper the total line was kept as question text and a whole-question
// mark allocation (all an extended-response question has) was never read.
const MARKS_TOTAL = /\(Total for Question\s+[AB]?\d+\s*(?:is|=)\s*(\d+)\s+marks?\)/i;
const TASK_HEADING = /^Task\s+([AB]\d{1,2})([a-z])?\s*$/i;
const TASK_TOTAL = /^\(?(?:Total for Task)\s+([AB]\d{1,2})\s*(?:is|=)?\s*(\d+)(?:\s+marks?)?\)?$/i;

/**
 * Marks for one buffered block, and the block with the mark-up removed.
 *
 * `allowTotal` is false for parts: "(Total for Question 1 is 3 marks)" trails
 * the *last part* of a question, and crediting that part with the whole
 * question's marks would inflate every final part on an Edexcel paper.
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

/**
 * @returns {{questionNo,questionRoot,text,marks,page}[]}
 */
export function parseQuestionPaper(pages) {
  if (isPracticalTaskPaper(pages)) return parsePracticalTaskPaper(pages);

  const out = [];
  let root = null, part = null, sub = null;
  let buf = [];
  let startPage = 1;

  // Stems: the un-marked text that introduces the parts beneath it. "1 A car
  // accelerates from rest." earns no marks itself but every part of question 1
  // is meaningless without it, so it is carried down rather than emitted.
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

  // Edexcel closes every question with "(Total for Question N is/= M marks)".
  // Where a paper does that, a new question can only begin AFTER that line: a
  // numbered list inside a question ("1 the mass, 2 the speed") is set in the
  // same margin column as question numbers and otherwise looks exactly like the
  // next question starting, which cut question 1 in two and lost its parts.
  const printsTotals = pages.some((p) => MARKS_TOTAL.test(p.text));
  let closed = true;   // nothing to close before question 1

  for (const page of pages) {
    // Pages laid out with a question-number margin carry explicit markers, put
    // there from the position of the number on the page. On those pages a
    // plain "17 chose knitting" line is data, never a question start.
    const marked = page.text.includes("⟦Q");

    for (const raw of cleanLines(page.text)) {
      let line = raw.trim();
      if (MARKS_TOTAL.test(line)) closed = true;

      let qm = null;
      const m = line.match(/^⟦Q([AB]?\d{1,2})⟧\s*(.*)$/i);
      if (m) {
        // Trusted: its position says it is a question number. It only has to be
        // a plausible next one, and needs no prose after it (a diagram-only
        // stem has none).
        // Exactly the next number, not "within 3": diagram labels sit in the
        // margin too ("12 cm" beside a figure in question 9), and a loose rule
        // let one of them jump the sequence to 12 and lose 10 and 11.
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
        // "6 (a) Simplify ..." puts the question number and its first part on one
        // line. Without peeling the label off here, 6(a) is emitted as a bare
        // "6" and then fails to pair with the scheme's 6(a) row.
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
 * One chunk per question part, keeping the first occurrence.
 *
 * A repeated question number is never legitimate. It means the parser lost
 * track of where it was. Keeping the duplicates would put the same question in
 * a mock paper twice and split its marks across several rows, so they are
 * dropped here and counted, so `looksParsed` can send a badly-confused paper to
 * the model instead.
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

/**
 * Strip leading "(a)" / "(ii)" labels from the start of a line.
 *
 * Papers put the question number, its first part and sometimes its first
 * sub-part on one line. Each label that stays buried in the text is a part
 * that never gets its own chunk and never pairs with its mark scheme row.
 */
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

/**
 * Is this the next question number?
 *
 * Strictly "current + 1" is too brittle. When one question's opening line is
 * missed, a diagram-heavy stem, an odd font, the parser sticks on the
 * previous number and every subsequent "(a)" and "(b)" is attributed to it,
 * producing eight copies of "2(b)" with the wrong text. Allowing a small
 * forward jump lets it resynchronise, while staying forward-only stops a
 * numeric sequence inside a question ("1 4 7 10") from resetting it.
 */
function splitQuestionRoot(value) {
  const match = String(value ?? "").toUpperCase().match(/^([AB]?)(\d{1,2})$/);
  return match ? { prefix: match[1], number: Number(match[2]) } : null;
}

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

/**
 * Does the text after a question number look like the start of a question?
 *
 * A part label always does. Otherwise it has to be long enough to be prose
 * which rejects the units and measurements that litter diagrams ("12 m",
 * "9 cm") without needing to know what the diagram shows.
 */
function opensAQuestion(rest) {
  const text = (rest ?? "").trim();
  return text.startsWith("(") || text.length >= 10;
}

/* ------------------------------------------------------------ mark schemes -- */

/**
 * Cambridge mark schemes are tables: question ref | answer | marks | guidance.
 * Text extraction flattens them, but the question ref reliably starts a row and
 * the mark count reliably ends it, which is enough to segment on.
 */
// The `\*?` is for starred questions ("1*": assessed for written
// communication), which otherwise fail to match and lose the whole question.
const MS_ROW = /^([AB]?\d{1,2})\*?\s*(?:\(([a-h])\))?\s*(?:\(((?:i|v|x)+)\))?(?:\s+(.*))?$/i;
const MS_COMPACT_ROW = /^([AB]?\d{1,2})([a-h])(?:(?:\(((?:i|v|x)+)\))|((?:i|v|x)+))?(?:\s+(\S.*))?$/i;

// Edexcel restates the table header above every question. Where that happens
// it is the most reliable row boundary in the document: far better than the
// numbering, because working like "2 card = 6" is indistinguishable from the
// start of question 2 by any other means.
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

  // Two layouts, decided from the document itself. When the header is restated
  // throughout, trust it; when it appears once or twice (Cambridge prints it
  // per page at most), fall back to the numbering.
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

    // "Total 3 marks" closes a question. The next question often follows with
    // no restated header at all (Q16 sits straight under Q15 on the same page),
    // so this is a row boundary just as the header is.
    if (MS_TOTAL_ROW.test(line)) {
      if (current) current.lines.push(line);
      afterHeader = true;
      continue;
    }

    // ICT written-paper schemes compact the whole identifier into one token:
    // `1a`, `1hi`, `2aiii`. The repeated table header makes these safe row
    // boundaries; outside that layout the same shape could be ordinary data.
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

        // History mark schemes open with generic level tables numbered 0, 1,
        // 2... before the real A1/B1 rows. Once the document declares lettered
        // roots, those rubric levels are never question identities.
        if (letteredRoots && (!/^[AB]/.test(n) || !part)) continue;

        // Mark schemes are printed in question order, and flattening a table
        // to text turns working like "3 × n + k" into something that looks
        // exactly like the start of question 3. Requiring the number to be the
        // next one, or the same one with a new part label, rejects those
        // without needing to understand the mathematics.
        // Where the header is restated the boundary is trusted, but only for
        // the next question number. The first line under a header can be
        // stacked-fraction working ("12 12") that reads as a row for question
        // 12, and taking it lost the real row for question 15 that followed.
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

/**
 * Re-parse pages with the model. Used when the deterministic parser produced
 * nothing usable: typically OCR'd scans, or maths papers whose layout is
 * two-column.
 */
export async function llmParseQuestions(pages, hint = "") {
  if (!LLM_PARSE) return [];
  const text = pages.map((p) => p.text).join("\n\n").slice(0, 60000);
  if (text.replace(/\s/g, "").length < 200) return [];

  // Output is mostly a verbatim copy of the input, so it needs a budget on
  // the same order as the input itself: 8192 was tight enough that a dense
  // paper (observed: a 100-mark Maths B paper) got cut off mid-JSON and the
  // whole re-read was thrown away, keeping the worse deterministic parse.
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

/**
 * The total the paper says it is worth.
 *
 * Edexcel prints "TOTAL FOR PAPER IS 100 MARKS" at the end; Cambridge prints
 * "Total marks: 100" on the cover. Reading it gives the parser something it
 * has never had: an independent number to check its own output against.
 */
export function printedTotal(pages) {
  const text = pages.map((p) => p.text).join("\n");
  const hit =
    text.match(/TOTAL\s+FOR\s+PAPER\s*(?:IS|=|:)?\s*(\d{1,3})\s*MARKS?/i) ??
    text.match(/total\s+mark\s+for\s+this\s+paper\s+is\s+(\d{2,3})/i) ??
    text.match(/maximum\s+mark\s*:?\s*(\d{2,3})/i);
  return hit ? Number(hit[1]) : null;
}

/**
 * Does this paper offer more questions than a candidate answers? ("Answer
 * TWO questions from Section A"; "Answer ONE question from each section";
 * "answer one question from Questions 4, 5 and 6".) A paper shaped like that
 * legitimately prints more marks' worth of questions than its own total: the
 * printed total is what answering the REQUIRED subset is worth, not the sum
 * of everything on the page. Seen on English Literature, English Language A
 * and Geography's essay/case-study papers; a plain "Answer ALL questions"
 * paper (Business, Economics, the sciences) does not match this.
 */
const OFFERS_CHOICE = /\banswer\s+(?:one|two|three|four|five|\d+)\s+questions?\b/i;
export function offersChoice(pages) {
  return OFFERS_CHOICE.test(pages.map((p) => p.text).join("\n"));
}

/**
 * "(Total for Question 7 is 4 marks)" for every question that prints one.
 * Edexcel does; it is the strongest per-question check available.
 */
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
 * Do the parsed questions add up to the paper?
 *
 * Three independent checks, any of which catches a parser that has quietly
 * lost questions:
 *   - the top-level question numbers should run 1..N with nothing missing;
 *   - the marks should sum to the paper's printed total, unless the paper
 *     offers a choice of questions (see offersChoice, above);
 *   - each question's own parts should sum to that question's own printed
 *     total.
 *
 * Measured on four real Edexcel Maths A papers before the superscript fix,
 * three of them lost between 2 and 6 questions and summed to 85, 82 and 97
 * marks against a printed 100, and every one of them passed `looksParsed`.
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
  // A choice paper prints more questions than it expects answered, so the
  // sum of every parsed part is supposed to exceed the printed total: that
  // is not the parser having invented marks, so it is not scored against it.
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

/**
 * Did the deterministic pass actually work? A real paper has several parts,
 * most of them carrying marks. Anything less means the layout defeated the
 * regexes and the LLM pass should take over.
 *
 * `pages`, when given, also runs the consistency checks: a parse that is
 * missing questions, or that does not add up to the printed total, is not a
 * parse that worked, however many parts it produced.
 */
export function looksParsed(parts, pages = null) {
  if (parts.length < 3) return false;
  // Heavy duplication means the parser lost its place; the text it did keep is
  // attributed to the wrong questions, so the model should re-read the paper.
  if ((parts.duplicatesDropped ?? 0) > parts.length * 0.2) return false;
  const withMarks = parts.filter((p) => p.marks > 0).length;
  if (withMarks / parts.length < 0.5) return false;
  if (pages && !consistency(parts, pages).ok) return false;
  return true;
}
