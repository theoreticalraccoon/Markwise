/**
 * Per-user daily AI budget. A call is claimed before the model runs and
 * released if it fails. The claim returns its row id and release deletes that
 * exact row, kept on this request's Caller, so concurrent requests can't
 * refund each other.
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
    // Accounting must never take the feature down. Nothing to refund later.
    console.error("claim_ai_call_id failed:", error.message);
    user.claims[route] = null;
    return;
  }
  if (data === null) throw new QuotaExceeded(route);   // the cap is spent
  user.claims[route] = data as string;
}

/** Refund this request's claim after a failure. Never throws. */
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
