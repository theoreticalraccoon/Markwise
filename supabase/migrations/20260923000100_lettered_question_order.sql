-- History papers use question roots such as A1 and B8. Preserve that prefix in
-- the generated sort key so A2 sorts before A10 and the A section sorts before
-- the B section. q_sort is derived data, so rebuilding it is lossless.

create or replace function public.question_sort_key(q text)
returns text
language sql
immutable
as $fn$
  select upper(coalesce((regexp_match(coalesce(q, ''), '^([A-Za-z]?)\d+'))[1], ''))
      || lpad(coalesce((regexp_match(coalesce(q, ''), '^[A-Za-z]?(\d+)'))[1], '0'), 3, '0')
      || coalesce((regexp_match(coalesce(q, ''), '\(([a-h])\)'))[1], '')
      || lpad(
           coalesce(
             array_position(
               array['i','ii','iii','iv','v','vi','vii','viii','ix','x'],
               (regexp_match(coalesce(q, ''), '\(((?:i|v|x)+)\)'))[1]
             ),
             0
           )::text, 2, '0');
$fn$;

drop index if exists public.chunks_library_order_idx;
alter table public.chunks drop column if exists q_sort;
alter table public.chunks
  add column q_sort text
  generated always as (public.question_sort_key(question_no)) stored;

create index chunks_library_order_idx
  on public.chunks (subject_code, kind, year desc, session desc, paper_ref, q_sort, id);
