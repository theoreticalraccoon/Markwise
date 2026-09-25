/**
 * Retrieval, the part that makes this different from asking Gemini directly:
 *   1. Pull exact identifiers out of the question ("4PH1 June 2024 Paper 1P Q4(b)")
 *      and use them as SQL filters, not similarity hints.
 *   2. Hybrid search (vector + full text, RRF-fused) inside those filters.
 *   3. Pull in sibling parts, since 4(b) often needs 4(a)'s stem.
 *   4. Pack highest score first until the character budget runs out.
 * The model always gets the verbatim question and scheme.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { embedOne } from "./gemini.ts";

export interface Chunk {
  id: string;
  subject_code: string;
  kind: "question" | "markscheme" | "syllabus" | "examiner_report";
  paper_code: string | null;
  year: number | null;
  session: string | null;
  paper_no: number | null;
  variant: number | null;
  question_no: string | null;
  marks: number | null;
  command_word: string | null;
  topic: string | null;
  syllabus_refs: string[];
  content: string;
  ms_content: string | null;
  er_content: string | null;
  page: number | null;
  score?: number;
}

export interface Citation {
  id: string;
  label: string;        // '4PH1 Jun 2024 Paper 1P Q4(b)'
  paperCode: string | null;
  questionNo: string | null;
  marks: number | null;
  topic: string | null;
  kind: string;
}

/* --------------------------------------------------- query understanding -- */

const SESSION_LETTER: Record<string, string> = { j: "Jan", m: "Mar", s: "Jun", w: "Nov" };

export interface QueryFilters {
  paperCode?: string;
  years?: number[];
  questionNo?: string;
  session?: string;
  paperNo?: number;
  /** The paper reference as printed: "1H", "2PR", "01", "42". */
  paperRef?: string;
  /** An Edexcel subject code named in the text, e.g. "E-4PH1". */
  subjectCode?: string;
}

/** Exam identifiers from free text: filename forms and how students write them ("4PH1 paper 1P June 2024 question 7b"). */
export function parseQuery(text: string): QueryFilters {
  const f: QueryFilters = {};
  const t = text.toLowerCase();

  // Filename forms: e-4ph1_s24_qp_1p, e-4ma1_j24_ms_2h, 0625_s19_qp_42. \b doesn't
  // work around underscores, so the separators are matched explicitly.
  const file = t.match(
    /(?:^|[^a-z0-9])((?:[a-z]{1,3}-)?[a-z0-9]{3,12})[_ -]([jmsw])(\d{2})[_ -]?(?:qp|ms|er|papers?|p)?[_ -]?(\d[0-9a-z]{0,2})(?:[^0-9a-z]|$)/,
  );
  if (file && /\d/.test(file[1])) {
    const yy = Number(file[3]);
    f.paperCode = `${file[1]}_${file[2]}${file[3]}`;
    f.years = [yy + (yy > 50 ? 1900 : 2000)];
    f.session = SESSION_LETTER[file[2]];
    f.paperRef = file[4].toUpperCase();
    f.paperNo = Number(file[4].replace(/^0+/, "")[0]);
    if (/^[a-z]-/.test(file[1])) f.subjectCode = file[1].toUpperCase();
  }

  // An Edexcel code written on its own: "4PH1", "4ma1 1h".
  if (!f.subjectCode) {
    const code = t.match(/(?:^|[^a-z0-9])(4[a-z]{2}\d)(?=[^a-z0-9]|$)/)?.[1];
    if (code) f.subjectCode = `E-${code.toUpperCase()}`;
  }

  // Plain year, e.g. "2024" or "june 2021"
  if (!f.years) {
    const years = [...t.matchAll(/\b(20[0-2]\d)\b/g)].map((m) => Number(m[1]));
    if (years.length) f.years = [...new Set(years)];
  }
  if (!f.session) {
    if (/\b(january|jan)\b/.test(t)) f.session = "Jan";
    // "may" is also a verb, so it only means May with a year or "june" after it.
    else if (/\b(june|jun|summer|may\s*\/\s*june|may\s+20\d\d)\b/.test(t)) f.session = "Jun";
    else if (/\b(november|nov|winter|oct\/nov|october)\b/.test(t)) f.session = "Nov";
    else if (/\b(march|feb\/mar|february)\b/.test(t)) f.session = "Mar";
  }

  // "paper 1P", "paper 2H", "paper 4": an explicit reference beats a guess.
  if (f.paperNo === undefined) {
    const p = t.match(/\bpaper\s*(\d{1,2}[a-z]{0,2})\b/);
    if (p) {
      f.paperRef = f.paperRef ?? p[1].toUpperCase();
      f.paperNo = Number(p[1].replace(/^0+/, "")[0]);
    }
  }
  // "4ph1 1p", "4ma1/2h": the reference following an Edexcel code.
  if (!f.paperRef && f.subjectCode) {
    const code = f.subjectCode.slice(2).toLowerCase();
    const r = t.match(new RegExp(code + "[\\s/_-]+(0?[12][a-z]{0,2})(?=[^a-z0-9]|$)"));
    if (r) {
      f.paperRef = r[1].toUpperCase();
      f.paperNo = Number(r[1].replace(/^0+/, "")[0]);
    }
  }

  // q4b, question 4(b)(ii), Q7 (a). Roman numerals only count in brackets,
  // or "question 4 is" becomes 4(i).
  const q = t.match(/\b(?:q|question)\s*\.?\s*(\d{1,2})(?:\s*\(([a-h])\)|([a-h])(?![a-z]))?\s*(?:\(((?:i|v|x)+)\))?/);
  if (q) {
    const part = q[2] ?? q[3];
    f.questionNo = q[1] + (part ? `(${part})` : "") + (q[4] ? `(${q[4]})` : "");
  }
  return f;
}

/** Exam sitting dates are not publication dates; retain dates for paper lookups. */
export function learningFilters(text: string): QueryFilters {
  const filters = parseQuery(text);
  if (!filters.paperCode && !filters.questionNo && !filters.paperRef &&
      !/\b(?:past\s+papers?|papers?\s+(?:from|in|of)|questions?\s+(?:from|in))\b/i.test(text)) {
    delete filters.years;
    delete filters.session;
  }
  return filters;
}

/** Only referential follow-ups inherit topic text, never generated answer claims. */
export function contextualQuery(question: string, history: { role: string; text: string }[] = []): string {
  if (!/\b(?:it|that|this|these|those|they|them|again|simpler|more detail|another example)\b|^(?:why|how so|continue|go on)[?!.\s]*$/i.test(question)) return question;
  const prior = history.filter((h) => h.role === "user" && typeof h.text === "string").slice(-2);
  return [...prior.map((h) => h.text.slice(0, 1000)), question].join("\n");
}

const FILLER = new Set(("a an the and or but of to in on for with from by at as is are was were be been being " +
  "i me my we our you your it its this that these those they them do does did can could would should " +
  "will shall may how what why when where which who please explain explanation tell help know need " +
  "learn learning understand understanding about more give show find exam exams examination igcse edexcel " +
  "pearson international gcse question questions answer answers marks marking points paper papers syllabus").split(" "));

export function keywordQuery(query: string): string {
  const topic = query.toLowerCase().replace(/\b(?:difference|differences|comparison)\s+between\b/g, " ");
  return [...new Set(topic.match(/[a-z][a-z0-9]*/g) ?? [])]
    .filter((word) => word.length >= 3 && !FILLER.has(word) && !/^4[a-z]{2}\d$/.test(word))
    .slice(0, 20).map((word) => `"${word}"`).join(" OR ");
}

/* ---------------------------------------------------------------- search -- */

export interface SearchOptions {
  subject?: string | null;
  kinds?: string[] | null;
  topic?: string | null;
  count?: number;
  expandSiblings?: boolean;
  includeSyllabus?: boolean;
  filters?: QueryFilters;
}

/** Columns every retrieval path returns. Never includes the embedding. */
const CHUNK_FIELDS =
  "id,subject_code,kind,paper_code,year,session,paper_no,variant,question_no," +
  "marks,command_word,topic,syllabus_refs,content,ms_content,er_content,page";

/**
 * A named paper and question are looked up directly. Similarity can't do this:
 * "Q1(a)" carries almost no meaning, and the wrong question means the wrong scheme.
 */
async function exactLookup(
  db: SupabaseClient,
  filters: QueryFilters,
  subject?: string | null,
): Promise<{ rows: Chunk[]; ambiguous: string[] }> {
  const none = { rows: [] as Chunk[], ambiguous: [] as string[] };
  if (!filters.questionNo) return none;

  // A question number needs a paper: a code, or a year and series.
  const oneYear = filters.years?.length === 1 ? filters.years[0] : null;
  if (!filters.paperCode && !(oneYear && filters.session)) return none;

  let q = db
    .from("chunks")
    .select(`${CHUNK_FIELDS},paper_id,paper_ref`)
    .eq("kind", "question")
    .limit(400);
  const code = subject ?? filters.subjectCode ?? null;
  if (code) q = q.eq("subject_code", code);
  if (filters.paperCode) q = q.ilike("paper_code", `%${filters.paperCode}%`);
  if (oneYear) q = q.eq("year", oneYear);
  if (filters.session) q = q.eq("session", filters.session);
  if (filters.paperRef) q = q.ilike("paper_ref", filters.paperRef);

  const { data, error } = await q;
  if (error) throw new Error(`Question lookup failed: ${error.message}`);
  if (!data) return none;

  // Several papers still match (a 1H and a 2H both have Q4). Don't pick one;
  // tell the caller which papers are candidates.
  const papers = new Map<string, string>();
  for (const c of data as (Chunk & { paper_id: string })[]) {
    papers.set(c.paper_id, c.paper_code ?? c.paper_id);
  }
  if (papers.size > 1) return { rows: [], ambiguous: [...papers.values()].sort() };

  // Compare stripped forms: "4(b)", "4 b" and "4b" are the same question.
  const want = filters.questionNo.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const rows = data as Chunk[];

  const exact = rows.filter((c) => strip(c.question_no) === want);
  // "Q4" should also bring back 4(a), 4(b)(i). The whole question.
  const children = rows.filter((c) => {
    const got = strip(c.question_no);
    return got.startsWith(want) && got !== want && !/^\d/.test(got.slice(want.length));
  });

  return {
    rows: [...exact, ...children].slice(0, 12).map((c, i) => ({ ...c, score: 100 - i })),
    ambiguous: [],
  };
}

function strip(n: string | null): string {
  return (n ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/** Search results. `ambiguous` lists papers when a question number matched several. */
export type SearchHits = Chunk[] & { ambiguous?: string[] };

export async function search(
  db: SupabaseClient,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchHits> {
  const filters = opts.filters ?? parseQuery(query);

  // A named paper + question beats anything similarity finds.
  const lookup = await exactLookup(db, filters, opts.subject);
  const pinned = lookup.rows;

  // An explicit reference resolves exactly or is refused; neighbours can't stand in.
  const exactReference = filters.questionNo &&
    (filters.paperCode || (filters.years?.length === 1 && filters.session));
  if (exactReference) {
    const hits: SearchHits = opts.expandSiblings && pinned.length
      ? await expandSiblings(db, pinned) : pinned;
    if (lookup.ambiguous.length) hits.ambiguous = lookup.ambiguous;
    return hits;
  }

  let embedding: number[] | null = null;
  try {
    embedding = await embedOne(query, "RETRIEVAL_QUERY");
  } catch (e) {
    // match_chunks supports a null vector and still searches the real corpus.
    console.warn("Embedding unavailable; using full-text retrieval:", e instanceof Error ? e.message : String(e));
  }

  const params = {
    query_embedding: embedding,
    query_text: query,
    p_subject: opts.subject ?? filters.subjectCode ?? null,
    p_kinds: opts.kinds ?? null,
    p_years: filters.years ?? null,
    p_paper_code: filters.paperCode ?? null,
    p_topic: opts.topic ?? null,
    match_count: opts.count ?? 8,
    p_session: filters.session ?? null,
    p_paper_ref: filters.paperRef ?? null,
  };
  let { data, error } = await db.rpc("match_chunks", params);
  if (error) throw new Error(`Retrieval failed: ${error.message}`);

  const alternatives = keywordQuery(query);
  if (alternatives && alternatives !== query) {
    // Search topic words without the conversational filler: the conjunction
    // first, then ranked alternatives to fill sparse results.
    const conjunction = alternatives.replaceAll(" OR ", " ");
    const strict = await db.rpc("match_chunks", { ...params, query_embedding: null, query_text: conjunction });
    if (strict.error) throw new Error(`Retrieval failed: ${strict.error.message}`);
    const lexical = conjunction === alternatives || (strict.data?.length ?? 0) >= (opts.count ?? 8)
      ? strict
      : await db.rpc("match_chunks", { ...params, query_embedding: null, query_text: alternatives });
    if (lexical.error) throw new Error(`Retrieval failed: ${lexical.error.message}`);
    // Fuse ranked lists, not raw SQL scores: otherwise one branch can dominate.
    const merged = new Map<string, Chunk>();
    const lexicalRows = [...(strict.data ?? []), ...(lexical.data ?? [])];
    const uniqueLexical = [...new Map(lexicalRows.map((row: Chunk) => [row.id, row])).values()];
    for (const list of [uniqueLexical, data ?? []]) {
      for (const [rank, row] of (list as Chunk[]).entries()) {
        const old = merged.get(row.id);
        merged.set(row.id, { ...row, score: (old?.score ?? 0) + 1 / (60 + rank + 1) });
      }
    }
    data = [...merged.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, opts.count ?? 8);
  }

  let hits: SearchHits = (data ?? []) as Chunk[];
  if (opts.includeSyllabus && alternatives) {
    const spec = await db.rpc("match_chunks", {
      ...params, query_embedding: null, query_text: alternatives,
      p_kinds: ["syllabus"], match_count: 2,
    });
    if (spec.error) throw new Error(`Specification retrieval failed: ${spec.error.message}`);
    const ids = new Set((spec.data ?? []).map((c: Chunk) => c.id));
    const topScore = Math.max(0, ...hits.map((c) => c.score ?? 0));
    hits = [...(spec.data ?? []).map((c: Chunk, i: number) => ({ ...c, score: topScore + 0.001 / (i + 1) })),
      ...hits.filter((c) => !ids.has(c.id))];
  }
  if (lookup.ambiguous.length) hits.ambiguous = lookup.ambiguous;

  // Merge the pinned exact matches in front, de-duplicated.
  if (pinned.length) {
    const seen = new Set(pinned.map((c) => c.id));
    const ambiguous = hits.ambiguous;
    hits = [...pinned, ...hits.filter((c) => !seen.has(c.id))];
    if (ambiguous) hits.ambiguous = ambiguous;
  } else if (filters.questionNo) {
    // Only a number was given, so promote exact number matches.
    const want = strip(filters.questionNo);
    hits.sort((a, b) => rankExact(b, want) - rankExact(a, want));
  }

  if (opts.expandSiblings && hits.length) {
    const ambiguous = hits.ambiguous;
    hits = await expandSiblings(db, hits);
    if (ambiguous) hits.ambiguous = ambiguous;
  }
  return hits;
}

function rankExact(c: Chunk, want: string): number {
  const got = (c.question_no ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (!got) return 0;
  if (got === want) return 2;
  if (got.startsWith(want) || want.startsWith(got)) return 1;
  return 0;
}

/** Pull in the other parts of the top hits' questions, de-duplicated. */
async function expandSiblings(db: SupabaseClient, hits: Chunk[]): Promise<Chunk[]> {
  const seeds = hits.filter((h) => h.kind === "question" && h.question_no).slice(0, 3);
  const seen = new Set(hits.map((h) => h.id));
  const out = [...hits];
  const siblingScore = Math.min(...hits.map((h) => h.score ?? 0)) - 0.001;
  for (const seed of seeds) {
    const { data } = await db.rpc("question_siblings", { p_chunk_id: seed.id });
    for (const sib of (data ?? []) as Chunk[]) {
      if (seen.has(sib.id)) continue;
      seen.add(sib.id);
      out.push({ ...sib, score: siblingScore });
    }
  }
  return out;
}

/** Fetch one question part plus every sibling, for the marking flow. */
export async function getQuestion(db: SupabaseClient, chunkId: string): Promise<Chunk[]> {
  const { data, error } = await db.rpc("question_siblings", { p_chunk_id: chunkId });
  if (error) throw new Error(`Question lookup failed: ${error.message}`);
  return (data ?? []) as Chunk[];
}

/* ----------------------------------------------------------- formatting -- */

export function label(c: Chunk): string {
  // Students say 4PH1, not E-4PH1.
  const code = (c.subject_code ?? "").replace(/^[A-Z]-/, "");
  if (c.kind === "syllabus") {
    return `${code} syllabus${c.topic ? `: ${c.topic}` : ""}`;
  }
  const bits = [code];
  if (c.session && c.year) bits.push(`${c.session} ${c.year}`);

  // The reference is the last part of the code; 1P/1PR and 1F/1H are different papers.
  const ref = c.paper_code?.split("_").length === 4 ? c.paper_code.split("_")[3].toUpperCase() : null;
  if (ref) bits.push(/^\d{2}$/.test(ref) ? `P${ref}` : `Paper ${ref}`);
  else if (c.paper_no) bits.push(`P${c.paper_no}${c.variant ?? ""}`);

  if (c.question_no) bits.push(`Q${c.question_no}`);
  return bits.join(" ");
}

export function toCitation(c: Chunk): Citation {
  return {
    id: c.id,
    label: label(c),
    paperCode: c.paper_code,
    questionNo: c.question_no,
    marks: c.marks,
    topic: c.topic,
    kind: c.kind,
  };
}

/** Numbered source block the prompts cite by index, highest score first, within budget. */
export function packContext(chunks: Chunk[], budget = 24000): { text: string; used: Chunk[] } {
  const ordered = [...chunks].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const used: Chunk[] = [];
  const parts: string[] = [];
  let spent = 0;

  for (const c of ordered) {
    const block = renderChunk(c, used.length + 1);
    if (spent + block.length > budget && used.length > 0) break;
    parts.push(block);
    used.push(c);
    spent += block.length;
  }
  return { text: parts.join("\n\n"), used };
}

function renderChunk(c: Chunk, n: number): string {
  const head = `[${n}] ${label(c)}${c.marks ? `, ${c.marks} mark${c.marks === 1 ? "" : "s"}` : ""}${c.topic ? `, topic: ${c.topic}` : ""}`;
  const lines = [head];
  if (c.kind === "syllabus") {
    lines.push(`SYLLABUS: ${c.content.trim()}`);
  } else {
    lines.push(`QUESTION: ${c.content.trim()}`);
    if (c.ms_content) lines.push(`MARK SCHEME: ${c.ms_content.trim()}`);
    if (c.er_content) lines.push(`EXAMINER REPORT: ${c.er_content.trim()}`);
  }
  if (c.syllabus_refs?.length) lines.push(`SYLLABUS REFS: ${c.syllabus_refs.join(", ")}`);
  return lines.join("\n");
}
