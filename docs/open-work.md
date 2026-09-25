# Open work

What's known to be unfinished or imperfect, as of 25 September 2026. Numbers come from
`node ingest/tools/corpus-report.mjs` and the evaluations in
[submission/data-and-model.md](submission/data-and-model.md).

## Corpus

- **Embeddings.** Only 1,044 of 11,522 question parts (9.1%) have an embedding; the free
  Gemini quota runs out after a few hundred a day. The rest are still found by exact reference
  and keyword search, but questions phrased in a student's own words match less well. Run
  `node ingest.js reembed` daily, or add keys.
- **Topics.** 83.6% of questions are tagged overall, but History is at 45.8%, Science (Double
  Award) 3.6% and English Language B 0%. Run `node ingest.js classify`.
- **Unpaired questions.** 178 parts have no mark scheme. `npm run corpus:repair-pairings --
  --dry` proposes 89 exact repairs; they need checking against the PDFs before writing.
- **Glued booklet text.** 45 question parts in Physics and Science (Double Award) have the
  paper's equation booklet or insert appended to the last question. Needs a parser rule to
  stop at the booklet, then a re-ingest of those papers.
- **Maths symbols.** Some mark schemes contain ☒ where a maths glyph didn't extract (visible
  in Recall).
- **Parser completeness.** The regex pass alone reads 335 of 352 papers completely; the rest
  rely on the model re-read at load time. Weakest: Further Pure Maths 12/18, Maths B 14/18,
  Accounting 16/18, Maths A 32/36, Economics 17/18.

## App

- **Deploy the two fixes from the review.** The refund fix in `mark-mock` and `mark-paper`
  needs `supabase functions deploy mark-mock mark-paper`. (The tier fix for grade prediction
  is already live in the data.)
- **Lettered question references.** "History Paper 1 Question A1(b)" isn't recognised as an
  exact reference, so it falls back to similarity search (2 of 114 misses in the retrieval
  evaluation).
- **Citations.** In one of seven live assistant checks, a correct, grounded answer left out
  its inline citations.
- **Admin upload.** The refusal path is tested; a successful live upload by an admin isn't.
- **Hosting.** The app is live at https://markwise-sl.vercel.app/. Make sure the Supabase Auth
  Site URL and redirect list use that address, so password-reset links land on it, and link the
  GitHub repository so Vercel deploys automatically.

## Architecture

The September 25 architecture review proposed six deepenings. The strongest: one module that owns what a paper reference means (tier, series letter, label),
which today is worked out in five places; one marking module shared by the three marking
routes; and one wrapper that owns the claim-then-refund allowance rule for all six edge
functions.
