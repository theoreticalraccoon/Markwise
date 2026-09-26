# How Markwise was built

This is the development record: what we built at each stage, what went wrong, and what we
changed because of it. Dates come from the git history. Screenshots of each stage are in
[submission/screenshots/stages](submission/screenshots/stages).

## The problem we started from

Students revising for IGCSEs increasingly paste their answers into general chatbots and ask
"how many marks would this get?". The chatbot has never seen the mark scheme. It makes up mark
allocations, drifts outside the syllabus and invents examiner advice, and it sounds equally
sure either way. We wanted the opposite: an assistant that can only answer from the real
papers, and that shows you which paper and question every answer came from.

We also wanted it inside the tool students already open every day, a homework planner, so
revision sits next to the work that's actually due.

## Stage 1: a homework tracker (16 July 2026)

`be48ba5`. One `index.html` and a Supabase database with two tables, `tasks` and `profiles`,
both behind row-level security. Students picked their subjects, added homework and assessments
per subject, and ticked them off. No AI yet.

## Stage 2: the first Markwise (15 September)

`57ac32d`, 59 files. We added everything the AI needs on top of the tracker:

- a corpus schema (`papers`, `chunks`) with pgvector and a hybrid search function that fuses
  vector and keyword ranks;
- five edge functions for asking, marking, mocks, marking photographed papers and uploading
  papers, holding the Gemini key server-side;
- a Node pipeline that turns past-paper PDFs into question parts paired with their marking
  points;
- a per-student daily AI allowance.

At this point it was built around Cambridge IGCSE, because that's what we assumed the corpus
would be.

## Stage 3: cutting it down to what a student does (15 September)

The first version had a dozen screens. We rebuilt the interface around four actions (plan,
ask, sit a mock, mark a paper) in `0cd6eda`, then made the subject the only thing a student
picks: the app works out which paper they're holding from its cover (`8208c3a`). Same day: the
planner's coloured spines were fixed, and the new SVG logo went in.

## Stage 4: an honest audit

Before adding anything else we read the whole codebase at `60df177` and wrote down what it
actually did, not what the README claimed. That audit found:

- finished backend features nobody could reach: the library, the calendar, similar questions,
  the tuition timetable, the technique mode in the assistant;
- nine bugs, including a "typing" bubble that never stopped after a failed marking, mock
  marking that spent one AI allowance per question (so a student could run out halfway through
  their own paper), and marked papers that vanished on refresh;
- the allowance being charged for calls that failed.

We fixed all of it in one pass: saved marked papers, quota refunds, one-request mock marking,
spaced revision, Recall flashcards, the Library, the Calendar and a readiness view.

## Stage 5: switching to Edexcel (22 September)

This was the turning point. We're Edexcel students, and the first real Edexcel papers broke
assumptions baked in everywhere:

- **Paper identity.** Edexcel's 1H and 1F are different papers sat on the same day. The
  Cambridge-shaped code collapsed both to "paper 1", so they overwrote each other.
- **Duplicates.** Edexcel has no "variant", which left a NULL in the database's uniqueness
  key. Postgres treats NULLs as different, so every re-load duplicated the paper and mark
  schemes never found their question papers.
- **Series and grades.** January exams were rejected outright, and grading was A*-G instead
  of 9-1 by tier.
- **Subjects.** A student who picked "Physics" was routed to a Cambridge corpus that didn't
  exist.

We decided to rebuild around Pearson Edexcel International GCSE rather than patch around it,
and to take papers **only from Pearson's own website**: no third-party mirrors, nothing behind
the teacher login, nothing from the 12-month embargo. A new migration reshaped the schema
(paper references, tiers, January, 9-1 grading, an Edexcel catalogue), and we wrote a
downloader that uses Pearson's own public catalogue search.

Loading real papers exposed parser bugs that every unit test had missed, which is why we built
audit tools that check each parse against the paper's own printed totals:

- Superscripts and fraction parts were becoming their own lines and burying question numbers.
  Only one of our first four Maths A papers came out complete; the others added up to 85, 82
  and 97 marks out of 100.
- On pages that were mostly blank answer lines under a diagram, the dotted lines threw off the
  "where does the text start" estimate, so the question number wasn't recognised. Fixing it
  took Further Pure Maths from 128 questions to 476.
- Model re-reads were capped below what a dense paper needs and threw the whole paper away
  when they ran out.
- One rate-limit error during a re-read dropped an entire paper instead of keeping the
  regex parse.
- When the embedding quota ran out for the day, the re-embed loop retried the same rows
  forever. It hung for over three hours before we added a give-up rule.

Grade boundaries turned out to be one combined PDF per series for every subject, so we wrote a
parser for that. By the end of the day 11 subjects were loaded.

## Stage 6: fixing the assistant and finishing the corpus (23 September)

Students testing the assistant found it refusing questions it had good sources for. We
reproduced it first, then fixed the causes: an exam year in the question ("for my 2026 exam")
was being treated as the year of the source paper; follow-up questions lost their topic; and
the prompt demanded complete coverage before answering. We added seven live checks
(`npm run test:assistant`) to keep it fixed.

The same day we loaded the remaining subjects (all 19 active Edexcel subjects now have papers),
added parsing for ICT's practical tasks and Computer Science's three language editions of one
paper, tightened the pairing code so it refuses ambiguous matches, merged a duplicate Further
Pure Maths course, redesigned Recall as a flashcard deck and the whole interface around a new
type system, and deployed the browser app to Vercel. The release commit is `268186e`.

## Stage 7: review and evidence (25 September)

A structured architecture review found two real bugs, both now fixed:

- **Tiered grade prediction never matched.** Boundaries were stored with tier "Higher" and
  "Foundation" while papers and every caller used "H" and "F", so Maths A papers got no
  predicted grade. Fixed in code and in the 216 stored rows, with a test that ties the two
  vocabularies together.
- **Charging for nothing.** If none of a student's answered questions had a mark scheme, no
  marking ran but the allowance was still spent. It's now refunded.

We also measured the system properly for the first time (parser completeness, retrieval
accuracy, marking calibration, the live test suites) and wrote it up in
[submission/data-and-model.md](submission/data-and-model.md), streamlined the code comments,
and removed dead code.

## How the tests grew

| When | Offline assertions | What drove it |
|---|---|---|
| First audit (`60df177`) | 70 | parsing, pairing, dates, escaping |
| Edexcel rebuild and corpus load | 204 | Edexcel naming, grade boundaries, dot-leader regression, reembed give-up |
| Assistant hotfix and corpus completion | 235 + 31 Node tests | retrieval, quota, offline mocks, grade history, static build |
| Review | 239 + 31 | tier vocabulary shared by boundaries and papers |
| Start fresh | 239 + 32 | one database transaction covers every student-owned study table; two-user database and public browser smoke tests pass |

## What we'd tell ourselves at the start

- Check parses against something the document says about itself (printed totals, question
  numbering). Every silent parser bug we found was invisible to unit tests and obvious to that.
- Decide the exam board before designing the schema. Paper identity isn't a detail.
- Budget for the free AI quota as a hard constraint. It shaped the retry logic, the batching,
  and why Recall makes no AI calls at all.
- A wrong answer with a citation is worse than "I don't know". Most of our design choices
  follow from that.

## Tools

The frontend is plain JavaScript, the backend is Supabase (Postgres, pgvector, Deno edge
functions) and the AI is Google Gemini. We used AI coding assistants (Claude Code) throughout
for code audits, implementation and testing. The product decisions were ours: switching to
Edexcel, taking papers only from Pearson's own site, and refusing to guess marks.

## Still open

See [open-work.md](open-work.md).
