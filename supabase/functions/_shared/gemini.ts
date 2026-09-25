/**
 * Gemini client for the free tier. Keys in GEMINI_API_KEYS are rotated; a 429
 * means that model is out for the day, so move on instead of backing off; 5xx
 * gets jittered retries. Embeddings set the right task type (query vs document).
 */

const API = "https://generativelanguage.googleapis.com/v1beta";

// Tried in order. The better model leads here (unlike ingestion) because a
// student reads this text; a 429 just falls through to the next.
export const CHAT_MODELS = (Deno.env.get("GEMINI_CHAT_MODEL") ?? "gemini-3.5-flash,gemini-3-flash-preview,gemini-3.5-flash-lite")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const EMBED_MODEL = Deno.env.get("GEMINI_EMBED_MODEL") ?? "gemini-embedding-001";

// Must match the ingested vectors and the vector(768) column.
export const EMBED_DIMS = 768;

const KEYS = (Deno.env.get("GEMINI_API_KEYS") ?? Deno.env.get("GEMINI_API_KEY") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (KEYS.length === 0) {
  console.warn("GEMINI_API_KEY / GEMINI_API_KEYS is not set: AI routes will fail.");
}

let keyCursor = 0;
function nextKey(): string {
  if (KEYS.length === 0) throw new Error("No Gemini API key configured.");
  const k = KEYS[keyCursor % KEYS.length];
  keyCursor++;
  return k;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** This model has no quota left today. The caller should try the next one. */
class QuotaExhausted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExhausted";
  }
}

async function callGemini(
  path: string,
  body: unknown,
  { retries = 4, stream = false }: { retries?: number; stream?: boolean } = {},
): Promise<Response> {
  let lastErr = "";
  const exhausted = new Set<string>();
  for (let attempt = 0; attempt <= retries; attempt++) {
    let key: string | undefined;
    for (let i = 0; i < KEYS.length; i++) {
      const candidate = nextKey();
      if (!exhausted.has(candidate)) { key = candidate; break; }
    }
    if (!key) throw new QuotaExhausted(`${path.split("/")[1]?.split(":")[0] ?? "model"} is out of quota for every configured key.`);
    const url = `${API}/${path}${stream ? "?alt=sse&" : "?"}key=${key}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastErr = `network: ${e instanceof Error ? e.message : String(e)}`;
      await sleep(backoff(attempt));
      continue;
    }

    if (res.ok) return res;

    // Try the other keys once, no sleeping on a spent quota. 5xx gets a retry.
    if (res.status === 429) {
      exhausted.add(key);
      attempt--;
      continue;
    }
    if (res.status === 503 || res.status === 500) {
      lastErr = `${res.status} ${await res.text().catch(() => "")}`.slice(0, 300);
      await sleep(backoff(attempt));
      continue;
    }

    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${detail.slice(0, 400)}`);
  }
  throw new Error(`Gemini unavailable after ${retries + 1} attempts. Last: ${lastErr}`);
}

function backoff(attempt: number): number {
  return Math.min(16000, 700 * 2 ** attempt) + Math.random() * 400;
}

/* ------------------------------------------------------------------ embed -- */

export type EmbedTask = "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT" | "SEMANTIC_SIMILARITY";

/** Embed one string. Used for search queries. */
export async function embedOne(text: string, taskType: EmbedTask = "RETRIEVAL_QUERY"): Promise<number[]> {
  const [v] = await embedBatch([text], taskType);
  return v;
}

/** Embed up to 100 strings in one request (the API's batch ceiling). */
export async function embedBatch(
  texts: string[],
  taskType: EmbedTask = "RETRIEVAL_DOCUMENT",
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 100) {
    const slice = texts.slice(i, i + 100);
    const res = await callGemini(`models/${EMBED_MODEL}:batchEmbedContents`, {
      requests: slice.map((t) => ({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text: truncate(t, 8000) }] },
        taskType,
        outputDimensionality: EMBED_DIMS,
      })),
    });
    const data = await res.json();
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== slice.length) {
      throw new Error("Incomplete embedding response.");
    }
    for (const e of data.embeddings) {
      if (!Array.isArray(e.values) || e.values.length !== EMBED_DIMS ||
          !e.values.every((v: unknown) => typeof v === "number" && Number.isFinite(v)) ||
          !e.values.some((v: number) => v !== 0)) throw new Error("Invalid embedding vector.");
      out.push(normalise(e.values as number[]));
    }
  }
  return out;
}

// Same normalisation as ingestion, or queries and corpus live in different spaces.
export function normalise(values: number[]): number[] {
  let sum = 0;
  for (const v of values) sum += v * v;
  const norm = Math.sqrt(sum);
  if (!norm || Math.abs(norm - 1) < 1e-6) return values;
  return values.map((v) => v / norm);
}

/* --------------------------------------------------------------- generate -- */

export interface GenerateOptions {
  system?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Force a JSON response shaped by this schema (Gemini structured output). */
  jsonSchema?: Record<string, unknown>;
  /** Prior turns, oldest first. */
  history?: { role: "user" | "model"; text: string }[];
}

function buildBody(prompt: string, o: GenerateOptions) {
  const contents = [
    ...(o.history ?? []).map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: "user", parts: [{ text: prompt }] },
  ];
  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: o.temperature ?? 0.2,
      maxOutputTokens: o.maxOutputTokens ?? 4096,
      ...(o.jsonSchema
        ? { responseMimeType: "application/json", responseSchema: o.jsonSchema }
        : {}),
    },
    // Exam questions cover biology, history and war; the default filters trip on
    // real syllabus content, so use the lowest setting short of off.
    safetySettings: [
      "HARM_CATEGORY_HARASSMENT",
      "HARM_CATEGORY_HATE_SPEECH",
      "HARM_CATEGORY_SEXUALLY_EXPLICIT",
      "HARM_CATEGORY_DANGEROUS_CONTENT",
    ].map((category) => ({ category, threshold: "BLOCK_ONLY_HIGH" })),
  };
  if (o.system) body.systemInstruction = { parts: [{ text: o.system }] };
  return body;
}

export async function generate(prompt: string, o: GenerateOptions = {}): Promise<string> {
  const body = buildBody(prompt, o);
  let lastError: Error | null = null;

  for (const model of CHAT_MODELS) {
    let data;
    try {
      const res = await callGemini(`models/${model}:generateContent`, body);
      data = await res.json();
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      continue;   // out of quota or unavailable: fall through to the next
    }
    const candidate = data?.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .map((p: { text?: string }) => p.text ?? "")
      .join("");
    if (text) return text;

    const reason = candidate?.finishReason ?? data?.promptFeedback?.blockReason;
    lastError = new Error(`${model} returned no text (${reason ?? "unknown"}).`);
  }
  throw lastError ?? new Error("No Gemini model produced a response.");
}

/** generate() with a schema, parsed. Falls back to brace-extraction if needed. */
export async function generateJSON<T>(
  prompt: string,
  schema: Record<string, unknown>,
  o: Omit<GenerateOptions, "jsonSchema"> = {},
): Promise<T> {
  const raw = await generate(prompt, { ...o, jsonSchema: schema });
  return parseJSON<T>(raw);
}

export function parseJSON<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1)) as T;
    throw new Error("Model did not return valid JSON.");
  }
}

/**
 * Streaming generate. A model can open a stream and still end with no text
 * (safety block, empty candidate), so that falls through to the next model.
 * Safe because we only switch before anything has been yielded.
 */
export async function* generateStream(
  prompt: string,
  o: GenerateOptions = {},
): AsyncGenerator<string> {
  let lastError: Error | null = null;

  for (const model of CHAT_MODELS) {
    let res: Response;
    try {
      res = await callGemini(`models/${model}:streamGenerateContent`, buildBody(prompt, o), { stream: true });
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      continue;
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let yielded = false;
    let finishReason: string | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const chunk = JSON.parse(payload);
          const candidate = chunk?.candidates?.[0];
          finishReason = candidate?.finishReason ?? chunk?.promptFeedback?.blockReason ?? finishReason;
          const parts = candidate?.content?.parts ?? [];
          for (const p of parts) {
            if (p.text) {
              yielded = true;
              yield p.text as string;
            }
          }
        } catch {
          /* partial frame. The next read completes it */
        }
      }
    }

    if (yielded) return;   // this model answered; the chain stops here
    lastError = new Error(`${model} returned no text (${finishReason ?? "unknown"}).`);
  }

  throw lastError ?? new Error("No Gemini model produced a response.");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n);
}
