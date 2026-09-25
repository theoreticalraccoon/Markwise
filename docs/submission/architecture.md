# System architecture

![Markwise block diagram](architecture.png)

([architecture.svg](architecture.svg) is the same diagram as a scalable image.)

## Hardware

There isn't any. Markwise runs in a web browser on whatever phone or laptop a student already
has, so there are no sensors, circuits or wiring to show. The only "input device" is the
phone camera, used when a student photographs a handwritten paper for marking.

## The parts

**Browser app** (`src/`). Plain JavaScript modules with no build step, served as static files
from Vercel. It talks to two things: the database directly (for the planner, progress and
library) and the edge functions (for anything that needs AI). It installs as an app on a phone
home screen, and the planner works offline.

**Database** (Supabase Postgres, `supabase/migrations/`). Two kinds of data live here:

- each student's own records (tasks, attempts, mastery, mock exams, flashcard reviews), each
  protected by row-level security so a student can only ever read their own rows;
- the shared corpus (`papers`, `chunks`), where each chunk is one question part with its mark
  scheme and examiner report attached, plus a 768-number embedding and a full-text index.

Search (`match_chunks`) runs both a vector search and a keyword search and merges the two
rankings with reciprocal rank fusion.

**Edge functions** (`supabase/functions/`, Deno). Six small server programs, the only code
that holds the Gemini API keys:

| Function | Does |
|---|---|
| `ask` | Answers a question from retrieved sources, streamed, with citations |
| `mark` | Marks one answer against its real mark scheme |
| `mock` | Builds a mock paper from real questions, copied word for word |
| `mark-mock` | Marks a whole mock in a few batched requests |
| `mark-paper` | Reads photos of a handwritten paper, finds the questions, marks them |
| `ingest` | Lets an admin add a paper from the browser |

Each one checks the student's daily AI allowance first and refunds it if the model call fails.

**Google Gemini.** Chat models (with a fallback chain when one is busy) for answering and
marking, and `gemini-embedding-001` for embeddings.

**Ingestion pipeline** (`ingest/`, Node, run on a laptop). Builds the corpus offline:

1. `fetch-pearson.mjs` downloads question papers, mark schemes, examiner reports and
   specifications from Pearson's own website only.
2. `lib/pdf.js` pulls the text out of each PDF with its position on the page.
3. `lib/parse.js` splits it into question parts and marks, then checks the result against the
   paper's own printed totals. If they don't add up, Gemini re-reads the paper.
4. `lib/pair.js` attaches each mark-scheme row and examiner comment to its question part, and
   leaves it unattached if the match is ambiguous.
5. `lib/classify.js` tags each question with a topic from that subject's specification.
6. Everything is embedded and written to the database.

## How one question flows through

A student types "how do I find the nth term of an arithmetic sequence?" in Maths A:

1. The browser sends it to `ask` with the student's sign-in token.
2. `ask` checks the allowance, then `search()` looks for an exact paper reference (none here),
   embeds the question and calls `match_chunks`, limited to Maths A.
3. The top question parts, mark schemes and specification sections go to Gemini with strict
   instructions: answer only from these sources and cite each claim.
4. The answer streams back with numbered citations. Clicking one opens the real question and
   its mark scheme.

If the sources don't cover the question, the assistant says so instead of guessing.
