-- ============================================================================
-- Markwise: a real sort order for questions.
--
-- question_no is text, so ORDER BY question_no puts 10 before 2 and (b) before
-- (a) once numbering has letters, and a page of library results was assembled
-- in that order. It also had no tiebreaker, so paging across papers could show
-- a row twice and skip another.
--
-- q_sort is the same key question_siblings sorts by, stored so PostgREST can
-- order on it. Safe to run more than once.
-- ============================================================================

alter table public.chunks
  add column if not exists q_sort text
  generated always as (public.question_sort_key(question_no)) stored;

create index if not exists chunks_library_order_idx
  on public.chunks (subject_code, kind, year desc, session desc, paper_ref, q_sort, id);
