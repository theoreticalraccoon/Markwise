# Loading past papers

The ingestion CLI reads everything it needs from filenames, so correctly named files go in
with one command. PDFs stay on your machine; only extracted text goes to Gemini (for the
occasional re-read, topic labels and embeddings).

Most of the time you won't name anything yourself: `fetch-pearson.mjs` downloads from
Pearson's site and names files the way the CLI expects. This page is the reference for when
you add files by hand.

## Downloading

```bash
cd ingest
node fetch-pearson.mjs --subjects 4PH1,4CH1 --years 2021-2025 --dry   # what Pearson lists
node fetch-pearson.mjs --subjects 4PH1,4CH1 --years 2021-2025
```

It fetches question papers, mark schemes, examiner reports and the specification from
`qualifications.pearson.com` only, one request every couple of seconds, skipping anything
behind a teacher login or less than 12 months old. Stop it whenever you like; files already on
disk aren't fetched again.

For Business, Economics and Geography the downloader couldn't match a specification, so we
found those by hand on Pearson's site. `node ingest.js syllabus` tells you when a subject has
none.

## Naming

```
E-<code>_<series><yy>_<kind>_<paper>.pdf
```

| Part | Meaning | Examples |
|---|---|---|
| code | Pearson's subject code with an `E-` prefix | `E-4PH1`, `E-4MA1` |
| series | `s` June, `j` January, `w` November | `s24`, `j23` |
| kind | `qp` question paper, `ms` mark scheme, `er` examiner report, `sy` specification | |
| paper | the reference printed on the cover | `1P`, `1H`, `2FR`, `01` |

```
E-4PH1_s24_qp_1P.pdf   Physics, June 2024, Paper 1P question paper
E-4PH1_s24_ms_1P.pdf   its mark scheme (needed for marking)
E-4PH1_s24_er_1P.pdf   its examiner report (optional)
E-4PH1_y17_sy.pdf      Physics specification, first taught 2017 (load this first)
E-4MA1_s24_qp_1F.pdf   Maths A Paper 1 Foundation, which is a different paper from 1H
```

Pearson's own download names work unchanged: `4PH1_1P_que_20240523.pdf` (question paper),
`..._rms_...` (mark scheme), `..._pef_...` (examiner report). The date in the name is the exam
day for a question paper, but the publication day for a scheme or report (August for a May
paper), and the parser accounts for that.

One folder per subject (`ingest/pdfs/4PH1/`) is simplest. A question paper and its mark scheme
must be loaded in the same run to pair; if you add a scheme later, re-run the paper with
`--force`.

## What to collect first

1. **The specification.** Its headings become the topic list every question is tagged with,
   which drives weak topics and targeted mocks.
2. **Question papers with their mark schemes.** A question without a scheme can be searched
   but never marked.
3. **Examiner reports.** Optional, and the source of "most candidates lost marks here by...".
4. **Grade boundaries.** One combined PDF per series for every subject:
   `node ingest.js boundaries --file <pdf> --year 2024 --session Jun`.

Start with one subject and two series (about 8 files) to check the parser on your PDFs. Our
full load of 19 subjects over five years was about 1,000 files and took most of a day, mainly
waiting on the free Gemini quota.

## Running it

```bash
node ingest.js syllabus --file ./pdfs/4PH1/E-4PH1_y17_sy.pdf
node ingest.js papers --dir ./pdfs/4PH1 --subject E-4PH1
node ingest.js classify --subject E-4PH1
node ingest.js reembed --subject E-4PH1
node ingest.js status
```

A healthy run looks like:

```
18 paper group(s) to process.
  E-4PH1_s24_qp_1P: 51 parts · 51 with mark scheme (exact 51, fuzzy 0, root 0)
Done.
  papers ingested : 18 (0 unchanged, skipped)
  question chunks : 725
  with mark scheme: 717
  flagged         : 0 paper(s) that do not add up: re-check these
```

"With mark scheme" is the number to watch: above about 85% is fine, below 50% means something's
wrong. "Flagged" counts papers whose marks still don't add up to the printed total after the
model's re-read; open those by hand.

To check parsing without touching the database, run the audits: `node tools/audit-pdfs.mjs
pdfs/4PH1` (questions found and marks against the printed total) and `node tools/audit-ms.mjs
pdfs/4PH1` (pairing rate per paper).

## Messages you might see

| Message | Meaning |
|---|---|
| `N file(s) had unrecognisable names` | Rename them to the pattern above |
| `no question paper, only a mark scheme` | The `_qp` file is missing or misnamed |
| `parse does not add up ...: retrying with the model` | Normal for some layouts |
| `no questions extracted` | A scan with no text layer: `npm install canvas`, then `--ocr` |
| `embedding batch failed` | Hit the per-minute limit; `reembed` later |
| `no progress after 2 passes` | The daily embedding quota is gone. Load with `--no-embed`, `reembed` tomorrow |
| `NO TOPIC VOCABULARY for ...` | That subject's specification isn't loaded yet |

A paper that offers a choice ("Answer TWO questions from Section A") prints more questions than
its total, so the marks-total check is skipped for it. If a new subject flags lots of papers,
check whether its rubric wording needs adding to `OFFERS_CHOICE` in `lib/parse.js` before
assuming the parser is broken.

## Other boards

The live catalogue is Edexcel only. The parsers still read Cambridge names (`0625_s19_qp_42.pdf`,
marks in `[3]`), and Cambridge rows are kept in the database but switched off. Courses without
their own specification ("Extra Maths", "Single Science Physics") borrow a subject's papers
through `subjects.corpus_code`, so nothing extra is loaded for them.

---

Past papers, mark schemes, examiner reports and specifications are © Pearson Education
Limited. Only load material you're licensed to use and keep the deployment private.
