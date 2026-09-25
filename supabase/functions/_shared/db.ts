// Two clients: userClient() forwards the caller's JWT, so RLS still applies
// to every user row. adminClient() uses the service-role key, for the shared
// corpus, quota accounting and grade lookups only.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export function userClient(req: Request): SupabaseClient {
  const auth = req.headers.get("Authorization") ?? "";
  return createClient(URL, ANON, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function adminClient(): SupabaseClient {
  return createClient(URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface Caller {
  id: string;
  email: string | null;
  db: SupabaseClient;
  /** Allowance reservations made by THIS request, by route. See quota.ts. */
  claims: Record<string, string | null>;
}

/** Resolve the signed-in user, or throw. Every AI route requires one. */
export async function requireUser(req: Request): Promise<Caller> {
  const db = userClient(req);
  const { data, error } = await db.auth.getUser();
  if (error || !data?.user) throw new Error("Not signed in.");
  return { id: data.user.id, email: data.user.email ?? null, db, claims: {} };
}
