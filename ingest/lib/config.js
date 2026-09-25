// Ingestion config, read from ingest/.env. The service-role key lives here
// and nowhere else: it bypasses RLS.

import "dotenv/config";

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. Copy ingest/.env.example to ingest/.env and fill it in.`);
    process.exit(1);
  }
  return v;
}

export const SUPABASE_URL = need("SUPABASE_URL");
export const SERVICE_KEY = need("SUPABASE_SERVICE_ROLE_KEY");

/** Comma-separated keys are rotated to spread the free-tier rate limit. */
export const GEMINI_KEYS = need("GEMINI_API_KEYS")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Tried in order. Extraction is mechanical, so the lite model leads and the
// others absorb a bad quota day.
export const CHAT_MODELS = (process.env.GEMINI_CHAT_MODEL || "gemini-3.5-flash-lite,gemini-3-flash-preview,gemini-3.5-flash")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001";

// 768 rather than the native 3072: a quarter of the storage, negligible
// retrieval loss. Truncated vectors need normalising (see gemini.js).
export const EMBED_DIMS = 768;

/** Free tier is ~15 requests/minute/key. Concurrency is per-key, not global. */
export const CONCURRENCY = Number(process.env.INGEST_CONCURRENCY || GEMINI_KEYS.length * 2);
export const EMBED_BATCH = Number(process.env.EMBED_BATCH || 96);

/** Set INGEST_LLM_PARSE=0 to run regex-only (free, faster, less accurate). */
export const LLM_PARSE = process.env.INGEST_LLM_PARSE !== "0";
export const LLM_CLASSIFY = process.env.INGEST_LLM_CLASSIFY !== "0";
