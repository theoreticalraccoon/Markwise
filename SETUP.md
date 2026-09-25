# Setting up Markwise

Four steps. After the first two you have a working planner and calendar. Step 3 adds the AI
features, and step 4 loads the past papers they answer from.

---

## 1. Database

```bash
supabase login
supabase link --project-ref YOUR-PROJECT-REF
supabase db push
```

That applies every file in `supabase/migrations/` in order. If you'd rather use the SQL
Editor, run them oldest first; [docs/MIGRATIONS.md](docs/MIGRATIONS.md) lists the order and
explains two errors you'll hit if you replay old files on a database that already has the new
ones. To check a database afterwards, run `supabase/tests/schema_contract.sql`: it's read-only
and returns a PASS row.

If you get `extension "vector" is not available`, enable it under Database, Extensions,
`vector`, and push again.

**Admins.** Adding papers to the shared library is limited to admins, because it changes what
every student is marked against. Make yourself one after signing up:

```sql
insert into public.admins (user_id)
select id from auth.users where email = 'you@example.com';
```

**Auth settings.** Turning Confirm email off (Authentication, Sign In / Providers, Email) makes
sign-up instant. For password-reset links on a hosted copy, set the Site URL and a Redirect URL
under Authentication, URL Configuration.

---

## 2. Frontend

There's nothing to build for local use. Serve the folder over http (the service worker needs
http or https):

```bash
npx serve .          # or: python -m http.server 8000
```

To point it at your own project, edit `SUPABASE_URL` and `SUPABASE_KEY` in
`src/js/config.js`, or set `window.MARKWISE_CONFIG = { url, key }` in a `config.local.js`
(already gitignored). The publishable key is safe to ship: RLS protects every table.

**Vercel.** `vercel.json` runs `npm run build`, which copies only the browser files into
`dist/`. Nothing from `ingest/`, `supabase/` or `.env` is deployed.

---

## 3. AI: edge functions

The Gemini keys live only in Supabase function secrets.

```bash
supabase secrets set GEMINI_API_KEYS="key1,key2"      # free keys from aistudio.google.com/apikey
supabase secrets set ALLOWED_ORIGINS="https://your-app-host"   # optional, defaults to *
supabase functions deploy ask mark mock mark-mock mark-paper ingest
npm run test:functions                                 # proves they work
```

Free-tier limits are per key, so more keys means more throughput. `GEMINI_CHAT_MODEL` and
`GEMINI_EMBED_MODEL` override the default models; the chat setting is a comma-separated
fallback chain.

**Daily limits** per student are in the `ai_limits` table (`ask` 60, `mark` 40, `mock` 8,
`markmock` 12, `markpaper` 10, `ingest` 25). Change them with an `update`, no redeploy needed.
A call that fails inside Gemini is refunded. Recall never calls a model, so it keeps working
after the allowance runs out.

---

## 4. The corpus

Without papers, the AI screens say plainly that they have nothing to answer from.

**In the app:** an admin can drop PDFs into Settings, Your papers. Each file's cover page is
read to work out what it is. Good for a few papers.

**With the CLI:** the way to load whole subjects.

```bash
cd ingest
npm install
cp .env.example .env     # SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEYS
```

The service-role key bypasses RLS, so it stays in `ingest/.env` and nowhere else.

```bash
node fetch-pearson.mjs --subjects 4PH1 --years 2021-2025 --dry   # see what Pearson has
node fetch-pearson.mjs --subjects 4PH1 --years 2021-2025         # download it
node ingest.js syllabus --file ./pdfs/4PH1/E-4PH1_y17_sy.pdf     # specification first
node ingest.js papers --dir ./pdfs/4PH1 --subject E-4PH1
node ingest.js classify --subject E-4PH1
node ingest.js reembed --subject E-4PH1
node ingest.js status
```

The downloader only uses Pearson's own site, waits between requests, skips anything behind a
teacher login or inside the 12-month embargo, and never re-downloads a file already on disk.
Grade boundaries come from Pearson's combined "Notional component grade boundaries" PDF, one
per series: `node ingest.js boundaries --file <pdf> --year 2024 --session Jun`.

The free Gemini quota runs out fast when embedding thousands of questions. If you already know
it's gone, load with `papers --no-embed` and run `reembed` on another day; it stops by itself
after two passes that embed nothing. Classification is a separate command for the same reason.

A healthy run prints lines like:

```
  E-4PH1_s24_qp_1P: 51 parts · 51 with mark scheme (exact 51, fuzzy 0, root 0)
```

Naming, folder layout and what the warnings mean are in [docs/PAPERS.md](docs/PAPERS.md).

---

## When something's wrong

| Symptom | Likely cause |
|---|---|
| The assistant keeps saying the sources don't cover it | Most chunks have no embedding yet, so only keyword search is working. Run `node ingest.js reembed` |
| "Daily limit reached" | The allowance is spent. Raise it in `ai_limits` or wait for midnight UTC |
| Marking says "no mark scheme" | That question isn't paired. It's still searchable but can't be marked |
| Functions return 401 | Signed out, or deployed with `--no-verify-jwt` |
| Functions return 500 mentioning Gemini | `GEMINI_API_KEYS` isn't set as a secret |
| `model ... is not found` | Google retired it. List what your key can use: `curl "https://generativelanguage.googleapis.com/v1beta/models?key=KEY"` |
| "Mock has already been marked" | Expected: a mock is marked (and charged) once |
| The app won't open offline | Service workers don't run on `file://` |

Handy queries:

```sql
select * from public.corpus_coverage;
select count(*) from public.chunks where embedding is null;
select count(*) from public.chunks where kind = 'question' and ms_content is null;
```

---

Past papers, mark schemes, examiner reports and specifications are © Pearson Education
Limited. Only load material you're licensed to use, and keep your deployment private to you or
your school.
