/**
 * Working out what a PDF is from its filename.
 *
 * Two families of names are understood.
 *
 * Markwise convention, used for everything the repo names itself:
 *
 *   E-4PH1_s24_qp_1P.pdf   Edexcel Physics, May/June 2024, question paper, paper 1P
 *   E-4MA1_j24_ms_2H.pdf   Edexcel Maths A, January 2024, mark scheme, paper 2H
 *   E-4PH1_y17_sy.pdf      Edexcel Physics specification
 *   0625_s19_qp_42.pdf     Cambridge Physics, May/June 2019, paper 4 variant 2
 *
 * Pearson's own download names, which need no renaming:
 *
 *   4PH1_1P_que_20240514.pdf   question paper (que)
 *   4PH1_1P_rms_20240815.pdf   mark scheme (rms / msc)
 *   4PH1_1P_pef_20240815.pdf   examiner report (pef)
 *
 * The series is read from the date in a Pearson name: an exam in January is the
 * January series, May or June is the summer series, October or November is the
 * autumn one.
 *
 * Session letters: j = January, s = May/June, w = Oct/Nov, m = Feb/March (a
 * Cambridge series that Edexcel does not sit).
 *
 * WHAT A PAPER IS. An Edexcel paper is identified by its paper reference: "1H"
 * and "1F" are different papers set on the same day for different tiers, and
 * "1P" and "1PR" are a paper and its reserve. Collapsing them to "paper 1", as
 * this parser used to, made them collide and overwrite one another. So the
 * reference is kept whole, and `tier` is read from it.
 */

const SESSION = { j: "Jan", m: "Mar", s: "Jun", w: "Nov" };
const KINDS = new Set(["qp", "ms", "sy", "er", "gt", "in", "ci"]);

/** Pearson's own kind tokens. */
const PEARSON_KIND = { que: "qp", rms: "ms", msc: "ms", pef: "er", er: "er", sy: "sy" };

/** Which series an exam date belongs to. */
export function seriesFromMonth(month) {
  if (month <= 3) return "Jan";
  if (month <= 7) return "Jun";
  return "Nov";
}

/**
 * Which series a mark scheme or examiner report belongs to, from the date on
 * its filename.
 *
 * Those two carry the date they were PUBLISHED, not the date of the exam: the
 * scheme for a May paper is dated August. Reading it as an exam date filed
 * every scheme under the wrong series, so it never paired with its paper.
 * January and February publications belong to the previous November.
 */
export function seriesFromPublication(month, year) {
  if (month <= 2) return { session: "Nov", year: year - 1 };
  if (month <= 5) return { session: "Jan", year };
  if (month <= 10) return { session: "Jun", year };
  return { session: "Nov", year };
}

/**
 * @returns {{subjectCode,kind,year,session,paperNo,variant,paperRef,tier,code}|null}
 */
export function parseFilename(name) {
  const base = name.replace(/\.pdf$/i, "").trim().toLowerCase();

  const native = parsePearson(base);
  if (native) return native;

  // 0625_s19_qp_42  |  E-4PH1_s24_qp_1P  |  0625_y20_sy  |  E-4MA1_j24_ms_2H
  //
  // The subject token is a Cambridge 4-digit code, or a board-prefixed code
  // for anything else: E-4MA1 (Edexcel), X-PSY (a school course).
  const m = base.match(
    /^(\d{4}|[a-z]{1,3}-[a-z0-9]{2,12})[_-]([jmswy])(\d{2})[_-]([a-z]{2})(?:[_-]([0-9][0-9a-z]{0,2}))?$/,
  );
  if (!m) return looseParse(base);

  const [, rawCode, letter, yy, kind, ref] = m;
  if (!KINDS.has(kind)) return null;

  const subjectCode = normaliseCode(rawCode);
  const identity = paperIdentity(subjectCode, ref);
  return {
    subjectCode,
    kind: normaliseKind(kind),
    year: 2000 + Number(yy),
    session: SESSION[letter] ?? null, // 'y' (syllabus) has no session
    ...identity,
    code: `${subjectCode}_${letter}${yy}_${kind}${identity.paperRef ? `_${identity.paperRef}` : ""}`,
  };
}

/**
 * Pearson's own names: 4PH1_1P_que_20240514.
 *
 * The date is the day of the exam, so it gives both the year and the series.
 */
function parsePearson(base) {
  const m = base.match(/^(4[a-z]{2}\d)[_-]((?:\d{1,2}[a-z]{0,2}))[_-]([a-z]{2,3})[_-](\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, code, ref, rawKind, y, mo] = m;
  const kind = PEARSON_KIND[rawKind];
  if (!kind) return null;

  const subjectCode = `E-${code.toUpperCase()}`;
  const identity = paperIdentity(subjectCode, ref);
  const dated =
    kind === "qp"
      ? { session: seriesFromMonth(Number(mo)), year: Number(y) }
      : seriesFromPublication(Number(mo), Number(y));
  const letter = { Jan: "j", Jun: "s", Nov: "w" }[dated.session];
  return {
    subjectCode,
    kind,
    year: dated.year,
    session: dated.session,
    ...identity,
    code: `${subjectCode}_${letter}${String(dated.year).slice(2)}_${kind}${identity.paperRef ? `_${identity.paperRef}` : ""}`,
  };
}

/**
 * The parts of a paper reference.
 *
 *   Edexcel   "1H" → paper 1, tier H     "1PR" → paper 1, reserve     "01" → paper 1
 *   Cambridge "42" → paper 4, variant 2
 *
 * Older files in this repo were named "E-4MA1_s24_qp_13", where the "3" stood
 * for Higher tier. That is kept readable rather than orphaned: 3 becomes H and
 * 1 becomes F, and anything else is left as it was written.
 */
export function paperIdentity(subjectCode, ref) {
  if (!ref) return { paperNo: null, variant: null, paperRef: "", tier: null };

  const upper = String(ref).toUpperCase();
  const edexcel = /^[A-Z]-/.test(subjectCode);

  if (!edexcel) {
    // Cambridge: two digits, paper then variant.
    const paperNo = Number(upper[0]);
    return {
      paperNo: Number.isFinite(paperNo) ? paperNo : null,
      variant: upper[1] && /\d/.test(upper[1]) ? Number(upper[1]) : null,
      paperRef: upper,
      tier: null,
    };
  }

  let paperRef = upper;
  const legacy = upper.match(/^([12])([13])$/);
  if (legacy) paperRef = `${legacy[1]}${legacy[2] === "3" ? "H" : "F"}`;

  const paperNo = Number(paperRef.match(/^0*(\d)/)?.[1]);
  const tierLetter = paperRef.match(/^\d+([FH])/)?.[1] ?? null;
  return {
    paperNo: Number.isFinite(paperNo) && paperNo > 0 ? paperNo : null,
    variant: null,
    paperRef,
    tier: tierLetter,
  };
}

/**
 * Tolerate the hand-renamed files people actually have on disk.
 *
 * Word boundaries are useless here. Underscores are word characters, so
 * `\b(\d{4})\b` never matches the code in `0625_june_2019_ms.pdf` and happily
 * matches the *year* in `physics 2019 june.pdf`. Digit-run boundaries are used
 * instead, and any 4-digit run that looks like a year is rejected as a code.
 */
function looseParse(base) {
  const prefixed = base.match(/(?:^|[^a-z0-9])([a-z]{1,3}-[a-z0-9]{2,12})(?=[^a-z0-9]|$)/)?.[1];
  const edexcelCode = base.match(/(?:^|[^a-z0-9])(4[a-z]{2}\d)(?=[^a-z0-9]|$)/)?.[1];
  const runs = [...base.matchAll(/(?:^|[^0-9])(\d{4})(?=[^0-9]|$)/g)].map((m) => m[1]);
  const subject = prefixed ?? (edexcelCode ? `e-${edexcelCode}` : runs.find((n) => !/^(19|20)\d{2}$/.test(n)));
  if (!subject) return null;

  const explicitYear = runs.find((n) => /^20\d{2}$/.test(n));
  const shortYear = base.match(/(?:^|[^a-z0-9])[jmsw](\d{2})(?:[^0-9]|$)/)?.[1];
  const year = Number(explicitYear ?? (shortYear ? `20${shortYear}` : 0)) || null;

  // Same trap as above: `\b` does not fire around underscores, so "_ms_" would
  // never be recognised and every mark scheme would be filed as a question
  // paper. Separator classes are used throughout instead.
  const has = (alt) => new RegExp(`(?:^|[^a-z0-9])(?:${alt})(?:[^a-z0-9]|$)`).test(base);

  let session = null;
  if (has("jan|january")) session = "Jan";
  else if (has("june|summer|may")) session = "Jun";
  else if (has("nov|november|winter|oct|october")) session = "Nov";
  else if (has("mar|march|feb|february")) session = "Mar";
  else if (/[^a-z0-9]s\d{2}(?:[^0-9]|$)/.test(base)) session = "Jun";
  else if (/[^a-z0-9]w\d{2}(?:[^0-9]|$)/.test(base)) session = "Nov";
  else if (/[^a-z0-9]j\d{2}(?:[^0-9]|$)/.test(base)) session = "Jan";
  else if (/[^a-z0-9]m\d{2}(?:[^0-9]|$)/.test(base)) session = "Mar";

  let kind = "qp";
  if (has("ms|rms|msc|mark[ _-]?scheme|markscheme")) kind = "ms";
  else if (has("sy|syllabus|specification|spec")) kind = "sy";
  else if (has("er|pef|examiner[ _-]?report")) kind = "er";
  else if (has("gt|grade[ _-]?thresholds?|grade[ _-]?boundaries") || /boundar/.test(base)) kind = "gt";

  const subjectCode = normaliseCode(subject);
  // "paper 1h", "p1", "1h", "paper 42"
  const pv =
    base.match(/(?:^|[^a-z0-9])p(?:aper)?[ _-]?(\d[0-9a-z]{0,2})(?:[^0-9a-z]|$)/)?.[1] ??
    base.match(/(?:^|[^a-z0-9])(\d[fhpbcr]{1,2})(?:[^0-9a-z]|$)/)?.[1] ??
    null;
  const identity = paperIdentity(subjectCode, pv);

  return {
    subjectCode,
    kind,
    year,
    session,
    ...identity,
    code: base,
  };
}

/** Cambridge codes are digits; every other board's carry letters and are upper-cased. */
function normaliseCode(code) {
  return /[a-z]/i.test(code) ? code.toUpperCase() : code;
}

function normaliseKind(k) {
  if (k === "in" || k === "ci") return "qp"; // insert / confidential instructions
  return k;
}

/** Human title for a paper row. */
export function titleFor(meta, subjectName) {
  const bits = [subjectName || meta.subjectCode];
  if (meta.session && meta.year) bits.push(`${meta.session} ${meta.year}`);
  else if (meta.year) bits.push(String(meta.year));
  if (meta.paperRef) bits.push(`Paper ${meta.paperRef}`);
  else if (meta.paperNo) bits.push(`Paper ${meta.paperNo}${meta.variant ?? ""}`);
  bits.push(
    { qp: "Question Paper", ms: "Mark Scheme", sy: "Syllabus", er: "Examiner Report", gt: "Grade Thresholds" }[
      meta.kind
    ] ?? meta.kind,
  );
  return bits.join(" · ");
}

/** The qp filename that a ms filename should pair with, and vice versa. */
export function siblingCode(meta, kind) {
  const ref = meta.paperRef ?? (meta.paperNo ? `${meta.paperNo}${meta.variant ?? ""}` : "");
  return `${meta.subjectCode}_${sessionLetter(meta.session)}${String(meta.year).slice(2)}_${kind}${
    ref ? `_${ref}` : ""
  }`;
}

function sessionLetter(session) {
  return { Jan: "j", Mar: "m", Jun: "s", Nov: "w" }[session] ?? "y";
}
