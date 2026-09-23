-- Read-only. Run on the current project, not before installing the migrations.
do $test$
declare
  signatures integer;
  result_shape text;
begin
  select count(*) into signatures from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'match_chunks';
  if signatures <> 1 then
    raise exception 'Expected one current match_chunks overload; found %', signatures;
  end if;
  if to_regprocedure('public.match_chunks(vector,text,text,text[],integer[],text,text,integer,integer,integer,text,text)') is null then
    raise exception 'The Edexcel match_chunks signature is missing';
  end if;
  select pg_get_function_result(to_regprocedure('public.subject_papers(text)')) into result_shape;
  if result_shape is null or result_shape not like '%paper_ref text, tier text%' then
    raise exception 'subject_papers is missing the Edexcel paper reference and tier';
  end if;
  if exists (select 1 from public.subjects where active and board = 'Cambridge') then
    raise exception 'Legacy Cambridge subjects must not be active';
  end if;
  if not exists (select 1 from public.subjects where code = 'E-4PM1' and active) then
    raise exception 'Canonical Further Pure Mathematics must be active';
  end if;
  if exists (select 1 from public.subjects where code = 'X-FPM' and active) then
    raise exception 'Legacy Further Pure Maths alias must not be active';
  end if;
  if exists (select 1 from public.profiles where subjects @> array['X-FPM']::text[]) then
    raise exception 'A profile still selects the legacy Further Pure Maths alias';
  end if;
  if exists (
    select 1 from public.profiles
    where prefs->>'lastSubject' = 'X-FPM' or prefs->>'lastCorpus' = 'X-FPM'
  ) then raise exception 'Profile preferences still remember the legacy Further Pure Maths alias'; end if;
  if exists (select 1 from public.tasks where subject = 'X-FPM')
     or exists (select 1 from public.tuition_sessions where subject = 'X-FPM')
     or exists (select 1 from public.mocks where subject_code = 'X-FPM')
     or exists (select 1 from public.chat_threads where subject_code = 'X-FPM')
     or exists (select 1 from public.attempts where subject_code = 'X-FPM')
     or exists (select 1 from public.paper_attempts where subject_code = 'X-FPM')
     or exists (select 1 from public.recall_reviews where subject_code = 'X-FPM')
     or exists (select 1 from public.topic_mastery where subject_code = 'X-FPM') then
    raise exception 'A user-owned row still uses the legacy Further Pure Maths alias';
  end if;
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in
      ('tasks','profiles','attempts','mocks','paper_attempts','recall_reviews','chat_threads','chat_messages')
      and not c.relrowsecurity
  ) then raise exception 'A user table is missing row-level security'; end if;
  if public.question_sort_key('A2(a)') >= public.question_sort_key('A10(a)')
     or public.question_sort_key('A10(a)') >= public.question_sort_key('B1(a)') then
    raise exception 'question_sort_key does not order lettered History questions';
  end if;
end
$test$;

select 'PASS: current Edexcel function signatures and RLS' as schema_contract;
