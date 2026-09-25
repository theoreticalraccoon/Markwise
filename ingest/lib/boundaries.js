/**
 * Parse Pearson's "Notional component grade boundaries" PDF. Each row is
 *
 *   4AC1 Accounting Raw 100 85 79 73 65 58 51 40 29 18 0
 *   Paper 01
 *
 * i.e. max mark, then grades 9..1 and U. Foundation rows stop at grade 5.
 */
const ROW = /^(\d[A-Z]{1,3}\d)\s+(.+?)\s+Raw\s+((?:\d+(?:\.\d+)?\s*){2,11})$/;
const PAPER = /^Paper\s+(\S+)$/i;

/** @returns {{code, name, paperRef, maxMark, boundaries: Record<grade, minMark>}[]} U is dropped. */
export function parsePearsonBoundaries(pages) {
  const lines = pages.flatMap((p) => p.text.split("\n").map((l) => l.trim())).filter(Boolean);
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ROW);
    if (!m) continue;
    const p = lines[i + 1]?.match(PAPER);
    if (!p) continue; // unexpected shape, skip rather than guess

    const nums = m[3].trim().split(/\s+/).map(Number);
    const maxMark = nums[0];
    const marks = nums.slice(1); // grade boundaries, highest first, ending in U
    if (marks.length < 2) continue;
    const topGrade = marks.length - 1;

    const boundaries = {};
    marks.slice(0, -1).forEach((v, gi) => {
      boundaries[String(topGrade - gi)] = v;
    });

    out.push({ code: m[1].toUpperCase(), name: m[2].trim(), paperRef: p[1].toUpperCase(), maxMark, boundaries });
    i++; // the paper line was consumed too
  }
  return out;
}

/** "1F"/"1FR" -> "F", "2H"/"2HR" -> "H", else null. Same letters papers.tier and predict_grade use. */
export function tierOfBoundaryRef(ref) {
  return String(ref ?? "").match(/^\d+([FH])/i)?.[1].toUpperCase() ?? null;
}

/** Series from the filename: "...-june-2024-..." or "2306-..." (YYMM). */
export function seriesFromBoundaryFilename(name) {
  const wordy = name.match(/(january|jan|june|jun|november|nov)-(\d{4})/i);
  if (wordy) {
    const session = { jan: "Jan", january: "Jan", jun: "Jun", june: "Jun", nov: "Nov", november: "Nov" }[wordy[1].toLowerCase()];
    return { year: Number(wordy[2]), session };
  }
  const coded = name.match(/(?:^|[^\d])(\d{2})(01|06|11)[-_]/);
  if (coded) {
    const session = { "01": "Jan", "06": "Jun", "11": "Nov" }[coded[2]];
    return { year: 2000 + Number(coded[1]), session };
  }
  return null;
}
