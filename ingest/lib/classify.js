/**
 * Topic and command-word classification.
 *
 * Topics are what make everything personal: the weakness profile, the
 * "generate a mock on what I'm bad at" feature, and topic drilling all key off
 * this field. They must therefore come from a controlled vocabulary: the
 * subject's own syllabus sections: rather than whatever phrase the model
 * feels like producing, or "Forces" and "Forces and motion" become different
 * topics and the mastery table fragments into noise.
 *
 * Command words are pure regex. Cambridge publishes a fixed list of them and
 * they always open the imperative clause, so there is nothing for a model to
 * add here.
 */

import { generateJSON } from "./gemini.js";
import { LLM_CLASSIFY } from "./config.js";

/** Cambridge's published command words, longest first so "state" does not
 *  shadow "state and explain". */
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
    // Must open a clause, not appear mid-sentence ("the state of the gas").
    // A clause opens at the start, after sentence punctuation, after a newline,
    // or after a part label: "(i) Calculate the acceleration."
    if (new RegExp(`(^|[.;:)]\\s*|\\n\\s*)${w}\\b`).test(t)) return w;
  }
  return null;
}

/* ------------------------------------------------------------- topic sets -- */

/**
 * Topics for a subject, read from its own ingested specification.
 *
 * There used to be a hardcoded fallback dict here for subjects with no
 * specification ingested yet, keyed by Cambridge's bare four-digit codes
 * (0625, 0620, ...). It went dead the day the catalogue moved to Edexcel: no
 * `E-XXXX` code could ever match one of those keys, and every Edexcel
 * subject this app actually teaches has had its real specification ingested
 * before its papers (the documented order, in docs/PAPERS.md). A vocabulary
 * borrowed from the wrong board is worse than none, so a subject with no
 * specification yet gets nothing here — classifyBatch's caller is expected
 * to have warned loudly about that already, rather than quietly relabelling
 * questions against Cambridge's topic list.
 *
 * 2, not 4: a subject organised by exam component rather than content topic
 * (English Language A has exactly two: non-fiction/transactional writing,
 * poetry-prose/imaginative writing) has a real, useful, just SHORT
 * vocabulary. Requiring 4 discarded it entirely in favour of nothing.
 */
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

/**
 * Label a batch of question parts in one call. Batching matters: classification
 * is per-question and the free tier is per-request, so 40 questions in one
 * request is 40x cheaper in quota than 40 requests.
 */
export async function classifyBatch(parts, topics, subjectName) {
  if (parts.length === 0) return [];
  if (topics.length === 0) {
    // Silently tagging every question null here used to look identical to a
    // subject with no weak topics at all: the weakness profile and "drill
    // what I'm bad at" mock just went quiet. A subject only reaches this with
    // no syllabus ingested AND no fallback vocabulary for its code, which
    // should never happen once its specification has been loaded first.
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
      // 4096 was tight enough that a batch of 25 questions against a subject
      // with long topic names (observed: Chemistry) sometimes got cut off
      // mid-JSON, losing every label in that batch rather than just the
      // questions that didn't fit.
      { system: SYSTEM, maxOutputTokens: 8192 },
    ));
  } catch (e) {
    console.warn(`  classification failed (${e.message}): questions stay untagged`);
    return parts.map(() => ({ topic: null, refs: [] }));
  }

  // Snap every returned label back onto the vocabulary. The model is told to
  // copy exactly; this makes it true.
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
