# How to give Markwise the past papers

Everything the pipeline needs is carried in the **filename**. Get the names right and one
command ingests a whole subject. Get them wrong and files are skipped with a warning.

You do not send the papers to me. You put them in a folder on your machine and run the
ingestion CLI against it. The PDFs never leave your computer except as extracted text sent
to Gemini for parsing, classification and embedding.

Markwise is built around **Pearson Edexcel International GCSE**. `fetch-pearson.mjs` gets you
the files directly, named the way the CLI expects, so most of the time you never touch naming
at all — read [SETUP.md](../SETUP.md) for that. This document is the reference for the naming
scheme itself, for organising a folder by hand, and for the Cambridge/other-board files an
older or borrowed corpus may still carry.

---

## Getting the files

```bash
cd ingest
node fetch-pearson.mjs --subjects 4PH1,4CH1 --years 2021-2025 --dry   # see the plan first
node fetch-pearson.mjs --subjects 4PH1,4CH1 --years 2021-2025
```

Pulls question papers, mark schemes, examiner reports and the specification straight from
`qualifications.pearson.com` — Pearson's own public past-papers pages, nothing from a
third-party mirror — at a polite rate, skipping anything gated behind their teacher login or
still inside their 12-month embargo. It writes files already named the way the CLI expects, and
is safe to stop and re-run: a file already on disk is never re-fetched.

A handful of subjects' specifications aren't tagged the way the downloader looks for and need
finding by hand on Pearson's site; `node ingest.js syllabus` says plainly when a subject has no
spec ingested yet.

---

## The naming pattern

```
E-<code>_<session><yy>_<kind>_<paper-ref>.pdf
```

| Part | Meaning | Examples |
|---|---|---|
| `code` | Pearson's subject code, `E-` prefixed | `E-4PH1` Physics, `E-4MA1` Maths A |
| `session` | **`s`** = June · **`j`** = January · **`w`** = November | `s24`, `j23` |
| `yy` | two-digit year | `24` = 2024 |
| `kind` | `qp` question paper · `ms` mark scheme · `er` examiner report · `sy` specification | |
| `paper-ref` | the paper as Pearson prints it on the cover: paper number + tier/variant letter | `1H`, `2F`, `1PR`, `01` |

Worked examples:

```
E-4PH1_s24_qp_1P.pdf    Physics, June 2024, question paper, Paper 1 (Physical)
E-4PH1_s24_ms_1P.pdf    …its mark scheme                 ← REQUIRED for marking
E-4PH1_s24_er_1P.pdf    …its examiner report              ← optional
E-4PH1_y17_sy.pdf        Physics specification, first taught 2017  ← ingest this FIRST
E-4MA1_s24_qp_1F.pdf    Maths A, June 2024, Paper 1 Foundation
E-4MA1_s24_qp_1H.pdf    …Paper 1 Higher — a different paper, not a variant of the same one
```

**Pearson's own native filenames also work unchanged** — you never have to rename a file you
downloaded by hand from their site:

```
4PH1_1P_que_20240523.pdf   question paper  (que = qp)
4PH1_1P_rms_20240815.pdf   mark scheme     (rms = ms)
4PH1_1P_pef_20240815.pdf   examiner report (pef = er)
```

The series is read off the embedded date (the paper's own sitting date; the mark scheme and
examiner report are published later, so their date is read as a *publication* date and mapped
back to the series it marks).

---

## Folder layout

One folder per subject is simplest — it's what `fetch-pearson.mjs` writes and what
`node ingest.js papers --dir` expects. Nested folders also work; the CLI walks subdirectories.

```
ingest/pdfs/
  4PH1/
    E-4PH1_y17_sy.pdf
    E-4PH1_s24_qp_1P.pdf
    E-4PH1_s24_ms_1P.pdf
    E-4PH1_s24_er_1P.pdf
    E-4PH1_j24_qp_1P.pdf
    ...
```

**The question paper and its mark scheme must be in the same run.** They are matched by
subject + session + year + paper reference. A question paper ingested without its mark scheme
is searchable but can never be marked. Re-running later with the mark scheme present will not
retroactively pair it unless the question paper is re-ingested (`--force`, or delete its rows).

---

## What to collect, in priority order

1. **The specification** for each subject (`_sy`). One file. Highest value per megabyte in the
   whole corpus: its section headings become the topic vocabulary that every question is
   classified against, which is what makes the weakness profile and topic-targeted mocks
   work. **Ingest it before the papers.**
2. **Question paper + mark scheme pairs** (`_qp` and `_ms`). Always together. Without the
   mark scheme, marking is impossible and that is the flagship feature.
3. **Examiner reports** (`_er`). Optional but valuable. They are the source of "most
   candidates lost marks here by…", which no general chatbot has.
4. **Grade boundaries.** Optional, only needed for predicted grades, and not a per-subject
   file: Pearson publishes one combined "Notional component grade boundaries" PDF per series,
   covering every subject at once. `node ingest.js boundaries --file <that pdf>`.

### How much to start with

Do **one subject, two series** first: about 8 files. That proves the parser works on your
actual PDFs before you spend hours collecting. Then scale.

| Scope | Files | Rough ingestion time |
|---|---|---|
| Proof run: 1 subject, 2 series | ~8 | 2–5 min |
| 1 subject, 5 years | ~50–100 | 20–40 min |
| 10 subjects, 5 years | ~500–1,000 | most of a day |

Times assume two or more Gemini keys and quota still available; the embedding step is what
runs out first (see **If it goes wrong**, below). A second free key roughly halves the wall
clock.

### Which papers are worth having

- **Recent years first.** Specifications change; a decade-old question may be off-syllabus
  now. The last 5 years is the sweet spot, and is what `fetch-pearson.mjs --years` defaults to.
- **Both tiers**, for a tiered subject (Foundation and Higher are different papers, not
  variants of one paper — both are useful, and a student may sit either).
- **Reserve/retake papers** (the `R` suffix, e.g. `1PR`) are separate real papers, not
  duplicates: keep them.

---

## Running it

```bash
cd ingest
npm install                 # first time only
cp .env.example .env        # fill in service-role key + Gemini key(s)

# 1. Specification first
node ingest.js syllabus --file ./pdfs/4PH1/E-4PH1_y17_sy.pdf

# 2. Papers
node ingest.js papers --dir ./pdfs/4PH1 --subject E-4PH1

# 3. Optional
node ingest.js boundaries --file ./pdfs/_boundaries/2024-notional.pdf --year 2024 --session Jun
node ingest.js classify        # tags topics; safe to re-run if quota ran out
node ingest.js reembed         # retry chunks that failed to embed
node ingest.js status
```

Drop `--subject` to ingest everything in the folder at once.

### What good output looks like

```
Found 52 PDFs in ./pdfs/4PH1
18 paper group(s) to process.

  E-4PH1_s24_qp_1P: 51 parts · 51 with mark scheme (exact 51, fuzzy 0, root 0)
  E-4PH1_s24_qp_2P: 33 parts · 33 with mark scheme (exact 33, fuzzy 0, root 0)

Done.
  papers ingested : 18 (0 unchanged, skipped)
  question chunks : 725
  with mark scheme: 717
  without         : 8
  flagged         : 0 paper(s) that do not add up: re-check these
```

**The number that matters is "with mark scheme".** Above ~85% means the pipeline is working.
Below ~50% means something is wrong: see below. `flagged` counts papers whose part marks don't
sum to the printed paper total even after the model re-read them — worth opening by hand.

---

## If it goes wrong

| Output | Cause | Fix |
|---|---|---|
| `N file(s) had unrecognisable names` | Filenames don't match either naming scheme | Rename them, or accept best-effort parsing |
| `no question paper, only a mark scheme` | The `_qp` file is missing or misnamed | Add it |
| `parse does not add up ...: retrying with the model` | Normal on some papers. Not an error | |
| `no questions extracted` | Scanned PDF with no text layer | `npm install canvas`, re-run with `--ocr` |
| Very low "with mark scheme" | Mark scheme PDFs missing, or its layout defeated the parser | Check both files are present; ensure `INGEST_LLM_PARSE=1` |
| `flagged: N paper(s) that do not add up` | Part marks don't sum to the printed total even after the model's re-read | Open that paper by hand; a genuine layout it can't handle |
| `embedding batch failed` | Gemini's per-minute rate limit | Harmless, usually self-clears: `node ingest.js reembed` afterwards |
| `no progress after 2 passes (quota likely exhausted for now)` | The *daily* embedding quota is spent, not just the per-minute limit | Ingest with `--no-embed` to skip straight past it, and run `reembed` again later once quota resets |
| `NO TOPIC VOCABULARY for ...: every question below is going in untagged` | The specification hasn't been ingested for that subject yet | Ingest the syllabus first, then re-run `classify` |

Send me the console output of a run and I can tell you which of these it is, and tune
[`ingest/lib/parse.js`](../ingest/lib/parse.js) against the specific layout if needed.

---

## Other boards and school subjects

Courses with no specification of their own: Extra Maths, Single Science, Further Pure
Maths: are set up to **borrow another subject's corpus** via `subjects.corpus_code`. Ingest
the main subject and students on the borrowing course get its questions; nothing is ingested
separately for them.

Cambridge, AQA and OCR are still supported by the parsers, prefixed the same way Edexcel is:
`E-` Edexcel, `A-` AQA, `O-` OCR, bare digits for Cambridge, `X-` a school course. The live
catalogue is Edexcel-only (the Cambridge/BTEC rows were deactivated, not deleted, when the app
moved boards), but a deactivated code still round-trips correctly if you ever re-enable one:

```
0625_s19_qp_42.pdf      Cambridge Physics, May/June 2019, paper 4 variant 2
```

Both layouts are read deterministically: Cambridge marks a part `[3]`; Edexcel prints `(3)` on
its own line and closes with `(Total for Question 1 is 3 marks)`. Where a layout still defeats
the parser, the model re-reads that paper alone rather than the whole run.

---

## Copyright

Past papers, mark schemes, examiner reports and specifications are © Pearson Education
Limited (or © the relevant board, for a non-Edexcel corpus). Ingest only material you are
licensed to use, and keep the deployment private to yourself or your school. Do not publish a
Markwise instance containing this content.
