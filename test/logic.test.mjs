/**
 * Logic tests: no database, network or browser. Filenames, question and scheme
 * parsing, pairing, retrieval query parsing, dates, escaping.
 * The retrieval block needs esbuild (to compile TypeScript) and skips without it.
 *
 *   node test/logic.test.mjs
 */
process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "dummy";
process.env.GEMINI_API_KEYS ??= "dummy";

import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = pathToFileURL(REPO + "/").href;

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : (fail++, console.log(`  FAIL ${label}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`));
};
const ok = (label, cond, detail = "") => {
  cond ? pass++ : (fail++, console.log(`  FAIL ${label} ${detail}`));
};

/* ------------------------------------------------------------- filenames -- */
console.log("filename parsing");
const { parseFilename, titleFor } = await import(ROOT + "ingest/lib/filename.js");

let f = parseFilename("0625_s19_qp_42.pdf");
eq("0625_s19_qp_42 → subject", f.subjectCode, "0625");
eq("0625_s19_qp_42 → session", f.session, "Jun");
eq("0625_s19_qp_42 → year", f.year, 2019);
eq("0625_s19_qp_42 → paper", f.paperNo, 4);
eq("0625_s19_qp_42 → variant", f.variant, 2);
eq("0625_s19_qp_42 → kind", f.kind, "qp");

f = parseFilename("0620_w21_ms_22.pdf");
eq("w21 → Nov", f.session, "Nov");
eq("w21 → 2021", f.year, 2021);
eq("ms kind", f.kind, "ms");

f = parseFilename("0580_m23_qp_12.pdf");
eq("m23 → Mar", f.session, "Mar");

f = parseFilename("0625_y20_sy.pdf");
eq("syllabus kind", f.kind, "sy");
eq("syllabus has no session", f.session, null);

f = parseFilename("0625_s19_gt.pdf");
eq("grade thresholds", f.kind, "gt");

f = parseFilename("Physics 2019 June Paper 42 Mark Scheme.pdf");
ok("year is never mistaken for a subject code", f === null, JSON.stringify(f));

f = parseFilename("0625_June_2019_ms_paper_42.pdf");
ok("loose: code found under underscores", f?.subjectCode === "0625", JSON.stringify(f));
ok("loose: recognised as a MARK SCHEME", f?.kind === "ms", JSON.stringify(f));
ok("loose: session", f?.session === "Jun", JSON.stringify(f));
ok("loose: year", f?.year === 2019, JSON.stringify(f));
ok("loose: paper + variant", f?.paperNo === 4 && f?.variant === 2, JSON.stringify(f));

ok("titleFor reads", titleFor(parseFilename("0625_s19_qp_42.pdf"), "Physics")
  === "Physics · Jun 2019 · Paper 42 · Question Paper",
  titleFor(parseFilename("0625_s19_qp_42.pdf"), "Physics"));

/* ------------------------------------------------------- question papers -- */
console.log("question paper parsing");
const { parseQuestionPaper, parseMarkScheme, cleanLines, looksParsed, consistency, offersChoice } =
  await import(ROOT + "ingest/lib/parse.js");

const qpPages = [{ n: 1, text: `
1 A car accelerates from rest.
(a) State what is meant by acceleration.
.................................................................
[1]
(b) The car reaches 20 m/s in 5.0 s.
(i) Calculate the acceleration.
[2]
(ii) Explain why the acceleration decreases at higher speed.
[3]
2 Fig. 2.1 shows a ray of light entering a glass block.
(a) Describe what happens to the ray.
[2]
© UCLES 2019
` }];

const questions = parseQuestionPaper(qpPages);
eq("question count", questions.length, 4);
eq("numbers", questions.map((q) => q.questionNo), ["1(a)", "1(b)(i)", "1(b)(ii)", "2(a)"]);
eq("marks", questions.map((q) => q.marks), [1, 2, 3, 2]);
ok("1(a) carries the question stem", questions[0].text.includes("A car accelerates from rest"), questions[0].text);
ok("1(b)(i) carries BOTH stems",
  questions[1].text.includes("A car accelerates from rest") && questions[1].text.includes("reaches 20 m/s"),
  questions[1].text);
ok("2(a) carries only its own stem",
  questions[3].text.includes("Fig. 2.1") && !questions[3].text.includes("A car"),
  questions[3].text);
ok("no un-marked stubs emitted", questions.every((q) => q.marks > 0));
ok("answer-line dots stripped", !questions[0].text.includes("......"), questions[0].text);
ok("UCLES footer stripped", !questions.some((q) => q.text.includes("UCLES")));
ok("looksParsed true", looksParsed(questions) === true);
ok("looksParsed false on junk", looksParsed([{ marks: null }]) === false);

/* ---------------------------------------------------------- mark schemes -- */
console.log("mark scheme parsing");
const msPages = [{ n: 1, text: `
Question Answer Marks
1(a) rate of change of velocity 1
1(b)(i) a = (20 - 0) / 5.0 = 4.0 m/s2 2
1(b)(ii) air resistance increases with speed 1
resultant force decreases 1
so acceleration decreases 1
2(a) the ray refracts towards the normal 2
` }];
const msRows = parseMarkScheme(msPages);
eq("ms row numbers", msRows.map((r) => r.questionNo), ["1(a)", "1(b)(i)", "1(b)(ii)", "2(a)"]);
ok("ms keeps full text for multi-line row",
  msRows[2].text.includes("air resistance") && msRows[2].text.includes("acceleration decreases"),
  msRows[2].text);

/* ---------------------------------------------------------------- pairing */
console.log("question ↔ mark scheme pairing");
const { pairQuestions } = await import(ROOT + "ingest/lib/pair.js");
const { paired, stats } = pairQuestions(questions, msRows);
eq("exact matches", stats.exact, 4);
ok("1(a) paired", paired[0].msText?.includes("rate of change"), paired[0].msText);
ok("1(b)(ii) paired", paired[2].msText?.includes("air resistance"), paired[2].msText);
ok("2(a) paired", paired[3].msText?.includes("refracts"), paired[3].msText);

// Fuzzy: mark scheme writes "1 b i" instead of "1(b)(i)"
const fuzzy = pairQuestions(
  [{ questionNo: "1(b)(i)", questionRoot: "1", text: "x", marks: 2 }],
  [{ questionNo: "1 b i", questionRoot: "1", text: "the answer", marks: 2 }],
);
ok("fuzzy numbering pairs", fuzzy.paired[0].msText === "the answer", JSON.stringify(fuzzy.stats));

// Safety: a part must NOT silently take the root row.
const unsafe = pairQuestions(
  [{ questionNo: "4(b)", questionRoot: "4", text: "x", marks: 2 }],
  [{ questionNo: "4", questionRoot: "4", text: "whole question scheme", marks: 8 }],
);
ok("part does not fall back to root scheme", unsafe.paired[0].msText === null,
  `got ${unsafe.paired[0].msText}`);

const uniqueTaskPart = pairQuestions(
  [{ questionNo: "B5", questionRoot: "B5", text: "Create the information sheet", marks: 16 }],
  [{ questionNo: "B5(a)", questionRoot: "B5", text: "sixteen layout criteria", marks: 16 }],
);
const unsafeLettered = pairQuestions(
  [{ questionNo: "B4(b)", questionRoot: "B4", text: "Explain the change", marks: 2 }],
  [{ questionNo: "B4", questionRoot: "B4", text: "Whole task guidance", marks: 19 }],
);
ok("lettered task parts cannot inherit a whole task scheme", unsafeLettered.paired[0].msText === null);
for (const [label, questionNo, rows] of [
  ["conflicting duplicate rows", "1(a)", [
    { questionNo: "1(a)", questionRoot: "1", text: "first answer" },
    { questionNo: "1(a)", questionRoot: "1", text: "different answer" },
  ]],
  ["multiple subparts", "1(a)", [
    { questionNo: "1(a)(i)", questionRoot: "1", text: "first subpart" },
    { questionNo: "1(a)(ii)", questionRoot: "1", text: "second subpart" },
  ]],
]) {
  const result = pairQuestions([{ questionNo, questionRoot: "1", text: "Question", marks: 2 }], rows);
  ok(`pairing refuses ${label}`, result.paired[0].msText === null);
}
ok("a whole practical task may use its only scheme part", uniqueTaskPart.paired[0].msText === "sixteen layout criteria");
const ambiguousTaskParts = pairQuestions(
  [{ questionNo: "B5", questionRoot: "B5", text: "x", marks: 4 }],
  [
    { questionNo: "B5(a)", questionRoot: "B5", text: "wrong a", marks: 2 },
    { questionNo: "B5(b)", questionRoot: "B5", text: "wrong b", marks: 2 },
  ],
);
ok("a whole task never guesses between multiple scheme parts", ambiguousTaskParts.paired[0].msText === null);

console.log("language-specific mark scheme variants");
{
  const { attachLanguageSchemeVariants } = await import(ROOT + "ingest/lib/groups.js");
  const { combineMarkSchemeVariants } = await import(ROOT + "ingest/lib/pair.js");
  const groups = new Map([
    ["cp0|2022|Jun|02", { meta: { subjectCode: "E-4CP0", year: 2022, session: "Jun", paperRef: "02" }, files: { qp: "paper.pdf" } }],
    ["cp0|2022|Jun|2A", { meta: { subjectCode: "E-4CP0", year: 2022, session: "Jun", paperRef: "2A" }, files: { ms: "python.pdf" } }],
    ["cp0|2022|Jun|2B", { meta: { subjectCode: "E-4CP0", year: 2022, session: "Jun", paperRef: "2B" }, files: { ms: "csharp.pdf" } }],
    ["cp0|2022|Jun|2C", { meta: { subjectCode: "E-4CP0", year: 2022, session: "Jun", paperRef: "2C" }, files: { ms: "java.pdf" } }],
    ["cp0|2023|Jun|2A", { meta: { subjectCode: "E-4CP0", year: 2023, session: "Jun", paperRef: "2A" }, files: { qp: "python-paper.pdf", ms: "python-scheme.pdf" } }],
  ]);
  attachLanguageSchemeVariants(groups);
  eq("shared Paper 02 receives all three language schemes",
    groups.get("cp0|2022|Jun|02").files.msVariants.map((item) => item.label), ["Python", "C#", "Java"]);
  eq("scheme-only language groups are consumed", [...groups.keys()], ["cp0|2022|Jun|02", "cp0|2023|Jun|2A"]);

  const combined = combineMarkSchemeVariants([
    { label: "Python", rows: [
      { questionNo: "1(a)", questionRoot: "1", text: "same theory answer", marks: 1 },
      { questionNo: "2(a)", questionRoot: "2", text: "print(value)", marks: 2 },
    ] },
    { label: "C#", rows: [
      { questionNo: "1(a)", questionRoot: "1", text: "same theory answer", marks: 1 },
      { questionNo: "2(a)", questionRoot: "2", text: "Console.WriteLine(value)", marks: 2 },
    ] },
  ]);
  eq("identical theory guidance is not duplicated", combined[0].text, "same theory answer");
  ok("language-specific guidance keeps both labelled variants",
    combined[1].text.includes("Python:\nprint(value)") && combined[1].text.includes("C#:\nConsole.WriteLine(value)"), combined[1].text);
}

console.log("pairing repair selection");
{
  const { selectPairingRepairs } = await import(ROOT + "ingest/lib/repair.js");
  const repairs = selectPairingRepairs(
    [
      { id: "a", question_no: "1(a)", ms_content: null },
      { id: "b", question_no: "1(b)", ms_content: "already paired" },
      { id: "c", question_no: "1(c)", ms_content: null },
    ],
    [
      { questionNo: "1(a)", msText: "proved scheme row" },
      { questionNo: "1(b)", msText: "replacement must not win" },
      { questionNo: "1(c)", msText: null },
    ],
  );
  eq("repair selects only null rows with an exact proved pairing", repairs,
    [{ id: "a", ms_content: "proved scheme row" }]);
}

/* ---------------------------------------------------------- command words */
console.log("command words");
const { commandWord } = await import(ROOT + "ingest/lib/classify.js");
eq("explain", commandWord("Explain why the acceleration decreases."), "explain");
eq("calculate", commandWord("(i) Calculate the acceleration."), "calculate");
eq("mid-sentence 'state' is not a command",
  commandWord("The state of the gas is measured."), null);
eq("after a full stop", commandWord("Fig 2.1 shows a block. Describe the motion."), "describe");

/* ------------------------------------------------- retrieval query parsing */
console.log("retrieval query parsing");
let build;
try {
  ({ build } = await import("esbuild"));
} catch {
  console.log("  (skipped: esbuild not installed: npm i -D esbuild)");
}
const out = build && await build({
  entryPoints: [join(REPO, "supabase/functions/_shared/retrieve.ts")],
  bundle: true, format: "esm", write: false, external: ["*"],
});
if (out) {
const mod = await import("data:text/javascript," + encodeURIComponent(
  out.outputFiles[0].text.replace(/import\s*\{[^}]*\}\s*from\s*"[^"]*gemini\.ts";?/g, "const embedOne = async () => [];"),
));
const pq = mod.parseQuery;
eq("filename form", pq("mark my 0625_s19_qp_42 Q4(b)").paperCode, "0625_s19");
eq("filename form year", pq("mark my 0625_s19_qp_42 Q4(b)").years, [2019]);
eq("question ref", pq("mark my 0625_s19_qp_42 Q4(b)").questionNo, "4(b)");
eq("prose session", pq("physics june 2021 paper 4 question 7b").session, "Jun");
eq("prose year", pq("physics june 2021 paper 4 question 7b").years, [2021]);
eq("prose paper", pq("physics june 2021 paper 4 question 7b").paperNo, 4);
eq("prose question", pq("physics june 2021 paper 4 question 7b").questionNo, "7(b)");
eq("november → Nov", pq("november 2020 paper 2").session, "Nov");
eq("no identifiers", pq("why does a parachute reach terminal velocity"), {});
eq("label", mod.label({ subject_code: "0625", session: "Jun", year: 2019, paper_no: 4, variant: 2, question_no: "4(b)", kind: "question" }),
  "0625 Jun 2019 P42 Q4(b)");

/* --------------------------------------------------------------- packing -- */
const packed = mod.packContext([
  { id: "a", score: 0.1, kind: "question", content: "low", marks: 1, subject_code: "0625", syllabus_refs: [] },
  { id: "b", score: 0.9, kind: "question", content: "high", ms_content: "points", marks: 3, subject_code: "0625", syllabus_refs: [] },
], 100000);
eq("packs highest score first", packed.used.map((c) => c.id), ["b", "a"]);
ok("renders mark scheme", packed.text.includes("MARK SCHEME: points"), packed.text);
const tiny = mod.packContext([
  { id: "a", score: 0.9, kind: "question", content: "x".repeat(500), subject_code: "0625", syllabus_refs: [] },
  { id: "b", score: 0.5, kind: "question", content: "y".repeat(500), subject_code: "0625", syllabus_refs: [] },
], 300);
eq("budget respected but never empty", tiny.used.length, 1);

}

/* ------------------------------------------------------------------ dates */
console.log("dates");
const d = await import(ROOT + "src/js/lib/dates.js");
const today = d.today();
eq("dueLabel today", d.dueLabel(today).cls, "today");
eq("dueLabel tomorrow", d.dueLabel(d.iso(d.addDays(new Date(), 1))).text, "Tomorrow");
eq("dueLabel overdue", d.dueLabel(d.iso(d.addDays(new Date(), -3))).text, "3 days overdue");
eq("dueLabel overdue singular", d.dueLabel(d.iso(d.addDays(new Date(), -1))).text, "1 day overdue");
eq("dueLabel none", d.dueLabel(null), null);
const week = d.weekOf(new Date("2026-09-16T12:00:00"));
eq("week starts Monday", week[0].getDay(), 1);
eq("week is 7 days", week.length, 7);
ok("monthGrid covers the month", d.monthGrid(new Date("2026-02-10T12:00:00")).flat().some((x) => x.getDate() === 28));
eq("minutesToHuman", [d.minutesToHuman(45), d.minutesToHuman(90), d.minutesToHuman(120)], ["45m", "1h 30m", "2h"]);

// Unreadable input must give null, never a guess.
eq("examStart Jun 2027 (the summer series starts in May)", d.examStart("Jun 2027").getMonth(), 4);
eq("examStart Jun 2027 year", d.examStart("Jun 2027").getFullYear(), 2027);
eq("examStart long month", d.examStart("June 2027").getMonth(), 4);
eq("examStart Nov 2026 (the autumn series starts in October)", d.examStart("Nov 2026").getMonth(), 9);
eq("examStart March", d.examStart("Mar 2028").getMonth(), 2);
eq("examStart with a comma", d.examStart("May, 2027").getMonth(), 4);
eq("examStart nonsense", d.examStart("sometime soon"), null);
eq("examStart empty", d.examStart(""), null);
eq("examStart null", d.examStart(null), null);

/* ---------------------------------------------------------------- escaping */
console.log("escaping and markdown");
const dom = await import(ROOT + "src/js/ui/dom.js");
eq("esc", dom.esc('<img src=x onerror="alert(1)">'),
  "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
const md = dom.renderMarkdown("**bold** and <script>alert(1)</script>\n- one\n- two\n\nCited [2] and [1, 3].");
ok("markdown escapes html", !md.includes("<script>"), md);
ok("markdown bold", md.includes("<strong>bold</strong>"));
ok("markdown list", md.includes("<li>one</li>") && md.includes("<li>two</li>"));
ok("citation pills", (md.match(/data-cite="/g) ?? []).length === 3, md);

// PDF text and student answers both contain angle brackets.
eq("escLines keeps newlines as breaks", dom.escLines("a<b\nc"), "a&lt;b<br>c");
ok("markdown unwraps stray LaTeX", dom.renderMarkdown("the $n$th term").includes("the nth term"));

/* ------------------------------------------------------------------ config */
console.log("client config");
const cfg = await import(ROOT + "src/js/config.js");
ok("planner sources include self-study", cfg.SOURCES.some((x) => x.id === "self"));
ok("task types include revision", cfg.TASK_TYPES.some((x) => x.id === "revision"));
eq("three priorities", cfg.PRIORITIES.map((x) => x.id), [0, 1, 2]);
ok("weekday names line up", cfg.WEEKDAYS.length === 7 && cfg.WEEKDAYS_LONG.length === 7);
eq("weekday 0 is Sunday", [cfg.WEEKDAYS[0], cfg.WEEKDAYS_LONG[0]], ["Sun", "Sunday"]);

// Edexcel. The repo started out Cambridge-shaped; each block pins one thing that broke.

console.log("edexcel: filenames and paper identity");
{
  let e = parseFilename("E-4PH1_s24_qp_1P.pdf");
  eq("1P keeps its reference", e.paperRef, "1P");
  eq("1P is paper 1", e.paperNo, 1);
  eq("1P has no tier", e.tier, null);

  const h = parseFilename("E-4MA1_s24_qp_1H.pdf");
  const f2 = parseFilename("E-4MA1_s24_qp_1F.pdf");
  ok("1H and 1F are different papers", h.paperRef !== f2.paperRef && h.code !== f2.code, `${h.code} vs ${f2.code}`);
  eq("H is the higher tier", h.tier, "H");
  eq("F is the foundation tier", f2.tier, "F");

  ok("1P and 1PR are different papers",
    parseFilename("E-4PH1_s24_qp_1P.pdf").paperRef !== parseFilename("E-4PH1_s24_qp_1PR.pdf").paperRef);

  e = parseFilename("E-4MA1_j24_ms_2H.pdf");
  eq("January is a series", e.session, "Jan");
  eq("January year", e.year, 2024);

  // The files this repo already held were named _13 for paper 1 Higher.
  e = parseFilename("E-4MA1_s24_qp_13.pdf");
  eq("legacy _13 reads as 1H", e.paperRef, "1H");
  eq("legacy _23 reads as 2H", parseFilename("E-4MA1_s24_qp_23.pdf").paperRef, "2H");

  // Cambridge is untouched.
  e = parseFilename("0625_s19_qp_42.pdf");
  eq("cambridge reference is two digits", e.paperRef, "42");
}

console.log("edexcel: Pearson's own download names");
{
  let e = parseFilename("4PH1_1P_que_20240514.pdf");
  eq("subject gets the board prefix", e.subjectCode, "E-4PH1");
  eq("que is a question paper", e.kind, "qp");
  eq("May is the summer series", e.session, "Jun");
  eq("reference", e.paperRef, "1P");
  eq("pairing code", e.code, "E-4PH1_s24_qp_1P");

  eq("Jan exam", parseFilename("4CH1_2C_que_20250113.pdf").session, "Jan");
  eq("Oct exam", parseFilename("4BS1_01_que_20241021.pdf").session, "Nov");

  // A May paper's scheme is dated August and used to be filed under November.
  const qp = parseFilename("4MA1_1H_que_20240514.pdf");
  const ms = parseFilename("4MA1_1H_rms_20240815.pdf");
  eq("scheme dated August is the SUMMER series", ms.session, "Jun");
  eq("scheme and paper share a pairing code", ms.code.replace("_ms_", "_qp_"), qp.code);
  eq("rms is a mark scheme", ms.kind, "ms");
  eq("pef is an examiner report", parseFilename("4MA1_1H_pef_20240815.pdf").kind, "er");
  // November papers are marked in January or February of the year after.
  eq("scheme dated February belongs to the previous November",
    [parseFilename("4PH1_1P_rms_20250220.pdf").session, parseFilename("4PH1_1P_rms_20250220.pdf").year], ["Nov", 2024]);
}

console.log("edexcel: question papers");
{
  // Edexcel: marks on their own line, and a question total that isn't a part.
  const edexcel = [{ n: 1, text: `
⟦Q1⟧ A car accelerates from rest.
(a) State what is meant by acceleration.
(1)
(b) Calculate the acceleration.
Show your working.
(2)
(Total for Question 1 is 3 marks)
⟦Q2⟧ Of these students
17 chose knitting and photography
(a) Complete the table.
(4)
(Total for Question 2 is 4 marks)
TOTAL FOR PAPER IS 7 MARKS
` }];
  const parts = parseQuestionPaper(edexcel);
  eq("edexcel numbers", parts.map((q) => q.questionNo), ["1(a)", "1(b)", "2(a)"]);
  eq("edexcel marks", parts.map((q) => q.marks), [1, 2, 4]);
  ok("a question total is never a part", parts.every((q) => !/Total for Question/.test(q.text)));

  // "17 chose knitting" is data in Q2. Only the margin marker tells them apart.
  ok("a number inside a sentence does not start a question", !parts.some((q) => q.questionNo.startsWith("17")));

  const c = consistency(parts, edexcel);
  eq("printed paper total is read", c.printed, 7);
  ok("consistent paper passes", c.ok === true, JSON.stringify(c));
  ok("looksParsed accepts it", looksParsed(parts, edexcel) === true);

  // A parse that has quietly lost a question must not pass.
  const lost = parts.filter((q) => !q.questionNo.startsWith("1("));
  const cl = consistency(lost, edexcel);
  ok("a missing question fails the check", cl.ok === false && cl.mismatched.length > 0, JSON.stringify(cl));

  // The DO NOT WRITE marker glued onto a marks line used to hide the (1).
  const glued = parseQuestionPaper([{ n: 1, text: `
⟦Q1⟧ Explain why.
(a) State the unit.
(1) DO NOT WRITE IN THIS AREA
(Total for Question 1 is 1 marks)
` }]);
  eq("marks survive DO NOT WRITE glued to them", glued.map((q) => q.marks), [1]);
}

console.log("edexcel: mark schemes");
{
  // Headers restated per question, "Total N marks" closers, and stacked-fraction
  // working that looks like a question number.
  const ms = parseMarkScheme([{ n: 1, text: `
Question Working Answer Mark Notes
1 (a) B 1 B1 cao
(b) C 1 B1 cao
Total 2 marks
Question Working Answer Mark Notes
12 12
2 125a c6 3 B3 for 125a c6 oe
Total 3 marks
3* 7c - 8ct2 = t2 + 3 oe 4 M1 for multiplying both sides
Total 4 marks
` }]);
  eq("scheme rows", ms.map((r) => r.questionNo), ["1(a)", "1(b)", "2", "3"]);
  ok("working that looks like a question number is not a row", !ms.some((r) => r.questionNo === "12"));
  ok("a question straight after a Total line is found (no restated header)", ms.some((r) => r.questionNo === "3"));

  const compact = parseMarkScheme([{ n: 1, text: `
Question Answer Mark
Number
1a
one correct device (1)
Question Answer Mark
Number
1hi
both items in the correct location (2)
Question Answer Mark
Number
2aiii flash memory uses solid state media (1)
Question Answer
Number Mark
2b(iii) two differences between the networks (2)
Question Indicative content
Number
3f candidates should evaluate both advantages and disadvantages
Question
Answer Notes Marks
number
4 (a) one correct observation 1
Answer Notes Marks
5 (a) one correct explanation 2
Question Answer Mark
6 (a) first option 1
(b)
second option 1
Question Mark scheme
7 (a) apply the generic level descriptors
` }]);
  eq("compact ICT scheme identifiers are expanded",
    compact.map((row) => row.questionNo), ["1(a)", "1(h)(i)", "2(a)(iii)", "2(b)(iii)", "3(f)", "4(a)", "5(a)", "6(a)", "6(b)", "7(a)"]);

  const programming = parseMarkScheme([{ n: 1, text: `
Question mp Answer Additional Guidance Mark
A1
1 (a) first theory answer (1)
Question mp Answer Additional Guidance Mark
B1
3 (a) a later theory answer (1)
Question mp Additional Guidance Mark
C1
2 (a) code-section answer printed after question 3 (1)
` }]);
  eq("programming schemes ignore mark-point codes and may return to an earlier root",
    programming.map((row) => row.questionNo), ["1(a)", "3(a)", "2(a)"]);
}

console.log("edexcel ICT: practical task papers");
{
  const paper = [{ n: 1, text: `
SECTION A
Task A1
The company needs a new logo.
Task A1a
Create a logo using circles and lines.
(3)
Task A1b
Explain why vector graphics are suitable.
(2)
(Total for Task A1 = 5 marks)
Task A2
Create the database report.
(4)
(Total for Task A2 = 4 marks)
SECTION B
Task B1
State one improvement.
(1)
(Total for Task B1 = 1 mark)
TOTAL FOR PAPER IS 10 MARKS
` }];
  const scheme = [{ n: 1, text: `
Task Answer Marks
A1 Graphics
a (i) Logo created using circles and lines
3
a (ii) Correctly positioned text
b(i) scalable without loss of quality
2
Total for Task A1 5
Section A continued
A2
correct fields and layout
4
Total for Task A2
B1 Evaluation
one suitable improvement
1
Total for Task B1 1
` }];

  const tasks = parseQuestionPaper(paper);
  const taskRows = parseMarkScheme(scheme);
  eq("practical paper emits task parts", tasks.map((q) => q.questionNo), ["A1(a)", "A1(b)", "A2", "B1"]);
  eq("practical paper sums allocations within each task part", tasks.map((q) => q.marks), [3, 2, 4, 1]);
  ok("practical task parts carry their task stem", tasks[0].text.includes("company needs a new logo"), tasks[0].text);
  ok("practical paper passes its printed total", consistency(tasks, paper).ok, JSON.stringify(consistency(tasks, paper)));
  eq("practical scheme emits matching task parts", taskRows.map((row) => row.questionNo), ["A1(a)", "A1(b)", "A2", "B1"]);
  const taskPairs = pairQuestions(tasks, taskRows);
  eq("practical tasks pair exactly", taskPairs.stats.exact, 4);
  ok("practical marking guidance is retained verbatim", taskPairs.paired[1].msText.includes("scalable without loss of quality"));

  const compactRows = parseMarkScheme([{ n: 1, text: `
Task Answer Marks
A1 Graphics
a Logo criteria
Total for Task A1 3
B2a Chart with suitable labels
B2b Filtered data
Total for Task B2 4
B3 Word processing
a Layout criteria
Total for Task B
` }]);
  eq("practical schemes accept joined root/part labels and truncated totals",
    compactRows.map((row) => row.questionNo), ["A1(a)", "B2(a)", "B2(b)", "B3(a)"]);
}

console.log("edexcel: retrieval");
if (out) {
const mod2 = await import("data:text/javascript," + encodeURIComponent(
  out.outputFiles[0].text.replace(/import\s*\{[^}]*\}\s*from\s*"[^"]*gemini\.ts";?/g, "const embedOne = async () => [];"),
));
const pq = mod2.parseQuery;

let q = pq("mark my E-4PH1_s24_qp_1P Q4(b)");
eq("filename form: paper code", q.paperCode, "e-4ph1_s24");
eq("filename form: reference", q.paperRef, "1P");
eq("filename form: subject", q.subjectCode, "E-4PH1");

q = pq("4PH1 paper 1P June 2024 question 7b");
eq("free text: subject", q.subjectCode, "E-4PH1");
eq("free text: reference", q.paperRef, "1P");
eq("free text: series", q.session, "Jun");
eq("free text: year", q.years, [2024]);
eq("free text: question", q.questionNo, "7(b)");

eq("january is a series", pq("january 2024 paper 2H q3").session, "Jan");
eq("Jun abbreviation", pq("Jun 2024 paper 1H Q3").session, "Jun");
eq("paper 2H", pq("Jan 2024 paper 2H Q3").paperRef, "2H");
eq("reference after a code", pq("4ma1 1h q3 june 2024").paperRef, "1H");

// "may" is a verb in physics questions.
eq("'may' as a verb is not a month", pq("what may be observed when copper reacts").session, undefined);
eq("'May 2024' is", pq("may 2024 paper 1P").session, "Jun");

// "question 4 is worth 3 marks" read the i of "is" as part (i).
eq("'is' is not a roman numeral", pq("question 4 is worth 3 marks").questionNo, "4");
eq("bracketed roman numeral still works", pq("question 4(b)(ii)").questionNo, "4(b)(ii)");
eq("no letter from a following word", pq("question 4 and 5").questionNo, "4");

// Labels: no board prefix, and the full paper reference.
eq("edexcel label", mod2.label({ subject_code: "E-4PH1", session: "Jun", year: 2024, paper_code: "E-4PH1_s24_qp_1P", question_no: "3(b)", kind: "question" }),
  "4PH1 Jun 2024 Paper 1P Q3(b)");
eq("1PR reads differently from 1P", mod2.label({ subject_code: "E-4PH1", session: "Jun", year: 2024, paper_code: "E-4PH1_s24_qp_1PR", question_no: "3", kind: "question" }),
  "4PH1 Jun 2024 Paper 1PR Q3");
}

console.log("edexcel: how a student talks to the assistant");
{
  const routing = await import(ROOT + "src/js/lib/routing.js");
  ok("'mark ...' is marking", routing.looksLikeMarking("mark my answer: 3n - 2"));
  ok("a reference plus a real answer is marking",
    routing.looksLikeMarking("Mark my answer to 4MA1 Jun 2024 Paper 1H Q3(b):\n3n - 2\nbecause it goes up by 3 each time"));
  ok("a short question about a paper is a question, not marking",
    !routing.looksLikeMarking("what does 4PH1 Jun 2024 Q4(b) want?"));
  ok("prose with no reference is never marking",
    !routing.looksLikeMarking("Explain how photosynthesis works in detail. It is needed for plants to grow and make food from light energy and water"));

  eq("a hyphen inside the answer does not split it",
    routing.splitMarkRequest("Q4(b) the pre-1970 rule: it applies to air-resistance"),
    { question: "Q4(b) the pre-1970 rule", answer: "it applies to air-resistance" });
  eq("colon separates reference from answer",
    routing.splitMarkRequest("Q4(b): 3n - 2"), { question: "Q4(b)", answer: "3n - 2" });
  eq("the library's draft is read",
    routing.splitMarkRequest("Mark my answer to 4PH1 Jun 2024 Paper 1P Q3(b):\nThe ray bends towards the normal"),
    { question: "4PH1 Jun 2024 Paper 1P Q3(b)", answer: "The ray bends towards the normal" });

  // This regex once shipped with a literal backspace for \b.
  ok("technique: full marks", routing.looksLikeTechnique("How do I get full marks on a 6-mark question?"));
  ok("technique: examiner", routing.looksLikeTechnique("what does the examiner want here"));
  ok("technique: structure", routing.looksLikeTechnique("How should I structure my answer?"));
  ok("technique: not for ordinary questions", !routing.looksLikeTechnique("explain photosynthesis"));
}

console.log("edexcel: how exam material is shown");
{
  const exam = await import(ROOT + "src/js/lib/exam.js");
  eq("board prefix is hidden", exam.displayCode("E-4PH1"), "4PH1");
  eq("paper reference from a code", exam.paperRefOf("E-4PH1_s24_qp_1PR"), "1PR");
  eq("a syllabus code has no reference", exam.paperRefOf("E-4PH1_y17_sy"), null);
  eq("full label", exam.paperLabel({ subject_code: "E-4PH1", session: "Jun", year: 2024, paper_code: "E-4PH1_s24_qp_1P", question_no: "3(b)" }),
    "4PH1 · Jun 2024 · Paper 1P · Q3(b)");
  eq("series and year are read from the code when a row lacks them",
    exam.paperLabel({ paper_code: "E-4MA1_j24_qp_2H", question_no: "5" }), "4MA1 · Jan 2024 · Paper 2H · Q5");
  eq("marks are printed in brackets", exam.markPill(3), "(3)");
  eq("Edexcel numeric paper references are not Cambridge variants",
    exam.paperLabel({ paper_code: "E-4AC1_s24_qp_01", question_no: "2" }),
    "4AC1 · Jun 2024 · Paper 01 · Q2");
}

console.log("edexcel: exam series countdown");
{
  // "June" means the summer series, which starts in May.
  eq("June is the summer series, from May", d.examStart("Jun 2027").getMonth(), 4);
  eq("May/June reads the first month", d.examStart("May/June 2027").getMonth(), 4);
  eq("Oct/Nov starts in October", d.examStart("Oct/Nov 2026").getMonth(), 9);
  eq("November is the autumn series, from October", d.examStart("Nov 2026").getMonth(), 9);
  eq("January", d.examStart("January 2027").getMonth(), 0);
  eq("a two-digit year is not guessed", d.examStart("Jun 27"), null);
}

console.log("markdown keeps money");
{
  const md2 = dom.renderMarkdown("Costs rise from $40 to $60 and revenue is $5");
  ok("prices survive", md2.includes("$40 to $60") && md2.includes("$5"), md2);
  ok("real maths is still unwrapped", dom.renderMarkdown("the nth term is $3n + k$").includes("3n + k") &&
    !dom.renderMarkdown("the nth term is $3n + k$").includes("$3n"));
  ok("a range of prices survives", dom.renderMarkdown("Range is $5-$10 per unit").includes("$5-$10"));
  ok("italics still work without a lookbehind", dom.renderMarkdown("this is *very* important").includes("<em>very</em>"));
  ok("a multiplication sign is not italics", !dom.renderMarkdown("2 * 3 * 4").includes("<em>"));
}

console.log("router: one click, one action");
{
  // Stacked listeners used to run every handler three times on a third visit.
  const src = await (await import("node:fs/promises")).readFile(join(REPO, "src/js/router.js"), "utf8");
  ok("the outlet is replaced on every navigation", /replaceWith\(/.test(src) && /cloneNode\(false\)/.test(src));
  ok("a superseded render is discarded", /navToken/.test(src) && /id !== navToken/.test(src));
  ok("an error message is escaped", /esc\(e\.message/.test(src));
}

console.log("consistency: optional-question papers are not \"wrong\"");
{
  // English Literature shape: four 30-mark questions, answer one per section,
  // total 60. Every part summing past 60 is correct.
  const choicePages = [{ n: 1, text: `
Answer ONE question from each section.
⟦Q1⟧ How is Beatrice presented?
(Total for Question 1 = 30 marks)
⟦Q2⟧ Explore the roles of men in the play.
(Total for Question 2 = 30 marks)
⟦Q3⟧ Discuss the significance of family.
(Total for Question 3 = 30 marks)
⟦Q4⟧ How far do you agree that Gerald is selfish?
(Total for Question 4 = 30 marks)
TOTAL FOR PAPER = 60 MARKS
` }];
  ok("the rubric is detected", offersChoice(choicePages));

  const choiceParts = [
    { questionRoot: "1", marks: 30 }, { questionRoot: "2", marks: 30 },
    { questionRoot: "3", marks: 30 }, { questionRoot: "4", marks: 30 },
  ];
  const cc = consistency(choiceParts, choicePages);
  eq("printed total is still read", cc.printed, 60);
  eq("the parsed sum is allowed to exceed it", cc.sum, 120);
  ok("a choice paper with nothing else wrong passes", cc.ok === true, JSON.stringify(cc));

  // A missing question still fails; the rubric only excuses the total check.
  const gap = consistency(choiceParts.filter((p) => p.questionRoot !== "2"), choicePages);
  ok("a missing question still fails, choice or not", gap.ok === false, JSON.stringify(gap));

  // "Answer ALL questions" isn't a choice paper.
  ok("a plain paper is not flagged as offering a choice",
    !offersChoice([{ n: 1, text: "Answer ALL questions. Write your answers in the spaces provided." }]));
  const allPages = [{ n: 1, text: `
⟦Q1⟧ State the unit.
(1)
(Total for Question 1 is 1 marks)
TOTAL FOR PAPER IS 3 MARKS
` }];
  const short = consistency([{ questionRoot: "1", marks: 1 }], allPages);
  ok("a plain paper's marks are still checked against the printed total", short.ok === false, JSON.stringify(short));
}

console.log("edexcel history: lettered question roots and alternatives");
{
  const historyPages = [{ n: 1, text: `
Answer ONE question.
A1 The origins and course of the First World War, 1905-18
(a) Describe TWO features of the Gallipoli campaign.
(6)
(b) Explain why the campaign failed.
(8)
EITHER
(c ) (i) How significant was the campaign?
(16)
OR
(ii) How far do you agree that leadership was the main reason for failure?
16)
(Total for Question A1 = 30 marks)
TOTAL FOR PAPER = 30 MARKS
` }];
  const historyParts = parseQuestionPaper(historyPages);
  eq("lettered History question numbers are preserved",
    historyParts.map((p) => p.questionNo), ["A1(a)", "A1(b)", "A1(c)(i)", "A1(c)(ii)"]);
  ok("EITHER/OR alternatives count once against the printed question total",
    consistency(historyParts, historyPages).ok === true,
    JSON.stringify(consistency(historyParts, historyPages)));

  const historyScheme = parseMarkScheme([{ n: 1, text: `
Generic Level Descriptors
Level Mark Descriptor
0 No rewardable material.
1 1-2 Simple comment.
Question
A1 (a) Describe TWO features of the Gallipoli campaign.
Indicative content for the first response.
Question
A1 (b) Explain why the campaign failed.
Indicative content for the second response.
Question
A1 (c)
(i) Indicative content for the first extended response.
Question
A1 (c)
(ii) Indicative content for the alternative extended response.
Question
B1 (a) Explain TWO ways the periods differed.
Indicative content for the third response.
` }]);
  eq("lettered History mark-scheme rows ignore generic level numbers",
    historyScheme.map((row) => row.questionNo),
    ["A1(a)", "A1(b)", "A1(c)(i)", "A1(c)(ii)", "B1(a)"]);
}

console.log("pdf.js: margin question numbers vs. dot-leader answer space");
{
  const { itemsToText, QUESTION_MARK, QUESTION_MARK_END } = await import(ROOT + "ingest/lib/pdf.js");
  const marker = (n) => `${QUESTION_MARK}${n}${QUESTION_MARK_END}`;

  // A pdf.js text item at page coordinates (origin bottom-left).
  const item = (str, x, y, { height = 12, width } = {}) => ({
    str, height, width: width ?? str.length * 6, transform: [1, 0, 0, 1, x, y],
  });

  // The page that lost FPM Q6: a margin number, then mostly dot-leader answer
  // lines at the same x, which used to drag the body-start estimate onto it.
  const DOTS = ".".repeat(220);
  const dotLeaderPage = [
    item("6", 70, 800),
    item("Figure 2 shows a right pyramid with vertex V and base ABCD", 89, 536),
    ...Array.from({ length: 12 }, (_, i) => item(DOTS, 70, 500 - i * 20)),
  ];
  const out = itemsToText(dotLeaderPage, 842, true);
  ok("a margin number survives a page mostly full of dot-leader answer space",
    out.includes(marker("6")), out);

  // And a number opening a real sentence at the body margin must still be rejected.
  const dataPage = [
    item("Figure 3 shows the results of a survey of favourite hobbies among students", 70, 700),
    item("17", 70, 680),
    item("chose knitting and photography as their favourite hobby this term", 82, 680),
  ];
  const out2 = itemsToText(dataPage, 842, true);
  ok("mid-paragraph data at the body margin is not mistaken for a question number",
    !out2.includes(marker("17")), out2);

  const historyPage = [
    item("A1", 70, 800),
    item("The origins and course of the First World War, 1905-18", 89, 800),
    item("Describe TWO features of the Gallipoli campaign", 89, 780),
  ];
  const out3 = itemsToText(historyPage, 842, true);
  ok("lettered History question numbers receive a margin marker",
    out3.includes(marker("A1")), out3);

  const diagramLabelPage = [
    item("V2", 70, 800),
    item("shows the velocity at the second point", 89, 800),
    item("1", 70, 760),
    item("State the unit of velocity used in the graph", 89, 760),
    item("The graph shows how the object moves throughout the experiment", 89, 740),
    item("Give your answer using the appropriate unit shown on the axis", 89, 720),
  ];
  const out4 = itemsToText(diagramLabelPage, 842, true);
  ok("a Physics diagram label is not promoted to a lettered question root",
    !out4.includes(marker("V2")) && out4.includes(marker("1")), out4);
}

console.log("pearson grade boundaries");
{
  const { parsePearsonBoundaries, tierOfBoundaryRef, seriesFromBoundaryFilename } =
    await import(ROOT + "ingest/lib/boundaries.js");

  // Shaped like Pearson's boundary PDF: heading, column header, then
  // "<code> <name> Raw <max> <boundaries>" and "Paper <ref>".
  const page = (text) => ({ text });
  const pages = [
    page([
      "Physics",
      "Notional component grade boundaries Max Mark 9 8 7 6 5 4 3 2 1 U",
      "4PH1 Physics Raw 110 83 73 63 56 49 43 36 30 24 0",
      "Paper 1P",
      "Mathematics A",
      "Notional component grade boundaries Max Mark 9 8 7 6 5 4 3 2 1 U",
      // Foundation tier stops at grade 5: six numbers after Raw, not ten.
      "4MA1 Mathematics A (Foundation) Raw 100 72 60 43 27 11 0",
      "Paper 1F",
    ].join("\n")),
  ];

  const rows = parsePearsonBoundaries(pages);
  eq("one row per paper", rows.length, 2);

  const physics = rows.find((r) => r.paperRef === "1P");
  eq("subject code", physics.code, "4PH1");
  eq("max mark", physics.maxMark, 110);
  eq("grade 9 boundary", physics.boundaries["9"], 83);
  eq("grade 1 boundary", physics.boundaries["1"], 24);
  ok("the trailing U figure is not stored as a grade", !("U" in physics.boundaries));

  const foundation = rows.find((r) => r.paperRef === "1F");
  eq("a foundation-tier row tops out at grade 5, not 9", foundation.boundaries["9"], undefined);
  eq("foundation grade 5 boundary", foundation.boundaries["5"], 72);
  eq("foundation grade 1 boundary", foundation.boundaries["1"], 11);

  // predict_grade filters boundaries on tier = the paper's tier, and papers
  // store "F"/"H". "Foundation"/"Higher" here meant tiered papers never graded.
  const { paperIdentity } = await import(ROOT + "ingest/lib/filename.js");
  eq("F/FR papers are tier F", tierOfBoundaryRef("1FR"), "F");
  eq("H/HR papers are tier H", tierOfBoundaryRef("2H"), "H");
  eq("a numeric-only paper ref has no tier", tierOfBoundaryRef("01"), null);
  for (const ref of ["1F", "1FR", "2H", "2HR"]) {
    eq(`boundary tier matches paper tier for ${ref}`, tierOfBoundaryRef(ref), paperIdentity("E-4MA1", ref).tier);
  }

  eq("wordy filename, June", seriesFromBoundaryFilename("grade-boundaries-june-2024-notional-component-int-gcse.pdf"),
    { year: 2024, session: "Jun" });
  eq("coded filename, June 2023", seriesFromBoundaryFilename("2306-intgcse-9-1-notional-component-grade-boundaries.pdf"),
    { year: 2023, session: "Jun" });
  eq("coded filename, January", seriesFromBoundaryFilename("2201_intGCSE_(9-1)_Subject_Grade_Boundaries_V1.pdf"),
    { year: 2022, session: "Jan" });
  eq("a filename that names no series", seriesFromBoundaryFilename("some-other-document.pdf"), null);
}

console.log("classification: no vocabulary is a loud warning, not a silent null");
{
  const { classifyBatch } = await import(ROOT + "ingest/lib/classify.js");
  const parts = [{ text: "Explain why the reaction rate increases." }];

  const seen = [];
  const realWarn = console.warn;
  console.warn = (...a) => seen.push(a.join(" "));
  let result;
  try {
    result = await classifyBatch(parts, [], "Some Subject");
  } finally {
    console.warn = realWarn;
  }

  eq("every question comes back untagged", result, [{ topic: null, refs: [] }]);
  ok("the operator is told why, by name", seen.some((s) => /no topic vocabulary/i.test(s) && s.includes("Some Subject")), seen.join(" | "));
}

console.log("syllabus: two-column ICT content tables");
{
  const { parseSyllabusTable } = await import(ROOT + "ingest/lib/syllabus.js");
  const pages = [{ n: 1, text: `
Contents
Topic 1: Digital Devices 11
Topic 2: Connectivity 14
Assessment information 27
` }, { n: 2, text: `
Topic 1: Digital Devices
Students need to know about the range of digital devices available.
1 Digital Devices Students should:
1.1 Types of digital devices 1.1.1 Be aware that mainframe computers are used for complex processing tasks.
Students need to know about computers and other digital devices.
1.1.2 Understand that laptop and desktop computers are types of personal computers.
1.2 Features of digital 1.2.1 Understand features of digital devices: portability and performance.
devices
Topic 2: Connectivity
2 Connectivity Students should:
2.1 Types of digital communications 2.1.1 Know the range of ways that digital devices communicate.
2.1.2 Know that digital devices can communicate by using networks.
Topic 5: Applying Information and Communication
Technology
5 Applying ICT Students should:
5.1 Software applications 5.1.1 Use word processing software effectively.
Pearson Edexcel International GCSE in Information and Communication Technology
Specification - Issue 2 - May 2018 (c) Pearson Education Limited 2018
Assessment information
` }];
  const sections = parseSyllabusTable(pages);
  eq("ICT table creates one chunk per subsection", sections.map((s) => s.ref), ["1.1", "1.2", "2.1", "5.1"]);
  eq("ICT table uses the top-level topic vocabulary", sections.map((s) => s.topic),
    ["Digital Devices", "Digital Devices", "Connectivity", "Applying Information and Communication Technology"]);
  ok("ICT outcomes remain verbatim", sections[0].content.includes("1.1.2 Understand that laptop and desktop computers"), sections[0].content);
  ok("ICT table headers are not syllabus content", !sections.some((s) => s.content.includes("Students should:")));
  ok("ICT table excludes repeated specification footers", !sections.some((s) => /Pearson Education Limited|Specification - Issue/.test(s.content)));
}

console.log("reembed: gives up on a quota that is out for the day");
{
  const { STALL_LIMIT, nextStalls } = await import(ROOT + "ingest/lib/reembed.js");

  let stalls = 0;
  stalls = nextStalls(stalls, 40); // a pass that embeds something
  eq("progress resets the stall count", stalls, 0);
  stalls = nextStalls(stalls, 0);
  eq("a fruitless pass counts as one stall", stalls, 1);
  stalls = nextStalls(stalls, 0);
  eq("two fruitless passes in a row is the give-up point", stalls, STALL_LIMIT);
  ok("STALL_LIMIT is small: this should not take hours to trip", STALL_LIMIT <= 3);
}

console.log("embedding: --no-embed skips the network entirely");
{
  const { embedAll } = await import(ROOT + "ingest/lib/gemini.js");
  // noEmbed returns before any Gemini call, so this never hits the network.
  const result = await embedAll(["a question", "another question"], { noEmbed: true });
  eq("every text comes back with no vector, not an error", result, [null, null]);
}

console.log("start fresh: every personal table is wiped");
{
  const { readFile, readdir } = await import("node:fs/promises");
  const migrations = join(REPO, "supabase/migrations");
  const sql = (await Promise.all((await readdir(migrations)).sort()
    .map((f) => readFile(join(migrations, f), "utf8")))).join("\n");
  // Every table with its own user_id column, from its create statement.
  const owned = new Set();
  for (const m of sql.matchAll(/create table if not exists public\.(\w+)\s*\(([\s\S]*?)\n\);/g)) {
    if (/^\s*user_id\b/m.test(m[2])) owned.add(m[1]);
  }
  const source = await readFile(join(REPO, "src/js/api/data.js"), "utf8");
  const listed = [...source.match(/const PERSONAL_TABLES = \[([\s\S]*?)\];/)[1].matchAll(/"(\w+)"/g)]
    .map((m) => m[1]);
  // Kept on purpose: the allowance ledger, per-user limits and admin rights.
  const kept = ["ai_usage", "ai_limits", "admins"];
  eq("the reset list is exactly the student's own tables",
    [...listed].sort(), [...owned].filter((t) => !kept.includes(t)).sort());
  ok("chat messages go before their threads",
    listed.indexOf("chat_messages") < listed.indexOf("chat_threads"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
