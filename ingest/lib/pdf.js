/**
 * PDF text extraction.
 *
 * Naively concatenating pdf.js text items destroys exam papers: mark
 * allocations sit in a right-hand column, mark schemes are tables, and answer
 * lines interleave with question text. So items are bucketed into visual lines
 * by their y-coordinate and sorted by x within a line, which reconstructs the
 * reading order well enough for the question parser to work on.
 *
 * Pages whose text layer is thin (scanned papers) are reported as such so the
 * caller can decide whether to spend an OCR call on them.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

let pdfjs;
async function lib() {
  if (!pdfjs) {
    // The legacy build is the one that runs under Node without a DOM.
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // require.resolve returns a native path. On Windows that is "C:\…", which
    // the ESM loader rejects as an unknown URL scheme ("c:"), so it must be
    // converted to a file:// URL before pdf.js tries to import the worker.
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
      require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
    ).href;
  }
  return pdfjs;
}

/** Items on roughly the same baseline belong to the same line. */
const Y_TOLERANCE = 2.5;

/**
 * @returns {Promise<{pages: {n:number, text:string, thin:boolean}[], pageCount:number}>}
 */
export async function extractPages(path, { markers = false } = {}) {
  const { getDocument } = await lib();
  const data = new Uint8Array(await readFile(path));
  const doc = await getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;

  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const height = page.view?.[3] ?? 842;
    const text = itemsToText(content.items, height, markers);
    pages.push({
      n,
      text,
      // A real exam page carries several hundred characters. Much less than
      // that means the text layer is missing or is image-only.
      thin: text.replace(/\s/g, "").length < 180,
    });
    page.cleanup();
  }
  const pageCount = doc.numPages;
  await doc.destroy();
  return { pages, pageCount };
}

/**
 * A visible gap between two text items is a space, even when neither item
 * contains one.
 *
 * This matters more than it sounds. Exam papers set the question number as its
 * own text item in the left margin, so concatenating naively yields
 * "1Here are the first four terms". And worse, "2450 students were asked",
 * which is question 2 asking about 450 students. Both are unparseable, and the
 * second is indistinguishable from a line that really does start with 2450.
 * Measuring the gap recovers the space and makes the question number visible
 * to the parser again.
 */
const GAP_IS_SPACE = 1.2;

/**
 * Superscripts, subscripts and fraction parts are set in a smaller font and
 * offset from the baseline (about 5.7 units for a 12pt line). That is well
 * outside Y_TOLERANCE, so they used to become lines of their own, printed
 * ABOVE the line they belong to: "x^5 x x^7 = x^m" turned into "5 7 m" followed
 * by "4 x x x = x". The question number on the real line was then buried under
 * junk and the whole question vanished. Measured on Edexcel Maths A, that lost
 * 15 questions across four papers.
 *
 * A small item that ends where a larger item on a nearby line ends is attached
 * to that line instead.
 */
const SMALL_RATIO = 0.75;
const SCRIPT_REACH = 8.5;
const SCRIPT_MAX_CHARS = 4;

/** A digit-only item this close to the top or bottom edge is a page number. */
const FOOTER_ZONE = 75;
const HEADER_ZONE = 30;

/** Marks a question number that stands alone in the left margin. */
export const QUESTION_MARK = "⟦Q";
export const QUESTION_MARK_END = "⟧";

// Exported (only) so tests can drive it directly with synthetic pdf.js text
// items, without a real PDF on disk. extractPages() is the real entry point.
export function itemsToText(items, pageHeight = 842, markers = false) {
  const real = items.filter((it) => {
    if (!it.str || !it.str.trim()) return false;
    // Page numbers are dropped by POSITION. The parser used to drop any line
    // that was only digits, which also deleted question numbers that sit on
    // their own line above a diagram (Q3, Q9, Q20 and Q23 of a real Edexcel
    // Maths A paper), taking the whole question with them.
    if (/^\d{1,3}$/.test(it.str.trim())) {
      const y = it.transform[5];
      if (y < FOOTER_ZONE || y > pageHeight - HEADER_ZONE) return false;
    }
    return true;
  });
  const heights = real.map((it) => it.height || 0).filter((h) => h > 0).sort((a, b) => a - b);
  const median = heights.length ? heights[Math.floor(heights.length / 2)] : 0;

  const isScript = (it) =>
    median > 0 &&
    (it.height || 0) > 0 &&
    it.height <= median * SMALL_RATIO &&
    it.str.trim().length <= SCRIPT_MAX_CHARS &&
    /[\p{L}\p{N}()+\-−=]/u.test(it.str);

  const lines = [];
  const scripts = [];
  for (const it of real) {
    if (isScript(it)) {
      scripts.push(it);
      continue;
    }
    const x = it.transform[4];
    const y = it.transform[5];
    let line = lines.find((l) => Math.abs(l.y - y) <= Y_TOLERANCE);
    if (!line) {
      line = { y, parts: [] };
      lines.push(line);
    }
    line.parts.push({ x, str: it.str, width: it.width ?? 0 });
  }

  // Left to right, so a two-part exponent ("1" then "0") finds the part before it.
  scripts.sort((a, b) => a.transform[4] - b.transform[4]);
  for (const it of scripts) {
    const x = it.transform[4];
    const y = it.transform[5];
    let best = null;
    let bestGap = Infinity;
    for (const l of lines) {
      if (Math.abs(l.y - y) > SCRIPT_REACH) continue;
      // How close does something on this line end to where the script starts?
      const gap = Math.min(...l.parts.map((p) => Math.abs(p.x + p.width - x)));
      if (gap < bestGap) {
        bestGap = gap;
        best = l;
      }
    }
    if (best && bestGap <= 3) {
      best.parts.push({ x, str: it.str, width: it.width ?? 0 });
      continue;
    }
    // Nothing adjacent: a lone small-print item is its own line.
    let own = lines.find((l) => Math.abs(l.y - y) <= Y_TOLERANCE);
    if (!own) {
      own = { y, parts: [] };
      lines.push(own);
    }
    own.parts.push({ x, str: it.str, width: it.width ?? 0 });
  }

  lines.sort((a, b) => b.y - a.y); // PDF origin is bottom-left

  // Where body text starts on this page. A question number is set to the left
  // of it, so a line that is nothing but a small integer out there is a
  // question number, not a diagram label.
  //
  // The blank dotted answer-lines Edexcel prints below a question start at
  // the SAME left margin as the question number itself, and a page can carry
  // a dozen of them. Left in, they swamp the sample and pull the "body
  // starts here" estimate down onto the number's own column, so a number at
  // the true margin no longer reads as left of it (measured: question 6 of a
  // Further Pure Maths paper, on a page that was mostly blank answer space
  // under a diagram, lost this way). They carry no indentation information,
  // so they are excluded rather than counted as body text.
  const starts = lines
    .map((l) => l.parts.sort((a, b) => a.x - b.x))
    .filter((parts) => {
      const text = parts.map((p) => p.str).join("").trim();
      if (text.length <= 12) return false;
      return text.replace(/[.\s]/g, "").length > 4; // not just a dot leader
    })
    .map((parts) => parts[0].x)
    .sort((a, b) => a - b);
  const bodyX = starts.length ? starts[Math.floor(starts.length / 2)] : null;

  return lines
    .map((l) => {
      let parts = l.parts.sort((a, b) => a.x - b.x);
      // Question papers only. A small integer in the left margin, before the
      // body text starts, is a question number. Telling it apart from the same
      // digits inside a sentence ("17 chose knitting and photography" is data
      // in question 16, not question 17) is impossible from the text alone, and
      // getting it wrong skips every question after it.
      let lead = "";
      if (markers && bodyX !== null && /^(?:[AB])?\d{1,2}$/i.test(parts[0].str.trim()) && parts[0].x < bodyX - 6) {
        lead = `${QUESTION_MARK}${parts[0].str.trim()}${QUESTION_MARK_END}`;
        parts = parts.slice(1);
        if (!parts.length) return lead;
      }
      let out = "";
      let cursor = null;
      for (const p of parts) {
        if (cursor !== null && p.x - cursor > GAP_IS_SPACE && !/\s$/.test(out) && !/^\s/.test(p.str)) {
          out += " ";
        }
        out += p.str;
        cursor = p.x + p.width;
      }
      const body = out.replace(/\s+/g, " ").trim();
      return lead ? `${lead} ${body}` : body;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Render one page to PNG for OCR. Requires the optional `canvas` package; when
 * it is absent the caller falls back to whatever text layer exists rather than
 * making the whole pipeline depend on a native module.
 */
export async function renderPagePng(path, pageNo, scale = 2) {
  let createCanvas;
  try {
    ({ createCanvas } = require("canvas"));
  } catch {
    return null; // OCR unavailable. Not fatal
  }
  const { getDocument } = await lib();
  const data = new Uint8Array(await readFile(path));
  const doc = await getDocument({ data, isEvalSupported: false }).promise;
  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
  const buf = canvas.toBuffer("image/png");
  await doc.destroy();
  return buf;
}

/** Cheap structural fingerprint so re-ingesting an unchanged file is a no-op. */
export async function sha256(path) {
  const { createHash } = await import("node:crypto");
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}
