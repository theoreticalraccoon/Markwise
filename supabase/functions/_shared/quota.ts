/**
 * Per-user daily budget for AI routes.
 *
 * A call is reserved BEFORE the model runs, so a user who is out of allowance
 * costs the project nothing, and the counter lives in Postgres because edge
 * functions are stateless and scale to many isolates.
 *
 * Reserving up front means a call that then fails inside Gemini has already
 * been charged. `release` gives it back, so a 502 does not eat a student's
 * allowance for an answer they never received.
 *
 * Two properties this module is careful about, both of which the first version
 * got wrong:
 *
 *  - A claim returns the id of the row it wrote, and a release deletes exactly
 *    that row. Releasing "the newest row for this route" could delete a charge
 *    that belonged to a different, successful request, or refund a call that
 *    was never charged because the claim itself had failed open.
 *  - The id is kept on the request's own Caller object, so concurrent requests
 *    in one isolate can never release each other's claims.
 */

import { adminClient, type Caller } from "./db.ts";

export class QuotaExceeded extends Error {
  constructor(route: string) {
    super(`Daily limit for "${route}" reached. It resets at midnight UTC.`);
    this.name = "QuotaExceeded";
  }
}

/** Reserve one call. Throws QuotaExceeded when the cap is spent. */
export async function claim(user: Caller, route: string): Promise<void> {
  const { data, error } = await adminClient().rpc("claim_ai_call_id", {
    p_user: user.id,
    p_route: route,
  });
  if (error) {
    // Accounting must never take the feature down: log and let the call run.
    // There is no row to refund, so nothing is recorded for `release`.
    console.error("claim_ai_call_id failed:", error.message);
    user.claims[route] = null;
    return;
  }
  if (data === null) throw new QuotaExceeded(route);   // the cap is spent
  user.claims[route] = data as string;
}

/**
 * Hand back this request's reservation after its work failed.
 *
 * Never throws: a failed refund is an accounting inconvenience, and it must
 * not replace the real error the caller is already returning.
 */
export async function release(user: Caller, route: string): Promise<void> {
  const id = user.claims[route];
  if (!id) return;
  delete user.claims[route];
  try {
    const { error } = await adminClient().rpc("release_ai_call_id", { p_id: id });
    if (error) console.error("release_ai_call_id failed:", error.message);
  } catch (e) {
    console.error("release_ai_call_id threw:", e);
  }
}
