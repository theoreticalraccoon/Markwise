# Database migrations

All twelve migrations are applied on the live project (checked 2026-09-23), and
`supabase/tests/schema_contract.sql` passes there. **Don't rerun `markwise.sql` or
`finish.sql` on it.**

## An existing project

Use `supabase db push`; it only applies what's missing from the history. To check the schema,
run `supabase/tests/schema_contract.sql` in the SQL Editor. It's read-only and returns a PASS
row. ("Private" in the SQL Editor only controls who sees the saved query.)

Two errors come from replaying old files after their replacements:

- `20260914000000_markwise.sql` defines the old ten-argument `match_chunks`. The Edexcel
  migration replaced it with a twelve-argument version, so replaying creates an overload and a
  grant by name becomes ambiguous.
- `20260921000000_finish.sql` defines `subject_papers(text)` without `paper_ref` and `tier`.
  Postgres can't swap the newer return type back for the old one.

Don't drop the current functions to make old files run; the app needs the new definitions.
"Success. No rows returned" is normal for schema statements.

## A new, empty project

Link it and run `supabase db push`. By hand in the SQL Editor, run each file once in this order:

| # | File | What it does |
|---|---|---|
| 1 | `20260707000000_init.sql` | tasks, profiles, RLS (the original homework tracker) |
| 2 | `20260914000000_markwise.sql` | corpus tables, pgvector, retrieval, study record |
| 3 | `20260914000100_seed_subjects.sql` | first subject catalogue (Cambridge codes) |
| 4 | `20260914000200_ai_usage.sql` | per-student daily AI budget |
| 5 | `20260914000300_map_legacy_subjects.sql` | subject names to codes, `corpus_code` |
| 6 | `20260915000000_upload_routes.sql` | caps for the two upload routes |
| 7 | `20260921000000_finish.sql` | saved marked papers, refunds, spaced revision, recall, readiness |
| 8 | `20260922000000_edexcel.sql` | the switch to Edexcel: paper references, tiers, January, 9-1 grades, admin-only ingest, security fixes |
| 9 | `20260922000100_question_order.sql` | a proper sort key for question numbers |
| 10 | `20260922000200_grade_boundaries_paper_ref.sql` | boundaries keyed by paper reference |
| 11 | `20260923000000_merge_further_pure_maths.sql` | merges a duplicate Further Pure Maths course |
| 12 | `20260923000100_lettered_question_order.sql` | sort key for lettered roots like A1, B8 |

Then run `supabase/tests/schema_contract.sql`. Don't mix manual runs with `db push` without
reconciling the history. The schema alone doesn't deploy the edge functions or load papers.
