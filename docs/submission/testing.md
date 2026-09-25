# Tests and results

All runs below are from 25 September 2026. Raw output is in [data/test-runs](data/test-runs).

| Suite | Command | What it checks | Result |
|---|---|---|---|
| Logic | `npm test` | Parsing, pairing, retrieval queries, grade boundaries, dates, escaping. No network | **239 assertions and 31 Node tests pass** |
| Parse check | `npm run check` | Every browser module and edge function parses; no stray control characters | 26 of 26 modules, 13 of 13 functions, 152 of 152 files clean |
| Security | `npm run test:security` | Row-level security against the live database with two throwaway students | **15 of 15 pass** |
| Browser | `npm run test:browser` | Every screen of the live app in headless Chromium, as a throwaway student | **23 of 23 pass** |
| Assistant | `npm run test:assistant` | Seven questions that used to go wrong, asked of the live assistant | 6 of 7 pass (below) |
| Parser audit | `node tools/audit-pdfs.mjs` | Every question paper against its own printed totals | 335 of 352 papers complete |
| Retrieval | `node tools/eval-retrieval.mjs` | 114 sampled questions, found by reference and by pasted text | 98.2% exact; 87.7% top 5 |
| Marking | `node tools/eval-marking.mjs` | 8 questions marked with full, half and blank answers | 8 of 8 ordered correctly |

CI (`.github/workflows/ci.yml`) runs the logic tests, the parse check, a syntax check of the
ingestion pipeline and a Deno type-check of every edge function on each push.

## How the logic tests are written

When we found a parser bug on a real paper, we wrote the smallest made-up input that
reproduces it and added it as a test before fixing it. For example, "pdf.js: margin question
numbers vs. dot-leader answer space" builds a fake page with a question number, a diagram
label and a block of dotted answer lines, the exact layout that made Further Pure Maths lose
questions. The groups:

```
filename parsing                          edexcel: filenames and paper identity
question paper parsing                    edexcel: Pearson's own download names
mark scheme parsing                       edexcel: question papers / mark schemes
question ↔ mark scheme pairing            edexcel ICT: practical task papers
language-specific mark scheme variants    edexcel: retrieval
pairing repair selection                  edexcel: how a student talks to the assistant
command words                             edexcel: how exam material is shown
retrieval query parsing                   edexcel: exam series countdown
dates                                     markdown keeps money
escaping and markdown                     router: one click, one action
client config                             consistency: optional-question papers
edexcel history: lettered question roots  pdf.js: margin question numbers vs. dot leaders
pearson grade boundaries                  classification: no vocabulary is a loud warning
syllabus: two-column ICT content tables   reembed: gives up on a quota that is out
embedding: --no-embed skips the network
```

## Security test cases

Two throwaway students, "alice" and "bob", are created on the live database, and bob tries
to get at alice's data. They're deleted afterwards.

```
row-level security
  ok    bob cannot read alice's tasks
  ok    bob cannot read alice's marked answers
  ok    bob cannot read alice's task by its exact id
  ok    bob cannot read other profiles
  ok    bob cannot update alice's task
  ok    bob cannot delete alice's task
  ok    bob cannot insert a row owned by alice
corpus access
  ok    any signed-in user can read the corpus
  ok    a signed-in user cannot write to the corpus
  ok    a signed-in user cannot add subjects
quota integrity
  ok    a signed-in user cannot call claim_ai_call directly
  ok    a signed-in user cannot forge usage rows
  ok    bob cannot read alice's usage
anonymous access
  ok    a signed-out visitor reads no tasks
  ok    a signed-out visitor reads no corpus
```

## Browser test cases

Run against the production site. The app has since moved to https://markwise-sl.vercel.app/;
the raw log in [data/test-runs](data/test-runs/browser-production.txt) still shows the address
it had on the day, `markwise-tau.vercel.app`. To rerun against the current address:
`MARKWISE_TEST_ORIGIN=https://markwise-sl.vercel.app npm run test:browser`.

```
ok  sign in                              ok  library: browse the corpus
ok  onboarding: pick subjects            ok  recall: a card, revealed and graded
ok  planner: add a task                  ok  calendar: month grid and week strip
ok  planner: tick, untick, tuition tab   ok  papers: reachable from settings; adding is admin-only
ok  planner: multiple tasks and colours  ok  planner: spines and equal card heights
ok  mock: answers survive reloading      ok  progress
ok  mock: current paper reopens offline  ok  progress: per-subject grade history
ok  assistant: composer at the bottom    ok  settings
ok  assistant: answers a question        ok  mobile: chat composer stays on screen
ok  assistant: long history is paged     ok  responsive workspace: fonts, themes, widths
ok  mock: subject is the only input      ok  sign out: saved offline work is removed
ok  mark a paper: three steps, a history
```

## Assistant checks

| Question | Subject | Result |
|---|---|---|
| Can you please explain electrolysis to me? | Chemistry | pass |
| What do I need to know about electrolysis for my 2026 exam? | Chemistry | pass |
| Explain how enzymes work | Biology | pass |
| How do I find the nth term of an arithmetic sequence? | Maths A | pass |
| Explain the difference between series and parallel circuits | Physics | **fail**: correct and grounded, but no inline citations |
| Why does that happen? (follow-up) | Chemistry | pass |
| Explain E-4CH1_s24_qp_1C Q99 (doesn't exist) | Chemistry | pass: refused rather than invented |

## Not run for this submission

`npm run test:functions`, `test:upload` and `rag:proof` each spend a lot of the shared free
Gemini quota, which we needed for the marking evaluation. Run them once the quota resets.
