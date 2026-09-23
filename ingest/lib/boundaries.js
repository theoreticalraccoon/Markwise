/**
 * Pearson's "Notional component grade boundaries" documents.
 *
 * One PDF per series, covering every International GCSE subject, laid out as
 * a strict table repeated per subject:
 *
 *   Accounting
 *   Notional component grade boundaries Max Mark 9 8 7 6 5 4 3 2 1 U
 *   4AC1 Accounting Raw 100 85 79 73 65 58 51 40 29 18 0
 *   Paper 01
 *   4AC1 Accounting Raw 100 88 81 75 67 59 51 38 25 12 0
 *   Paper 01R
 *
 * A tiered subject's Foundation-tier row stops at grade 5 (its ceiling), so
 * it carries 6 numbers after "Raw" (5,4,3,2,1,U) instead of the usual 10
 * (9,8,7,6,5,4,3,2,1,U):
 *
 *   4MA1 Mathematics A (Foundation) Raw 100 72 60 43 27 11 0
 *   Paper 1F
 *
 * The row and its "Paper <ref>" always come as a pair, in that order, so the
 * grammar needs no lookahead: read a Raw row, then the paper line that follows it.
 */
const ROW = /^(\d[A-Z]{1,3}\d)\s+(.+?)\s+Raw\s+((?:\d+(?:\.\d+)?\s*){2,11})$/;
const PAPER = /^Paper\s+(\S+)$/i;

/**
 * @returns {{code:string, name:string, paperRef:string, maxMark:number, boundaries:Record<string,number>}[]}
 *   `boundaries` maps grade "9".."1" to its minimum raw mark. The trailing "U"
 *   figure (always 0, "ungraded") is dropped: predict_grade already falls
 *   back to 'U' for anything below the lowest stored grade.
 */
export function parsePearsonBoundaries(pages) {
  const lines = pages.flatMap((p) => p.text.split("\n").map((l) => l.trim())).filter(Boolean);
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ROW);
    if (!m) continue;
    const p = lines[i + 1]?.match(PAPER);
    if (!p) continue; // not the shape we expect; skip rather than guess

    const nums = m[3].trim().split(/\s+/).map(Number);
    const maxMark = nums[0];
    const marks = nums.slice(1); // descending grade boundaries, ending in U=0
    if (marks.length < 2) continue;
    const topGrade = marks.length - 1; // last entry is U, not a grade

    const boundaries = {};
    marks.slice(0, -1).forEach((v, gi) => {
      boundaries[String(topGrade - gi)] = v;
    });

    out.push({ code: m[1].toUpperCase(), name: m[2].trim(), paperRef: p[1].toUpperCase(), maxMark, boundaries });
    i++; // consumed the paper line too
  }
  return out;
}

/** "1F"/"1FR"/"2F" -> Foundation, "1H"/"1HR"/"2H" -> Higher, else null. */
export function tierOfBoundaryRef(ref) {
  if (/F/.test(ref)) return "Foundation";
  if (/H/.test(ref)) return "Higher";
  return null;
}

/**
 * A series is named in the source filename, two ways:
 *   "grade-boundaries-june-2024-notional-component-int-gcse.pdf"
 *   "2306-intgcse-9-1-notional-component-grade-boundaries.pdf"  (YY MM: 01 Jan, 06 Jun, 11 Nov)
 */
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
