/**
 * Topic and command-word classification.
 *
 * Topics come from the subject's own specification, so "Forces" and "Forces and
 * motion" can't become two different buckets in the mastery table. Command
 * words are plain regex.
 */

import { generateJSON } from "./gemini.js";
import { LLM_CLASSIFY } from "./config.js";

/** Longest first, so "state" doesn't shadow "state and explain". */
const COMMAND_WORDS = [
  "compare and contrast", "describe and explain", "state and explain",
  "give a reason", "suggest why", "suggest how", "work out", "write down",
  "calculate", "describe", "determine", "evaluate", "explain", "identify",
  "justify", "predict", "sketch", "suggest", "compare", "complete", "define",
  "discuss", "estimate", "outline", "analyse", "assess", "deduce", "derive",
  "label", "prove", "show", "solve", "state", "give", "draw", "list", "name",
  "plot", "find",
];

export function commandWord(text) {
  const t = String(text ?? "").toLowerCase();
  for (const w of COMMAND_WORDS) {
    // Only at the start of a clause, not mid-sentence ("the state of the gas").
    if (new RegExp(`(^|[.;:)]\\s*|\\n\\s*)${w}\\b`).test(t)) return w;
  }
  return null;
}

/* ------------------------------------------------------------- topic sets -- */

// Topics come only from the subject's ingested spec, never a hardcoded list
// (the old one was Cambridge-only). Two is enough: English Language A is
// organised by two exam components, not content topics.
const MIN_REAL_TOPICS = 2;

export async function topicVocabulary(db, subjectCode) {
  const { data } = await db
    .from("chunks")
    .select("topic")
    .eq("subject_code", subjectCode)
    .eq("kind", "syllabus")
    .not("topic", "is", null)
    .limit(500);

  const fromSyllabus = [...new Set((data ?? []).map((r) => r.topic).filter(Boolean))];
  return fromSyllabus.length >= MIN_REAL_TOPICS ? fromSyllabus : [];
}

/* ----------------------------------------------------------- classifying -- */

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          i: { type: "number", description: "Index from the input list." },
          topic: { type: "string", description: "Exactly one label from TOPICS." },
          refs: { type: "array", items: { type: "string" }, description: "Syllabus reference codes if visible." },
        },
        required: ["i", "topic"],
      },
    },
  },
  required: ["items"],
};

const SYSTEM = `
You label IGCSE exam questions with the syllabus topic they test.

Rules:
- Choose EXACTLY ONE label, copied character-for-character from the TOPICS
  list. Never invent a label, never merge two, never return a variation.
- Judge by what the question actually assesses, not by surface vocabulary. A
  question mentioning a car that is really about energy conservation is energy.
- If nothing in TOPICS fits, use the closest one. Do not return an empty topic.
`.trim();

/** Label a batch of parts in one call; the free tier is metered per request. */
export async function classifyBatch(parts, topics, subjectName) {
  if (parts.length === 0) return [];
  if (topics.length === 0) {
    // Say it loudly: silent nulls look exactly like "no weak topics".
    console.warn(`  ! NO TOPIC VOCABULARY for ${subjectName}: every question below is going in untagged. Ingest its syllabus first.`);
    return parts.map(() => ({ topic: null, refs: [] }));
  }
  if (!LLM_CLASSIFY) return parts.map(() => ({ topic: null, refs: [] }));

  const list = parts.map((p, i) => ({
    i,
    q: String(p.text).replace(/\s+/g, " ").slice(0, 320),
  }));

  let items = [];
  try {
    ({ items } = await generateJSON(
      [
        `SUBJECT: ${subjectName}`,
        `TOPICS:\n${topics.map((t) => `- ${t}`).join("\n")}`,
        `QUESTIONS:\n${JSON.stringify(list)}`,
      ].join("\n\n"),
      SCHEMA,
      // 4096 cut long-topic batches off mid-JSON and lost every label in them.
      { system: SYSTEM, maxOutputTokens: 8192 },
    ));
  } catch (e) {
    console.warn(`  classification failed (${e.message}): questions stay untagged`);
    return parts.map(() => ({ topic: null, refs: [] }));
  }

  // Snap each label back onto the vocabulary.
  const canon = new Map(topics.map((t) => [normalise(t), t]));
  const out = parts.map(() => ({ topic: null, refs: [] }));
  for (const it of items ?? []) {
    if (typeof it.i !== "number" || !out[it.i]) continue;
    out[it.i] = {
      topic: canon.get(normalise(it.topic)) ?? nearest(it.topic, topics),
      refs: Array.isArray(it.refs) ? it.refs.slice(0, 6) : [],
    };
  }
  return out;
}

function normalise(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Cheap nearest-label match for the occasional near-miss. */
function nearest(label, topics) {
  const n = normalise(label);
  if (!n) return null;
  let best = null, bestScore = 0;
  for (const t of topics) {
    const score = overlap(n, normalise(t));
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

function overlap(a, b) {
  const short = a.length < b.length ? a : b;
  const long = a.length < b.length ? b : a;
  if (long.includes(short)) return short.length / long.length;
  let hits = 0;
  for (let i = 0; i < short.length - 2; i++) {
    if (long.includes(short.slice(i, i + 3))) hits++;
  }
  return hits / Math.max(1, short.length - 2);
}
