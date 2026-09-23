# Supabase Migration Instructions

The linked project was checked on 2026-09-23. All twelve migrations below are
already recorded as applied. `supabase/tests/schema_contract.sql` passes on
the live database. **Do not rerun markwise.sql or finish.sql on this project.**

## Existing Project

No existing migration needs running again. For future changes use
`supabase db push`: it applies only migrations missing from the history.
To check the current schema in the SQL Editor, run
`supabase/tests/schema_contract.sql`. It is read-only and returns a PASS row.

The SQL Editor's Private section controls visibility of the saved query. It
does not mean the SQL runs in a different database or a private schema.

The two reported errors are caused by running historical definitions after
their replacements:

- `20260914000000_markwise.sql` defines the old ten-argument `match_chunks`.
  The Edexcel migration replaces it with a twelve-argument version. Replaying
  the old migration can produce an overload, making a grant by name ambiguous.
- `20260921000000_finish.sql` defines `subject_papers(text)` without
  `paper_ref` and `tier`. The Edexcel version returns those extra columns.
  PostgreSQL cannot replace that newer return type with the old shape.

Do not drop the current functions to make the old files pass. The application
requires their newer definitions. The live inspection found exactly one
`match_chunks` (12 arguments) and the correct `subject_papers(text)` columns.

"Success. No rows returned" is normal for CREATE, ALTER, GRANT and other
schema statements; they do not return result rows like SELECT does.

## New Empty Project

Use `supabase db push` after linking the new project. If installing manually
through SQL Editor, run every file once, in this exact order:

1. `20260707000000_init.sql`
2. `20260914000000_markwise.sql`
3. `20260914000100_seed_subjects.sql`
4. `20260914000200_ai_usage.sql`
5. `20260914000300_map_legacy_subjects.sql`
6. `20260915000000_upload_routes.sql`
7. `20260921000000_finish.sql`
8. `20260922000000_edexcel.sql`
9. `20260922000100_question_order.sql`
10. `20260922000200_grade_boundaries_paper_ref.sql`
11. `20260923000000_merge_further_pure_maths.sql`
12. `20260923000100_lettered_question_order.sql`

Then run `supabase/tests/schema_contract.sql`. Manual SQL execution does not
populate the CLI migration history; do not mix both methods without reconciling
that history. Installing the schema does not deploy the six edge functions or
load the corpus.
