# Markwise

**The IGCSE assistant that has actually read the papers.**

Markwise does two things. It tracks your homework, assignments, tuition and deadlines.
And it answers, marks and quizzes you **from the real Pearson Edexcel International GCSE past
papers, mark schemes, examiner reports and specifications**. Not from a language model's
recollection of them.

That distinction is the whole project. Ask ChatGPT or Gemini to mark a 6-mark Biology answer
and it will produce a confident breakdown assembled from Reddit, Quora and revision forums.
It has never seen the mark scheme. It invents mark allocations, hallucinates syllabus scope,
and makes up "examiner tips". Markwise retrieves the actual question and the actual marking
points first, and every answer carries the paper code and question number so you can check it.

---

## What it does

**Planner** `#/planner`
- Homework, assessments and revision across school, tuition and your own study
- Due dates and times, priorities, time estimates, notes and topics
- One card per subject, with a coloured spine so a glance shows where the pressure is
- A **Due for revision** list the app works out for you, spaced from the marks you actually lost

**Calendar** `#/calendar`
- Month grid shaded by **workload**, measured in minutes rather than task count
- This week in detail, including the recurring tuition timetable
- Exam-series countdown

**Assistant** `#/assistant`
- One box. What you type decides what happens
- A question is answered from real documents, with citations you can open and read
- A question reference plus your written answer is **marked point by point against the real
  mark scheme**, and the scheme is printed underneath so you can audit the marking
- "How do I get full marks on this?" switches to answer-technique mode automatically
- Weak topics appear as one-tap suggestions

**Mock exams** `#/mock`
- A paper assembled from real past questions, weighted towards what you keep losing marks on
- Sat under a timer, answers saved locally as you type
- Marked in one budgeted request against every question's own scheme
- Per-topic breakdown and a predicted grade from published thresholds

**Mark a paper** `#/markpaper`
- Photograph or scan what you wrote; Markwise reads the cover to work out which paper it is
- Every question marked against its real scheme, and the result **kept**, not thrown away
- Printable, and listed in Progress

**Recall** `#/recall`
- Short real questions with their real mark schemes, self-rated, on a spacing schedule
- Costs no AI allowance at all, so it still works when the daily budget is spent
- Self-ratings are kept away from topic mastery on purpose: "I knew that" is not a mark

**Library** `#/library`
- The corpus itself: search, filter by topic or paper, read any question and its scheme
- "More like this" via pgvector neighbours, free of charge
- The screen that makes the app's central claim checkable

**Progress** `#/progress`
- Built **only** from marks awarded against real mark schemes
- Topic mastery, weak-topic ranking, a weekly trend line, and a three-part readiness figure
- Every marked paper and every marked answer, openable

**Your papers** `#/papers` (from Settings)
- Drag past papers and mark schemes in. The server reads each one, splits it into questions
  and pairs them with their marking points. No filename convention, no CLI, no subject code

---

## Architecture

```
Browser (static, no build step)
  │  ES modules · Supabase JS from CDN · service worker for the shell
  │
  ├─────────► Supabase Postgres ── RLS on every user table
  │             • tasks, profiles, tuition_sessions
  │             • attempts, mocks, paper_attempts, chat_*, topic_mastery,
  │               recall_reviews
  │             • papers, chunks (pgvector), grade_boundaries   ← the corpus
  │             • match_chunks()  hybrid vector + full-text retrieval, RRF-fused
  │
  └─────────► Supabase Edge Functions (Deno) ──► Gemini API
                • ask        streamed, grounded chat (SSE)
                • mark       one answer, against the retrieved scheme
                • mock       paper assembly from real questions
                • mark-mock  a whole sat mock, batched, one allowance
                • mark-paper photos of handwriting → identified, read, marked
                • ingest     one PDF → questions + paired mark scheme → embedded
                The Gemini key lives here and only here.

Offline:  ingest/  Node CLI  ──►  PDFs → question parts → paired mark schemes
                                  → classified → embedded → Postgres
```

### Why these choices

| Decision | Reason |
|---|---|
| **No build step** | The frontend is plain ES modules and two stylesheets. It deploys to any static host, opens from disk, and has no toolchain to rot. |
| **Supabase Postgres + pgvector** | One free service gives auth, relational data, row-level security *and* the vector index. A separate vector DB would add a second system with its own auth story for no benefit at this scale. |
| **Hybrid retrieval, RRF-fused** | Pure vector search cannot find `4PH1 1P June 2024 Q4(b)`; pure keyword search cannot find "why does the parachute slow down" → terminal velocity. RRF fuses both ranks without needing to normalise cosine distance against `ts_rank`. |
| **HNSW, not IVFFlat** | The corpus grows continuously during ingestion. IVFFlat needs retraining as rows land; HNSW does not. |
| **Mark scheme denormalised onto the question row** | One retrieval hit answers both "what was asked" and "what earns the marks". A second lookup per hit would double latency on the hottest path. |
| **Edge functions for all AI** | The Gemini key never reaches the browser, and per-user daily quotas are enforced server-side where they cannot be bypassed. |
| **Quota claimed before the call, refunded on failure** | A user out of allowance must cost the project nothing, so the reservation happens first. A 502 from Gemini then hands the reservation back, because charging a student for an answer they never received is indefensible. |
| **A whole mock marked in one request** | One allowance per paper, not one per question. The old loop spent twelve of a forty-a-day cap on one paper and could run out halfway down a student's own script. |
| **The model never writes mock questions** | It returns an *ordering of ids*; the server reconstitutes each question verbatim from the database. A model that can rewrite a question can rewrite it wrong. |
| **Recall is kept out of topic mastery** | Mastery is the claim that every number shown came from marks awarded against a real scheme. A self-rating is not a mark, so it lives in its own table. |
| **Verbatim everything** | Parsers copy; they never paraphrase. A paraphrased mark scheme cannot be marked against. |

---

## Setup

Full instructions: **[SETUP.md](SETUP.md)**, and **[docs/PAPERS.md](docs/PAPERS.md)** for how to
name and organise PDFs for bulk ingestion. In short:

1. **Database**: run the files in `supabase/migrations/` in the Supabase SQL editor, in
   filename order (or `supabase db push`).
2. **Edge functions**: `supabase functions deploy ask mark mock mark-mock mark-paper ingest`,
   then set `GEMINI_API_KEYS` as a function secret.
3. **Frontend**: point `SUPABASE_URL` / `SUPABASE_KEY` in `src/js/config.js` at your project
   (or set `window.MARKWISE_CONFIG`) and serve `index.html` from any static host.
4. **Corpus**: add papers in the app under **Settings → Your papers**, or run the CLI below
   for bulk ingestion. Without a corpus the planner, calendar and recall-free parts work and
   the AI screens say honestly that they have nothing to ground on.

---

## Ingestion. The hard part

The app is only as good as its corpus, and building that corpus is the real engineering
problem. Pearson Edexcel International GCSE alone is ~40 subjects × up to 3 sessions a year ×
multiple papers and tiers × a decade: tens of thousands of PDFs and hundreds of thousands of
question parts.

There are two paths in, and they exist for different users:

- **In the app** (`Settings → Your papers`). Drop a PDF in; Gemini reads the cover page to
  identify it, extracts the questions or the marking points, and the result is embedded and
  stored. Mark schemes and question papers can arrive in either order. Slower and not free,
  but it needs nothing from the student except the file.
- **The CLI** (`ingest/`). Deterministic parsers over pdf.js text coordinates, resumable by
  file hash, batched embeddings, key rotation. This is how you load a decade of papers.

```bash
cd ingest
npm install
cp .env.example .env        # service-role key + one or more Gemini keys

# Download straight from Pearson's own past-papers pages (qp/ms/er + the
# specification), respecting their 12-month teacher-only embargo.
node fetch-pearson.mjs --subjects 4PH1,4CH1 --years 2021-2025

# Syllabus first: its section headings become the topic vocabulary that every
# question in that subject is classified against.
node ingest.js syllabus --file ./pdfs/4PH1/E-4PH1_y17_sy.pdf

# Then the papers. Question papers, mark schemes and examiner reports for the
# same paper are grouped automatically by filename.
node ingest.js papers --dir ./pdfs/4PH1 --subject E-4PH1

# Optional extras
node ingest.js boundaries --file ./pdfs/_boundaries/2024-notional.pdf --year 2024 --session Jun
node ingest.js classify                    # tag topics (separate: it hits quota first)
node ingest.js reembed                     # retry any chunk that failed to embed
node ingest.js status                      # coverage report
```

Name files the way Pearson does: `E-4PH1_s24_qp_1P.pdf` (`s`/`j`/`w` = Jun/Jan/Nov series,
`1P` = paper + tier/variant), or drop in Pearson's own native names
(`4PH1_1P_que_20240523.pdf`) unchanged. Subject, session, year, paper and tier are all parsed
from the filename. See **[docs/PAPERS.md](docs/PAPERS.md)**.

Grade boundaries come from Pearson's own combined "Notional component grade boundaries" PDF
(one per series, every subject at once) — `node ingest.js boundaries --file <that pdf>`.

### What makes it difficult

- **Layout.** Exam PDFs put mark allocations in a right-hand column and mark schemes in tables.
  Naive text extraction scrambles both. `lib/pdf.js` reconstructs visual lines from pdf.js text
  item coordinates before any parsing happens.
- **Question ↔ mark scheme alignment.** No public dataset gives you this join. `lib/pair.js`
  matches in three passes, strictest first, and leaves anything ambiguous unpaired. A question
  marked against the *wrong* scheme is the worst failure this app can have, far worse than one
  that simply cannot be marked.
- **Scans.** Older papers have no text layer. Pages with a thin text layer are detected and can
  be OCR'd through Gemini's vision model (`--ocr`, needs the optional `canvas` package).
- **Topic consistency.** "Forces" and "Forces and motion" as separate topics would shatter the
  mastery table into noise, so classification is constrained to the syllabus's own section
  names and every label is snapped back onto that vocabulary.
- **Model churn.** Google retires models and meters quota per model as well as per key, so
  both Gemini clients take a fallback chain and walk it on 429/503 instead of failing.
- **Free-tier quota.** Embedding is the expensive half. Keys rotate round-robin, 429s park a key
  for a minute rather than failing the run, embeddings batch 96 at a time, and runs are
  resumable by file hash: re-running after a crash costs almost nothing.

Set `INGEST_LLM_PARSE=0` to run the deterministic parsers only: free, faster, and adequate for
well-laid-out modern papers.

### Copyright

Past papers, mark schemes, examiner reports and specifications are © Pearson Education
Limited. `fetch-pearson.mjs` pulls only from `qualifications.pearson.com`, Pearson's own public
past-papers pages, at a polite rate and never fetches anything gated behind their teacher login
or still inside their 12-month embargo. Ingest only material you are licensed to use, and keep a
Markwise deployment private to yourself or your school. See [LICENSE](LICENSE).

---

## Layout

```
index.html                     app shell
manifest.webmanifest  sw.js    installable, and opens offline (network-first)
src/css/app.css                layout, components, print, light + dark
src/css/chat.css               the assistant, uploads and marked papers
src/js/
  app.js                       bootstrap, auth gate, keyboard, service worker
  router.js                    hash router, navigation token
  store.js                     observable app state
  theme.js
  config.js                    Supabase pointing, task vocabularies
  api/  client.js              Supabase client, SSE transport
        data.js                every table read/write
        ai.js                  the six AI routes
  ui/   dom.js  feedback.js    escaping, markdown, modals, toasts
  lib/  dates.js               dates, and the exam-series parser
        exam.js  routing.js    paper/mark labels; "is this a mark request?"
  views/ planner calendar assistant library recall mock markpaper
         papers progress settings auth
supabase/
  migrations/                  schema, seed, AI caps, the Edexcel rebuild
  functions/
    _shared/  gemini.ts retrieve.ts prompts.ts db.ts quota.ts http.ts files.ts
    ask/ mark/ mock/ mark-mock/ mark-paper/ ingest/
ingest/
  ingest.js                    CLI
  fetch-pearson.mjs            downloader: Pearson's own past-papers pages only
  lib/  pdf parse pair classify syllabus boundaries filename pearson gemini db config
```

---

## Tests

```bash
npm install   # esbuild, for the one block that compiles a TS module
npm test      # 204 assertions, no database or network
npm run check # every browser module and edge function parses, no control characters
```

[`test/logic.test.mjs`](test/logic.test.mjs) covers the places where a silent bug is
expensive: Edexcel filename and paper-identity parsing (including Pearson's own native names),
question segmentation, the question-to-mark-scheme pairing rules, retrieval query parsing,
dates, the exam-series parser behind the countdown, and HTML escaping.

The rest need a real deployment and real keys, so they are manual:

```bash
npm run test:functions   # hits the DEPLOYED edge functions as a throwaway user
npm run test:browser     # drives the real UI in headless Chromium, every route
npm run test:security    # RLS: proves one user cannot read another's rows
npm run test:upload      # the two upload routes, end to end
npm run rag:proof        # retrieval quality against a real corpus
```

Run `test:functions` after every deploy. Unit tests cannot catch a missing secret, a model
Google has retired, or a policy that blocks the service.

CI runs `npm test` plus a parse check of every module on every push
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

---

## Keyboard

`P` planner · `C` calendar · `A` assistant · `M` mocks · `K` mark a paper ·
`R` recall · `L` library · `G` progress

In Recall: space reveals the mark scheme, then `1`–`4` rate it.
