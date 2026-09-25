# Dataset and model performance

Markwise doesn't train a model. It uses Google's Gemini models as they are and controls what
they see: every answer, mark and mock is built from a dataset of real exam material that we
collected, parsed and checked ourselves. So the evidence here is in two parts: how good the
dataset is, and how well the system performs on it.

## The dataset

**Source.** Question papers, mark schemes, examiner reports and specifications for all 19
Pearson Edexcel International GCSE subjects that Pearson publishes publicly, June 2021 to June
2025. Everything came from `qualifications.pearson.com`, downloaded by our own script at one
request every couple of seconds. We skipped anything behind the teacher login or inside
Pearson's 12-month embargo. About 1,000 PDFs in total.

**Unit.** One record ("chunk") per question part, such as 4PH1 June 2025 Paper 1PR Q8(a). Each
holds the question text, its marks, the matching mark-scheme text, the examiner's comment on
how candidates did, a topic from the specification, and an embedding.

A real record ([data/sample-records.json](data/sample-records.json)):

```json
{
  "paper_code": "E-4PH1_s25_qp_1PR",
  "question_no": "8(a)",
  "marks": 1,
  "command_word": "give",
  "topic": "Astrophysics",
  "content": "This is a question about the Solar System.\nGive the name of the galaxy the Solar System is in.",
  "ms_content": "Milky Way; 1",
  "er_content": "Question 8(a)\nAlmost all candidates could name the Milky Way as the home galaxy..."
}
```

**Size and coverage** (full table: [data/corpus-stats.md](data/corpus-stats.md)):

| | Count |
|---|---:|
| Subjects | 19 |
| Question papers | 352 |
| Question parts | 11,522 |
| With a mark scheme attached | 11,344 (98.5%) |
| With an examiner report attached | 8,716 (75.6%) |
| Tagged with a specification topic | 9,632 (83.6%) |
| With an embedding | 1,044 (9.1%) |
| Specification sections | 1,239 |
| Grade boundary rows | 216 (June 2021 to 2025) |

The largest subjects are Mathematics A (1,614 parts) and Science (Double Award) (1,360); the
smallest are English Language A (92) and English Language B (99), whose papers have few, long
questions.

## Parser accuracy

Before any AI is involved, the parser has to read each PDF correctly. We check it against the
totals the paper prints about itself: every question present, each question's parts adding up
to its printed total, and the paper adding up to its printed total.

**335 of 352 question papers (95.2%) parse completely** with the deterministic parser alone
([data/parser-audit.txt](data/parser-audit.txt)). 15 subjects are at 100%. The rest:

| Subject | Complete |
|---|---|
| Further Pure Mathematics | 12 of 18 |
| Mathematics B | 14 of 18 |
| Accounting | 16 of 18 |
| Mathematics A | 32 of 36 |
| Economics | 17 of 18 |

These are mostly dense maths layouts where one question's marks run into the next. At load
time a paper that fails the check is re-read by Gemini, so the stored corpus is more complete
than these numbers. They measure the parser on its own.

## Retrieval accuracy

Tested with [ingest/tools/eval-retrieval.mjs](../../ingest/tools/eval-retrieval.mjs) on 114
question parts: 6 from each subject, picked at even intervals rather than by hand
([data/eval-retrieval.json](data/eval-retrieval.json)). This run used keyword search only (no
embeddings), which is the worst case: it's what a student gets when the embedding quota is out.

| Test | Result |
|---|---|
| Asking for a question by reference ("4PH1 June 2024 Paper 1P Q3(b)") returns exactly that question first | **112 of 114 (98.2%)** |
| Pasting the first 160 characters of a question brings it back first | 78 of 114 (68.4%) |
| ... brings it back in the top 5 | **100 of 114 (87.7%)** |

The two reference misses are both History questions with lettered numbers (like A1(b)), which
the reference parser doesn't recognise yet. Pasted-text search was weakest for History (1 of 6
in the top 5) and Accounting (3 of 6), where many questions open with the same source
passages or account layouts.

## Marking calibration

Tested with [ingest/tools/eval-marking.mjs](../../ingest/tools/eval-marking.mjs) on 8 real
questions worth 3 to 5 marks, one each from Physics, Chemistry, Biology, Maths A, Economics,
Geography, Business and Computer Science ([data/eval-marking.json](data/eval-marking.json)).
Each question was marked three times: with a full model answer, with only the first half of
that answer, and with a blank answer.

| Answer | Mean score |
|---|---|
| Full model answer | 100% (8 of 8 got full marks) |
| First half of it | 41.9% |
| Blank | 0% (8 of 8 got zero) |

All 8 questions were ordered correctly (full > half > blank). Per question:

| Question | Marks | Full | Half | Blank |
|---|---:|---:|---:|---:|
| 4PH1 s24 1PR Q11(b) | 4 | 4 | 1 | 0 |
| 4CH1 s25 1C Q9(c) | 5 | 5 | 3 | 0 |
| 4BI1 s22 1B Q2(b)(ii) | 3 | 3 | 2 | 0 |
| 4MA1 s25 2F Q23 | 4 | 4 | 1 | 0 |
| 4EC1 s22 01R Q1(h) | 3 | 3 | 2 | 0 |
| 4GE1 s24 01R Q3(d) | 3 | 3 | 1 | 0 |
| 4BS1 s21 02 Q2(c) | 3 | 3 | 1 | 0 |
| 4CP0 s22 02 Q1(g) | 4 | 4 | 1 | 0 |

Our first version of this test pasted the mark scheme itself in as the answer, expecting full
marks. It scored 12.5% ([data/eval-marking-pasted-scheme.json](data/eval-marking-pasted-scheme.json)).
Looking at why, the marker was right: a mark scheme is a list of marking notes ("M1 for
...", "accept ..."), not an answer, and the marker is told to credit what a student shows,
not to match wording. We kept that run as evidence and switched to the model answer.

**What this does and doesn't show.** It shows the marker responds sensibly to answer quality
and never gives marks for nothing. It doesn't show agreement with a human examiner, and the
"full" answers were written by the same model family that marks them. A proper test would have
teachers mark real student answers blind and compare; we haven't done that yet.

## Live assistant checks

`npm run test:assistant` asks the live assistant seven questions that previously went wrong
([data/test-runs/assistant-live.txt](data/test-runs/assistant-live.txt)). Six passed:
electrolysis (twice, including "for my 2026 exam"), enzymes, the nth term, a follow-up ("Why
does that happen?") that needed the earlier topic, and a made-up question number (Q99) that
it correctly refused to answer. One failed: the series and parallel circuits answer was
correct and grounded but left out its inline citations.

## Known weaknesses

- Only 9.1% of question parts are embedded, because Gemini's free tier embeds a few hundred a
  day. Search still works through keywords, but a question in a student's own words matches
  less well until the backlog clears.
- 45 question parts in Physics and Double Science have the paper's equation booklet stuck onto
  the last question.
- Topic tagging is incomplete for History (45.8%), Double Science (3.6%) and English
  Language B (0%).
- 178 question parts have no mark scheme and can't be marked.
