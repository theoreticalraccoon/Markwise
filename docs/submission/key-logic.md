# Key logic

The repository has about 80 source files. These are the pieces that make Markwise work.
Everything else is plumbing or screens. Line numbers are as of 25 September 2026.

## 1. Finding the right source: `search()`

[supabase/functions/_shared/retrieve.ts:240](../../supabase/functions/_shared/retrieve.ts#L240)

Every AI feature starts here. If the student names a paper and question ("4PH1 June 2024
Paper 1P Q3(b)"), `exactLookup` ([line 180](../../supabase/functions/_shared/retrieve.ts#L180))
fetches exactly that question part, and nothing else can stand in for it:

```ts
// An explicit reference resolves exactly or is refused; neighbours can't stand in.
const exactReference = filters.questionNo &&
  (filters.paperCode || (filters.years?.length === 1 && filters.session));
if (exactReference) { ... return hits; }
```

Otherwise it embeds the question and runs a hybrid search. If embedding fails (the free quota
is out), it carries on with keyword search rather than failing.

## 2. Hybrid ranking: `match_chunks`

[supabase/migrations/20260922000000_edexcel.sql:230](../../supabase/migrations/20260922000000_edexcel.sql#L230)

The vector search and the keyword search each produce a ranked list. They're merged by rank
(reciprocal rank fusion), not by raw score, because the two scores aren't on the same scale:

```sql
select coalesce(s.id, k.id) as id,
       coalesce(1.0 / (rrf_k + s.rnk), 0.0) +
       coalesce(1.0 / (rrf_k + k.rnk), 0.0) as score
from semantic s
full outer join keyword k on k.id = s.id
```

## 3. Knowing when a parse is wrong: `consistency()`

[ingest/lib/parse.js:792](../../ingest/lib/parse.js#L792)

The regex parser can quietly lose a question. So every parse is checked against what the
paper says about itself: are the question numbers continuous, does each question's parts add
up to its printed "(Total for Question 7 = 6 marks)", and does everything add up to the
paper's printed total? If any check fails, `looksParsed` returns false and
[ingest.js:225](../../ingest/ingest.js#L225) has Gemini re-read the paper instead.

Papers that offer a choice ("Answer TWO questions") legitimately print more marks than their
total, so `offersChoice` ([line 736](../../ingest/lib/parse.js#L736)) skips just that one check.

## 4. The margin fix: finding question numbers

[ingest/lib/pdf.js:142](../../ingest/lib/pdf.js#L142)

A question number is a small integer left of where body text starts. On pages full of blank
dotted answer lines, those lines started at the number's own margin and dragged the estimate
onto it, so whole questions vanished. Leaving dot leaders out of the estimate took Further
Pure Maths from 128 questions to 476:

```js
return text.replace(/[.\s]/g, "").length > 4; // not just a dot leader
```

## 5. Pairing questions with mark schemes: `pairQuestions()`

[ingest/lib/pair.js:42](../../ingest/lib/pair.js#L42)

Tries an exact question number first, then allows only a missing sub-part level, then the
whole question for questions with no parts. If two scheme rows claim the same question with
different text, that question is left unpaired: marking 4(b) against the wrong scheme is worse
than not marking it.

## 6. The marking rules: `MARK_SYSTEM`

[supabase/functions/_shared/prompts.ts:84](../../supabase/functions/_shared/prompts.ts#L84)

The model marks against the real scheme with Pearson's own conventions spelled out: M1 method
marks, A1 accuracy marks that depend on them, "ft" only where the scheme says so, "cao",
"isw" and so on. The server then clamps the result so it can never exceed the question's
marks ([mark/index.ts:154](../../supabase/functions/mark/index.ts#L154)):

```ts
const awarded = Math.max(0, Math.min(cap, Number(result.awarded) || 0));
```

## 7. Mocks built from real questions only

[supabase/functions/mock/index.ts:165](../../supabase/functions/mock/index.ts#L165)

The model is only allowed to choose an order for questions the database picked. The paper is
then rebuilt from the database, word for word, and anything the model invented is dropped:

```ts
// Rebuild verbatim in the model's order, ignoring anything it invented or dropped.
const byId = new Map(selected.map((c) => [c.id, c]));
```

## 8. The daily allowance: `claim()` and `release()`

[supabase/functions/_shared/quota.ts:18](../../supabase/functions/_shared/quota.ts#L18)

Each AI call claims one unit of the student's daily allowance before the model runs and
refunds it if the call fails. The claim returns its own row id, so two requests at once can't
refund each other. Since the review, marking a mock or paper where nothing had a mark scheme
is refunded too ([mark-mock/index.ts:158](../../supabase/functions/mark-mock/index.ts#L158)).

## 9. Predicting a grade: `predict_grade`

[supabase/migrations/20260922000000_edexcel.sql:340](../../supabase/migrations/20260922000000_edexcel.sql#L340)

Finds the grade boundaries for the same paper and tier from the most recent series and
returns the highest 9-1 grade whose boundary the score reaches. Boundary tiers are read by
`tierOfBoundaryRef` ([ingest/lib/boundaries.js:41](../../ingest/lib/boundaries.js#L41)),
which now uses the same "F"/"H" letters as papers; before the review they didn't match, and
tiered Maths papers never got a grade.

## 10. Stopping when the quota is gone: `STALL_LIMIT`

[ingest/lib/reembed.js:4](../../ingest/lib/reembed.js#L4)

The embedding sweep gives up after two passes in a row embed nothing. Before this it retried
an exhausted daily quota for over three hours.
