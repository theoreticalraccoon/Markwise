-- A real sort key for questions. As text, "10" sorted before "2". q_sort is the
-- key question_siblings uses, stored so PostgREST can order on it. Idempotent.

alter table public.chunks
  add column if not exists q_sort text
  generated always as (public.question_sort_key(question_no)) stored;

create index if not exists chunks_library_order_idx
  on public.chunks (subject_code, kind, year desc, session desc, paper_ref, q_sort, id);
