/**
 * Deciding what a message to the assistant is asking for.
 *
 * Pure functions with no imports, so they can be tested without a browser or a
 * database. They used to live inside the assistant view, where nothing could
 * reach them, and one of them shipped with a broken regex (a literal backspace
 * where `\b` belonged) that made technique mode dead code.
 *
 * Three outcomes:
 *   - marking: the message names a question and carries an attempt at it;
 *   - technique: the student wants to know how to earn the marks;
 *   - anything else is an ordinary grounded question.
 */

/**
 * Does the text point at a particular question or paper?
 *
 * Covers the ways an Edexcel student writes it: "Q4(b)", "question 7",
 * "paper 1H", the code "4PH1", a series and year ("June 2024", "Jan 2025"), and
 * the filename form "_qp_".
 */
const REFERENCE =
  /(?:\bq(?:uestion)?\s*\.?\s*\d|_(?:qp|ms)_|\bpaper\s*\d[fhpbcr]{0,2}\b|(?:^|[^a-z0-9])4[a-z]{2}\d(?=[^a-z0-9]|$)|\b(?:jan(?:uary)?|june?|may|nov(?:ember)?|oct(?:ober)?)\s*\/?\s*(?:20\d\d|'\d{2})\b)/i;

export function hasReference(text) {
  return REFERENCE.test(String(text ?? ""));
}

/**
 * Does this message want marking?
 *
 * The signal is a reference plus enough prose to be an attempt at an answer.
 * Asking "what does 4PH1 Jun 2024 Q4(b) want?" is a question; pasting four
 * lines of working under the same reference is an answer. Guessing wrong in the
 * cautious direction just means a normal grounded reply, which is why the bar
 * is deliberately set high.
 */
export function looksLikeMarking(text) {
  const t = String(text ?? "").trim();
  if (/^\s*mark\b/i.test(t)) return true;

  const longEnough = t.replace(/\s+/g, " ").length > 120 || t.split("\n").length >= 3;
  return hasReference(t) && longEnough;
}

/**
 * Split "…Q4(b): my answer" into the reference and the answer.
 *
 * A separator only counts when it is a colon, or a dash with spaces round it,
 * and only when what comes before it really is a reference. The old rule split
 * on any hyphen, so "Q4(b) the pre-1970 rule" and "air-resistance" were cut
 * mid-word and the answer marked was the wrong half of the message.
 */
export function splitMarkRequest(text) {
  const t = String(text ?? "")
    .trim()
    .replace(/^\s*mark\s*(?:my\s*answer)?\s*(?:to|for|of)?\s*[:,-]?\s*/i, "");
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);

  // A short first line naming a question is the reference; the rest is the answer.
  if (lines.length > 1 && lines[0].length <= 120 && hasReference(lines[0])) {
    return { question: lines[0].replace(/\s*[:\-–]\s*$/, ""), answer: lines.slice(1).join("\n") };
  }

  // The part before the separator has to name a QUESTION, not just a date or a
  // paper: "Jan 2024 - Paper 1P Q3 the answer is 4" must not be cut after the date.
  const m = t.match(/^(.{5,120}?)\s*(?::|\s[-–]\s)\s*([\s\S]+)$/);
  if (m && /\bq(?:uestion)?\s*\.?\s*\d/i.test(m[1])) return { question: m[1], answer: m[2] };

  return { question: t.slice(0, 120), answer: t };
}

/**
 * Is this a "how do I earn the marks" question?
 *
 * The technique prompt is a different job from ordinary explanation: it
 * enumerates the marking points in examiner order and names what most
 * candidates get wrong.
 */
export function looksLikeTechnique(text) {
  return /\b(?:how (?:do|should|can) i (?:answer|approach|structure|write|get|score|tackle)|full marks?|all the marks|what (?:does|do) (?:the )?(?:examiner|command word|question)s? (?:want|expect|ask for)|marking points?|how (?:is|are) .{0,40} marked|answer technique|structure (?:my|an) answer|lose marks?)\b/i
    .test(String(text ?? ""));
}
