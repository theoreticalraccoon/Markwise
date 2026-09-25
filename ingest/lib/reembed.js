// Give-up rule for reembed. When the daily quota is gone, every row in the
// page fails forever and the loop would spin for hours. Two empty passes in a
// row means stop.
export const STALL_LIMIT = 2;

/** The next stall count, given how many rows the pass just embedded. */
export function nextStalls(stalls, embeddedThisPass) {
  return embeddedThisPass > 0 ? 0 : stalls + 1;
}
