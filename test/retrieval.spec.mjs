import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: ["supabase/functions/_shared/retrieve.ts"],
  bundle: true, format: "esm", write: false,
});
globalThis.Deno = { env: { get: (name) => name === "GEMINI_API_KEYS" ? "test-key" : undefined } };
const source = compiled.outputFiles[0].text + "\n//# sourceURL=markwise-retrieval-test.mjs";
const { search, parseQuery, learningFilters, contextualQuery, keywordQuery } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
delete globalThis.Deno;

test("learning exam years do not restrict the publication year of evidence", () => {
  assert.equal(learningFilters("What do I need to know about electrolysis for my 2026 exam?").years, undefined);
  assert.deepEqual(learningFilters("Find electrolysis questions from 2024 past papers").years, [2024]);
  assert.equal(learningFilters("Explain E-4CH1_s24_qp_1C Q2").questionNo, "2");
});

test("follow-ups retrieve the student's topic, never the model's invented evidence", () => {
  const history = [{ role: "user", text: "Explain electrolysis" }, { role: "model", text: "invented evidence" }];
  assert.match(contextualQuery("Why does that happen?", history), /electrolysis/);
  assert.doesNotMatch(contextualQuery("Why does that happen?", history), /invented evidence/);
  assert.equal(contextualQuery("Explain covalent bonding", history), "Explain covalent bonding");
});

test("keyword retrieval removes conversational filler but retains scientific terms", () => {
  assert.equal(keywordQuery("Can you please explain electrolysis to me for my exam?"), '"electrolysis"');
  assert.match(keywordQuery("How do I find the nth term of an arithmetic sequence?"), /"nth" OR "term"/);
  assert.equal(keywordQuery("Explain the difference between series and parallel circuits"), '"series" OR "parallel" OR "circuits"');
});

test("syllabus sections never expand into the entire specification", async (t) => {
  quotaUnavailable(t);
  const syllabus = { ...chunk("syllabus", null), kind: "syllabus" };
  const db = database([chunk("unrelated", null)], { hits: [syllabus] });
  const hits = await search(db, "electrolysis", { expandSiblings: true });
  assert.deepEqual(hits.map((h) => h.id), ["syllabus"]);
  assert.ok(db.calls.every((call) => call.name !== "question_siblings"));
});

test("expanded siblings rank below every direct retrieval hit", async (t) => {
  quotaUnavailable(t);
  const db = database([chunk("sibling", "1(b)")], { hits: [chunk("direct", "1(a)")] });
  db.rpc = async (name, args) => ({ data: name === "question_siblings" ? [chunk("sibling", "1(b)")]
    : args.query_text === "explain algebra" ? [chunk("direct", "1(a)"), chunk("other", "2")]
    : [chunk("direct", "1(a)")], error: null });
  const hits = await search(db, "explain algebra", { expandSiblings: true });
  assert.ok(hits.find((h) => h.id === "sibling").score < hits.find((h) => h.id === "other").score);
});

test("teaching retrieves specification evidence separately from exam examples", async (t) => {
  quotaUnavailable(t);
  const db = database([]);
  db.rpc = async (name, args) => {
    db.calls.push({ name, args });
    return { data: [{ ...chunk(args.p_kinds?.[0] === "syllabus" ? "spec" : "example", "1"), kind: args.p_kinds?.[0] ?? "question" }], error: null };
  };
  const hits = await search(db, "enzymes", { includeSyllabus: true });
  assert.ok(hits.some((h) => h.id === "spec"));
  assert.ok(hits.some((h) => h.id === "example"));
});

test("clean topic conjunction is tried before broad keyword alternatives", async (t) => {
  quotaUnavailable(t);
  const db = database([]);
  await search(db, "Explain the difference between series and parallel circuits");
  assert.ok(db.calls.some((call) => call.args.query_text === '"series" "parallel" "circuits"'));
});

test("lexical search participates even when vector retrieval returns unrelated hits", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ embeddings: [{ values: Array(768).fill(1) }] }));
  const db = database([]);
  db.rpc = async (name, args) => {
    db.calls.push({ name, args });
    return { data: [chunk(args.query_text === '"electrolysis"' ? "relevant" : "unrelated", "1")], error: null };
  };
  const hits = await search(db, "Can you please explain electrolysis to me?", { count: 4 });
  assert.ok(hits.some((h) => h.id === "relevant"));
});

test("numeric and programming-language Edexcel references retain their full identity", () => {
  assert.equal(parseQuery("Accounting June 2024 paper 01 Q2").paperRef, "01");
  assert.equal(parseQuery("Accounting June 2024 paper 02R Q2").paperRef, "02R");
  assert.equal(parseQuery("E-4AC1_s24_qp_01 Q2").paperNo, 1);
  assert.equal(parseQuery("Computer science June 2024 paper 2A Q2").paperRef, "2A");
});

function chunk(id, question, paper = "1H") {
  return {
    id, paper_id: paper, subject_code: "E-4MA1", kind: "question",
    paper_code: `E-4MA1_s24_qp_${paper}`, paper_ref: paper,
    year: 2024, session: "Jun", paper_no: 1, variant: null,
    question_no: question, marks: 2, command_word: "calculate", topic: "Algebra",
    syllabus_refs: [], content: "Calculate the value of x.", ms_content: "x = 3",
    er_content: null, page: 2,
  };
}

function database(rows, { hits = [], error = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      assert.equal(table, "chunks");
      let selected = rows;
      const q = {
        select() { return q; }, limit() { return q; },
        eq(field, value) { selected = selected.filter((row) => row[field] === value); return q; },
        ilike(field, value) {
          selected = selected.filter((row) => String(row[field]).toLowerCase().includes(value.replaceAll("%", "").toLowerCase()));
          return q;
        },
        then(resolve) { return Promise.resolve({ data: selected, error }).then(resolve); },
      };
      return q;
    },
    async rpc(name, args) {
      calls.push({ name, args });
      return { data: name === "question_siblings" ? rows : hits, error };
    },
  };
}

function quotaUnavailable(t) {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response("quota exhausted", { status: 429 });
  });
  return () => requests;
}

test("exact paper and question lookup works without embedding quota", async (t) => {
  const requests = quotaUnavailable(t);
  const db = database([chunk("target", "1(a)"), chunk("sibling", "1(b)")]);
  const hits = await search(db, "E-4MA1_s24_qp_1H Q1(a)", { expandSiblings: true });
  assert.deepEqual(hits.map((h) => h.id), ["target", "sibling"]);
  assert.equal(requests(), 0);
  assert.ok(db.calls.every((call) => call.name === "question_siblings"));
});

test("ambiguous paper refuses before spending embedding quota", async (t) => {
  const requests = quotaUnavailable(t);
  const hits = await search(database([chunk("a", "1", "1H"), chunk("b", "1", "2H")]),
    "4MA1 June 2024 Q1");
  assert.equal(hits.length, 0);
  assert.deepEqual(hits.ambiguous, ["E-4MA1_s24_qp_1H", "E-4MA1_s24_qp_2H"]);
  assert.equal(requests(), 0);
});

test("missing exact question never substitutes a semantic neighbour", async (t) => {
  const requests = quotaUnavailable(t);
  const db = database([chunk("other", "2")], { hits: [chunk("other", "2")] });
  assert.deepEqual(await search(db, "E-4MA1_s24_qp_1H Q42"), []);
  assert.equal(requests(), 0);
  assert.equal(db.calls.length, 0);
});

test("whole question 1 includes its parts but never question 10", async (t) => {
  quotaUnavailable(t);
  const db = database([chunk("a", "1(a)"), chunk("b", "1(b)"), chunk("ten", "10(a)")]);
  assert.deepEqual((await search(db, "E-4MA1_s24_qp_1H Q1")).map((h) => h.id), ["a", "b"]);
});

test("embedding failure retains full-text retrieval and parsed subject filters", async (t) => {
  quotaUnavailable(t);
  const db = database([], { hits: [chunk("keyword", "3")] });
  const hits = await search(db, "4MA1 algebra", { kinds: ["question"], count: 4 });
  assert.equal(hits[0].id, "keyword");
  assert.equal(db.calls[0].args.query_embedding, null);
  assert.equal(db.calls[0].args.p_subject, "E-4MA1");
  assert.deepEqual(db.calls[0].args.p_kinds, ["question"]);
  assert.equal(db.calls[0].args.match_count, 4);
});

test("database failures are reported instead of looking like a missing question", async (t) => {
  quotaUnavailable(t);
  await assert.rejects(search(database([], { error: { message: "database unavailable" } }),
    "E-4MA1_s24_qp_1H Q1"), /database unavailable/);
});

test("conversational questions retry keyword search with alternatives when the strict query is empty", async (t) => {
  quotaUnavailable(t);
  const db = database([]);
  db.rpc = async (name, args) => {
    db.calls.push({ name, args });
    return { data: args.query_text.includes(" OR ") ? [chunk("sequence", "4")] : [], error: null };
  };
  const hits = await search(db, "How do I find the nth term of an arithmetic sequence?", { subject: "E-4MA1" });
  assert.equal(hits[0]?.id, "sequence");
  assert.equal(db.calls.length, 3);
  assert.equal(db.calls[1].args.p_subject, "E-4MA1");
  assert.equal(db.calls[1].args.query_embedding, null);
  assert.match(db.calls[2].args.query_text, /"nth" OR "term"/);
});
