# Markwise: setup

Four steps. The first two are required; the app runs as a planner and calendar after step 2
and gains its AI features after step 3. Step 4 is the corpus, which is what makes the AI worth
using.

---

## 1. Database

Open **SQL Editor → New query** in Supabase and run every file in `supabase/migrations/`
**in filename order** (or just `supabase db push`):

| # | File | What it adds |
|---|---|---|
| 1 | `20260707000000_init.sql` | `tasks`, `profiles`, row-level security |
| 2 | `20260914000000_markwise.sql` | corpus tables, pgvector, retrieval functions, study record |
| 3 | `20260914000100_seed_subjects.sql` | the IGCSE subject catalogue (Cambridge, at this point) |
| 4 | `20260914000200_ai_usage.sql` | per-user daily AI caps |
| 5 | `20260914000300_map_legacy_subjects.sql` | migrates old subject **names** → syllabus **codes**, adds `corpus_code` |
| 6 | `20260915000000_upload_routes.sql` | caps for the two upload routes |
| 7 | `20260921000000_finish.sql` | kept marked papers, quota refunds, spaced revision, recall, trends, readiness |
| 8 | `20260922000000_edexcel.sql` | **the board switch**: Pearson Edexcel catalogue, `paper_ref`/tier, January series, 9–1 grading, admin-gated ingest, security hardening |
| 9 | `20260922000100_question_order.sql` | natural question ordering for the Library screen |
| 10 | `20260922000200_grade_boundaries_paper_ref.sql` | grade boundaries keyed by `paper_ref` instead of a Cambridge paper number |

File 5 rewrites `tasks.subject` and `profiles.subjects` from `"Physics"` to a syllabus code, so
existing accounts keep their tasks and do not have to re-pick subjects. It prints a notice
saying whether anything was left unmapped. Skip it only on a brand-new project with no data.

File 7 also seeds a revision schedule onto topic mastery rows that predate it, so an account
that has been marking for weeks does not see an empty revision list.

File 8 is the big one: it deactivates the Cambridge/BTEC catalogue (rows stay, FKs are safe,
they just stop being offered), seeds the Edexcel International GCSE subjects, remaps every
existing account's subjects/tasks/attempts onto them, and rewrites `predict_grade`,
`match_chunks` and the ingest security model around Edexcel's shape. It is idempotent, like
the others, but is not a small change: read it before running it against data you care about.

Each is safe to re-run.

> **`extension "vector" is not available`**: enable it under **Database → Extensions →
> `vector`**, then run file 2 again.

Or with the CLI:

```bash
supabase login
supabase link --project-ref YOUR-PROJECT-REF
supabase db push
```

### Make sign-up instant (recommended)

**Authentication → Sign In / Providers → Email** → turn **Confirm email** *off*.
The app works either way; with it on, new users must confirm before their first sign-in.

### Password reset links (only if you host it)

**Authentication → URL Configuration** → set **Site URL** to where you host `index.html`
and add the same URL under **Redirect URLs**.

---

## 2. Frontend

Nothing to build. Serve the folder statically:

```bash
python -m http.server 8000
# or: npx serve .
```

Then open <http://localhost:8000>.

Serve it over http rather than opening the file directly: the service worker that makes the
app open offline is only allowed on `http://` and `https://`. Everything else works from
`file://`.

### Pointing it at your own project

Either edit `SUPABASE_URL` and `SUPABASE_KEY` at the top of
[`src/js/config.js`](src/js/config.js), or leave the file alone and define the global before
the app module loads, which keeps your project out of a tracked file:

```html
<!-- in index.html, above the module script -->
<script>
  window.MARKWISE_CONFIG = {
    url: "https://YOUR-PROJECT.supabase.co",
    key: "sb_publishable_...",
  };
</script>
```

`config.local.js` is already in `.gitignore` if you would rather keep it in its own file and
add one `<script src="config.local.js"></script>` tag.

The publishable key is meant to be public: every table is protected by row-level security, so
on its own it grants nothing.

Deploy by uploading the folder to any static host (GitHub Pages, Netlify, Cloudflare Pages,
Vercel). There is no server component other than the edge functions below.

---

## 3. AI: edge functions

The Gemini key must never be in the browser. It lives as a Supabase function secret.

```bash
# 1. Get a free key (or several) from https://aistudio.google.com/apikey
#    Free-tier limits are PER KEY, so two keys double your throughput.
supabase secrets set GEMINI_API_KEYS="key1,key2"

# Optional. GEMINI_CHAT_MODEL is a FALLBACK CHAIN, tried left to right: free
# tier quota is per model as well as per key, so when one is exhausted the
# request continues on the next instead of failing.
supabase secrets set GEMINI_CHAT_MODEL="gemini-3.5-flash,gemini-3-flash-preview,gemini-3.5-flash-lite"
supabase secrets set GEMINI_EMBED_MODEL="gemini-embedding-001"
supabase secrets set ALLOWED_ORIGINS="https://your-app-host"   # defaults to *

# 2. Deploy. All six.
supabase functions deploy ask
supabase functions deploy mark
supabase functions deploy mock
supabase functions deploy mark-mock
supabase functions deploy mark-paper
supabase functions deploy ingest
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the
platform. You do not set those.

Then prove it works:

```bash
npm run test:functions
```

### Daily limits

Edit the `ai_limits` table to change them; no redeploy needed.

```sql
update public.ai_limits set per_day = 100 where route = 'ask';
```

Defaults: `ask` 60, `mark` 40, `mock` 8, `markmock` 12, `markpaper` 10, `ingest` 25 per user
per day. Students see their remaining allowance in **Settings**.

A call that fails inside Gemini is refunded, so a 502 does not cost a student an answer they
never received. A call the student cancels is not refunded, because the model has usually
already run.

Recall practice costs nothing: it reads questions and mark schemes that are already stored and
never calls a model. It keeps working after the daily budget is spent, which is deliberate.

---

## 4. Corpus

Without this the planner and calendar work fully and the AI screens say plainly that they have
nothing to ground on. Which is the honest behaviour, and better than answering anyway.

### In the app

**Settings → Your papers**, then drop PDFs in. Each file is identified from its cover page,
split into questions or marking points, embedded and stored. Question papers and mark schemes
can be added in either order; a mark scheme that arrives first waits for its paper.

This is the right path for a handful of papers, or for a student adding the one paper they
just sat. It spends `ingest` allowance, one per file.

### With the CLI

This is the right path for a decade of papers.

```bash
cd ingest
npm install
cp .env.example .env
```

Fill in `.env`:

- `SUPABASE_URL`: same project
- `SUPABASE_SERVICE_ROLE_KEY`: **Project Settings → API → service_role**. This bypasses RLS.
  It belongs in this file and nowhere else. Never put it in `src/` or in a function that
  handles user input.
- `GEMINI_API_KEYS`. One or more, comma-separated

See **[docs/PAPERS.md](docs/PAPERS.md)** for file naming, folder layout, what to collect and
how long it takes.

### Getting the PDFs

`fetch-pearson.mjs` downloads straight from `qualifications.pearson.com`, Pearson's own public
past-papers pages — nothing from a third-party mirror. It respects Pearson's 12-month
teacher-only embargo, skips anything gated behind their login, rate-limits itself, and is safe
to stop and resume (a file already on disk is never re-fetched):

```bash
node fetch-pearson.mjs --subjects 4PH1,4CH1 --years 2021-2025 --dry   # see the plan first
node fetch-pearson.mjs --subjects 4PH1,4CH1 --years 2021-2025         # then actually pull them
```

This also fetches each subject's specification once, named `E-<code>_y<NN>_sy.pdf`. A handful
of subjects aren't tagged the way the downloader expects and need their specification found
by hand on Pearson's site and dropped in as that same filename; `node ingest.js syllabus`
will tell you if a subject's spec is missing.

Then, per subject:

```bash
# Syllabus first. Its section names become the topic vocabulary.
node ingest.js syllabus --file ./pdfs/4PH1/E-4PH1_y17_sy.pdf

# Papers. Put question papers, mark schemes and examiner reports in one folder;
# they are grouped by filename.
node ingest.js papers --dir ./pdfs/4PH1 --subject E-4PH1

# Optional
node ingest.js boundaries --file ./pdfs/_boundaries/2024-notional.pdf --year 2024 --session Jun
node ingest.js classify                  # tag topics (run alone if quota ran out)
node ingest.js reembed --subject E-4PH1  # retry chunks that failed to embed
node ingest.js status                    # what is ingested
```

Grade boundaries are one PDF per exam series covering every Pearson subject at once ("Notional
component grade boundaries"), not a per-subject file: search Pearson's site for that phrase,
or the catalogue under `Support > Grade boundaries > International GCSE`.

Classification is the first step to hit a quota ceiling, and it is a separate command for
exactly that reason: running out of requests should cost you the topic labels, not the whole
parse. Re-run `classify` later and it picks up the questions that were left untagged. The same
goes for `reembed`: it gives up after two passes make no progress rather than hammering an
exhausted quota forever, and reports how many chunks are still waiting.

Expect to see something like:

```
  E-4PH1_s24_qp_1P: 51 parts · 51 with mark scheme (exact 51, fuzzy 0, root 0)
```

A low "with mark scheme" count means the mark scheme PDFs are missing from the folder, or
that paper's layout defeated the parser: try again with `INGEST_LLM_PARSE=1` (the default).

For scanned papers add `--ocr` and install the optional renderer:

```bash
npm install canvas
node ingest.js papers --dir ./pdfs --ocr
```

### Naming

Markwise names, in the shape the downloader writes:

```
E-4PH1_s24_qp_1P.pdf    Physics, June 2024, question paper, Paper 1 (Physical)
E-4MA1_s24_ms_1H.pdf    Maths A, June 2024, mark scheme, Paper 1 Higher
E-4PH1_y17_sy.pdf       Physics specification, first taught 2017
```

Session letters: `s` = June, `j` = January, `w` = November.

Pearson's own native filenames (`4PH1_1P_que_20240523.pdf`, `4PH1_1P_rms_20240815.pdf`) are
also understood as-is — the series is read off the embedded date — so files downloaded by hand
from Pearson's site don't need renaming.

---

## Checks

| Symptom | Cause |
|---|---|
| "No ingested subjects" everywhere | No corpus yet: step 4 |
| Ask returns "nothing matched" | Chunks have no embeddings: `node ingest.js reembed` |
| "Daily limit reached" | Expected: raise it in `ai_limits`, or wait for midnight UTC |
| Mark says "no mark scheme" | That question is unpaired. Normal for some papers; the question is still searchable, and it is excluded from mocks and recall |
| Functions return 401 | Signed-out session, or the function was deployed with `--no-verify-jwt` |
| Functions return 500 mentioning Gemini | `GEMINI_API_KEYS` not set as a secret |
| `model … is not found` or `no longer available` | Google retired it. Ask your key what it can use: `curl "https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY"` |
| Everything 429s on one model | That model's daily quota is spent. The chain covers it: add another model or another key |
| Marked papers vanish on refresh | Migration 7 has not been run: results are stored in `paper_attempts` |
| The revision list is always empty | Migration 7 has not been run, or nothing has been marked yet (a topic needs 2 marks of evidence) |
| "Mock has already been marked" | Expected: `mark-mock` refuses to re-mark and charge twice. Generate another |
| Recall shows nothing | That subject has no 1–3 mark questions with a stored mark scheme |
| The app does not open offline | Service workers need `http://` or `https://`; `file://` will not register one |

Useful:

```sql
select * from public.corpus_coverage;
select count(*) from public.chunks where embedding is null;
select count(*) from public.chunks where kind='question' and ms_content is null;
select route, used, per_day from public.my_ai_usage();
```

---

## Copyright

Past papers, mark schemes, examiner reports and specifications are © Pearson Education
Limited. Ingest only material you are licensed to use, and keep your deployment private to
yourself or your school. See [LICENSE](LICENSE).
