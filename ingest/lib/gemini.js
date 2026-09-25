// Gemini client for ingestion. Rotates keys; when quota runs out it tries
// each key once and then fails, rather than hanging a resumable run.

import { GEMINI_KEYS, CHAT_MODELS, EMBED_MODEL, EMBED_DIMS } from "./config.js";

const API = "https://generativelanguage.googleapis.com/v1beta";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cursor = 0;
async function call(path, body, { retries = 6 } = {}) {
  let last = "";
  const exhausted = new Set();
  for (let attempt = 0; attempt <= retries; attempt++) {
    let key;
    for (let i = 0; i < GEMINI_KEYS.length; i++) {
      const candidate = GEMINI_KEYS[cursor++ % GEMINI_KEYS.length];
      if (!exhausted.has(candidate)) { key = candidate; break; }
    }
    if (!key) throw new Error("Gemini quota exhausted for every configured key.");
    let res;
    try {
      res = await fetch(`${API}/${path}?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      last = `network: ${e.message}`;
      await sleep(backoff(attempt));
      continue;
    }

    if (res.ok) return res.json();

    if (res.status === 429) {
      exhausted.add(key);
      last = "429 rate limit";
      attempt--; // A different key does not consume the transient retry budget.
      continue;
    }
    if (res.status === 503 || res.status === 500) {
      last = `${res.status}`;
      await sleep(backoff(attempt));
      continue;
    }
    throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  throw new Error(`Gemini gave up after ${retries + 1} attempts (${last}).`);
}

function backoff(n) {
  return Math.min(20000, 800 * 2 ** n) + Math.random() * 500;
}

/* ------------------------------------------------------------------ embed -- */

export async function embedBatch(texts, taskType = "RETRIEVAL_DOCUMENT") {
  if (!texts.length) return [];
  const data = await call(`models/${EMBED_MODEL}:batchEmbedContents`, {
    requests: texts.map((t) => ({
      model: `models/${EMBED_MODEL}`,
      content: { parts: [{ text: t.slice(0, 8000) }] },
      taskType,
      outputDimensionality: EMBED_DIMS,
    })),
  });
  if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
    throw new Error("Incomplete embedding response.");
  }
  return data.embeddings.map((e) => {
    if (!Array.isArray(e.values) || e.values.length !== EMBED_DIMS ||
        !e.values.every((v) => typeof v === "number" && Number.isFinite(v)) ||
        !e.values.some((v) => v !== 0)) throw new Error("Invalid embedding vector.");
    return normalise(e.values);
  });
}

/**
 * Embed in batches. A failed batch lands its chunks as null instead of failing
 * the run. `noEmbed` returns all-null without calling Gemini (for when the
 * quota is known to be out; reembed picks them up later).
 */
export async function embedAll(texts, { noEmbed = false, batchSize = 96, onWarn = () => {} } = {}) {
  if (noEmbed) return texts.map(() => null);

  const out = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const slice = texts.slice(i, i + batchSize);
    try {
      out.push(...(await embedBatch(slice)));
    } catch (e) {
      onWarn(`embedding batch failed (${e.message}). Those chunks land unembedded; run 'reembed' later`);
      out.push(...slice.map(() => null));
    }
  }
  return out;
}

// Truncated 768-dim vectors come back with a norm around 0.57. Normalise so
// stored distances mean something.
export function normalise(values) {
  if (!Array.isArray(values)) return values;
  let sum = 0;
  for (const v of values) sum += v * v;
  const norm = Math.sqrt(sum);
  if (!norm || Math.abs(norm - 1) < 1e-6) return values;
  return values.map((v) => v / norm);
}

/* --------------------------------------------------------------- generate -- */

export async function generateJSON(prompt, schema, { system, temperature = 0, maxOutputTokens = 16384 } = {}) {
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens,
      responseMimeType: "application/json",
      responseSchema: schema,
    },
    safetySettings: [
      "HARM_CATEGORY_HARASSMENT",
      "HARM_CATEGORY_HATE_SPEECH",
      "HARM_CATEGORY_SEXUALLY_EXPLICIT",
      "HARM_CATEGORY_DANGEROUS_CONTENT",
    ].map((category) => ({ category, threshold: "BLOCK_ONLY_HIGH" })),
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  let lastError;
  for (const model of CHAT_MODELS) {
    let data;
    try {
      data = await call(`models/${model}:generateContent`, body);
    } catch (e) {
      lastError = e;
      continue;   // this model is out of quota or unavailable: try the next
    }

    const candidate = data?.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("");

    // Thinking models can burn the budget before writing; name that plainly.
    if (candidate?.finishReason === "MAX_TOKENS") {
      lastError = new Error(`${model} hit the output limit before finishing the JSON: raise maxOutputTokens or send a smaller batch.`);
      continue;
    }
    if (!text) {
      lastError = new Error(`${model} returned no text (${candidate?.finishReason ?? "unknown"}).`);
      continue;
    }

    try {
      return JSON.parse(text);
    } catch {
      const a = text.indexOf("{");
      const b = text.lastIndexOf("}");
      if (a >= 0 && b > a) {
        try {
          return JSON.parse(text.slice(a, b + 1));
        } catch { /* fall through to the next model */ }
      }
      lastError = new Error(`${model} returned malformed JSON.`);
    }
  }
  throw lastError ?? new Error("No Gemini model produced a usable response.");
}

/** OCR a page image, for scans and pages with no usable text layer. */
export async function ocrPage(pngBuffer, hint = "") {
  const body = {
    contents: [{
      role: "user",
      parts: [
        {
          text:
            "Transcribe this exam page exactly. Preserve question numbers, part " +
            "labels ((a), (b)(ii)), and the mark allocations in square brackets. " +
            "Describe any diagram in one bracketed line, e.g. [Diagram: a ray of " +
            "light entering a glass block]. Output plain text only." +
            (hint ? `\nContext: ${hint}` : ""),
        },
        { inlineData: { mimeType: "image/png", data: pngBuffer.toString("base64") } },
      ],
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 4096 },
  };
  let lastError;
  for (const model of CHAT_MODELS) {
    try {
      const data = await call(`models/${model}:generateContent`, body);
      const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
      if (text) return text;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new Error("OCR produced no text.");
}
