/**
 * The give-up rule for `ingest.js reembed`'s retry loop.
 *
 * The loop re-fetches the same page of still-unembedded rows until none are
 * left. Gemini's embedding quota is sometimes exhausted for the day, not
 * just the minute, and in that case every row in that page fails the same
 * way forever: without a give-up rule the loop re-fetches the identical page
 * and reheats the same rate limit indefinitely (observed: a 3+ hour hang
 * before this existed). Two passes in a row that embed nothing are treated
 * as that kind of exhaustion, not a blip, and stop the run.
 */
export const STALL_LIMIT = 2;

/** The next stall count, given how many rows the pass just embedded. */
export function nextStalls(stalls, embeddedThisPass) {
  return embeddedThisPass > 0 ? 0 : stalls + 1;
}
