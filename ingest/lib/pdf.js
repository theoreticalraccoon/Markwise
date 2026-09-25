// PDF text extraction. pdf.js items are bucketed into visual lines by y and
// sorted by x, which restores reading order well enough to parse. Pages with a
// thin text layer (scans) are flagged so the caller can OCR them.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

let pdfjs;
async function lib() {
  if (!pdfjs) {
    // The legacy build is the one that runs under Node without a DOM.
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // On Windows require.resolve gives "C:\...", which the ESM loader rejects, so
        // convert it to a file:// URL first.
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
      require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
    ).href;
  }
  return pdfjs;
}

/** Items on roughly the same baseline belong to the same line. */
const Y_TOLERANCE = 2.5;

/** @returns {Promise<{pages: {n, text, thin}[], pageCount}>} */
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
      // Real exam pages have hundreds of characters; fewer means no text layer.
      thin: text.replace(/\s/g, "").length < 180,
    });
    page.cleanup();
  }
  const pageCount = doc.numPages;
  await doc.destroy();
  return { pages, pageCount };
}

// A visible gap between items is a space. Without it the margin number fuses
// with the text: "2450 students" is really Q2 about 450 students.
const GAP_IS_SPACE = 1.2;

// Superscripts and fraction parts sit ~5.7 units off the baseline and used to
// become their own lines, burying the question number (15 Maths A questions
// lost). Small items are attached to the nearby line they end against.
const SMALL_RATIO = 0.75;
const SCRIPT_REACH = 8.5;
const SCRIPT_MAX_CHARS = 4;

/** A digit-only item this close to the top or bottom edge is a page number. */
const FOOTER_ZONE = 75;
const HEADER_ZONE = 30;

/** Marks a question number that stands alone in the left margin. */
export const QUESTION_MARK = "⟦Q";
export const QUESTION_MARK_END = "⟧";

// Exported so tests can feed it synthetic pdf.js items. extractPages is the real entry.
export function itemsToText(items, pageHeight = 842, markers = false) {
  const real = items.filter((it) => {
    if (!it.str || !it.str.trim()) return false;
    // Page numbers are dropped by position, not by being digits: a question number
    // alone above a diagram is also just digits.
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

  // Where body text starts. A lone small integer left of it is a question
  // number, not a diagram label. Dot-leader answer lines start at the number's
  // own margin and would drag this estimate onto it (that's how FPM Q6 went
  // missing), so they're left out.
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
      // Question papers only: a small integer in the margin is a question number.
      // "17 chose knitting" inside a sentence is data, and mistaking it skips
      // every question after it.
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

/** Render a page to PNG for OCR. Needs the optional `canvas` package; returns null without it. */
export async function renderPagePng(path, pageNo, scale = 2) {
  let createCanvas;
  try {
    ({ createCanvas } = require("canvas"));
  } catch {
    return null; // OCR unavailable, not fatal
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
