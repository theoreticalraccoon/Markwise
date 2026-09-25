/**
 * What a message to the assistant is asking for: marking (a question reference
 * plus an attempt), technique ("how do I get full marks"), or a plain question.
 * Pure functions so they can be tested without a browser.
 */

// Q4(b), "question 7", "paper 1H", 4PH1, "June 2024", or a _qp_ filename.
const REFERENCE =
  /(?:\bq(?:uestion)?\s*\.?\s*\d|_(?:qp|ms)_|\bpaper\s*\d[fhpbcr]{0,2}\b|(?:^|[^a-z0-9])4[a-z]{2}\d(?=[^a-z0-9]|$)|\b(?:jan(?:uary)?|june?|may|nov(?:ember)?|oct(?:ober)?)\s*\/?\s*(?:20\d\d|'\d{2})\b)/i;

export function hasReference(text) {
  return REFERENCE.test(String(text ?? ""));
}

/** A reference plus enough prose to be an answer. The bar is high on purpose: guessing wrong just gives a normal reply. */
export function looksLikeMarking(text) {
  const t = String(text ?? "").trim();
  if (/^\s*mark\b/i.test(t)) return true;

  const longEnough = t.replace(/\s+/g, " ").length > 120 || t.split("\n").length >= 3;
  return hasReference(t) && longEnough;
}

/**
 * Split "...Q4(b): my answer" into reference and answer. Only a colon or a
 * spaced dash counts, so "air-resistance" isn't cut in half.
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

  // The part before the separator has to name a question, not just a date.
  const m = t.match(/^(.{5,120}?)\s*(?::|\s[-–]\s)\s*([\s\S]+)$/);
  if (m && /\bq(?:uestion)?\s*\.?\s*\d/i.test(m[1])) return { question: m[1], answer: m[2] };

  return { question: t.slice(0, 120), answer: t };
}

/** "How do I earn the marks?" gets the technique prompt instead. */
export function looksLikeTechnique(text) {
  return /\b(?:how (?:do|should|can) i (?:answer|approach|structure|write|get|score|tackle)|full marks?|all the marks|what (?:does|do) (?:the )?(?:examiner|command word|question)s? (?:want|expect|ask for)|marking points?|how (?:is|are) .{0,40} marked|answer technique|structure (?:my|an) answer|lose marks?)\b/i
    .test(String(text ?? ""));
}
