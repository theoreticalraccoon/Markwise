-- ============================================================================
-- Markwise: rebuilt around Pearson Edexcel International GCSE.
--
-- The schema was written for Cambridge. Edexcel differs in ways that were not
-- cosmetic, and an audit found that Edexcel data could not be stored, paired,
-- displayed or graded correctly:
--
--   1. Identity. A Cambridge paper is "4, variant 2". An Edexcel paper is "1H"
--      or "1PR": the tier or reserve letters ARE the identity, and 1F and 1H
--      are different papers set on the same day. Both used to collapse to
--      "paper 1" and overwrite one another.
--   2. NULLs. Edexcel has no variant, so the old unique key contained a NULL,
--      which Postgres treats as distinct from every other NULL. The key never
--      matched, so re-ingesting inserted a duplicate paper every time and
--      mark schemes never found their question papers.
--   3. Series. Edexcel sits January, May/June and October/November. The
--      session check only allowed Mar, Jun and Nov, so January was rejected.
--   4. Grading. Cambridge A*-G per component became Edexcel 9-1 per tier.
--   5. Catalogue. Every subject was a Cambridge code, so a student who picked
--      "Physics" was routed to a Cambridge corpus that has never existed.
--
-- Also fixed here, because the audit found them in the same files:
--   - corpus functions were executable by anonymous callers;
--   - the daily-allowance counter could be overrun by concurrent requests and
--     a refund could delete a charge that belonged to someone else;
--   - the revision schedule advanced once per marked answer, not once per day;
--   - re-ingesting a paper deleted every student's recall history for it.
--
-- Safe to run more than once. Run AFTER 20260921000000_finish.sql.
-- ============================================================================

create extension if not exists pgcrypto;


-- ---------------------------------------------------------------------------
-- 1. Paper identity
-- ---------------------------------------------------------------------------

alter table public.papers add column if not exists paper_ref    text not null default '';
alter table public.papers add column if not exists tier         text;
alter table public.papers add column if not exists total_marks  integer;
alter table public.papers add column if not exists duration_min integer;

alter table public.chunks add column if not exists paper_ref text not null default '';
alter table public.chunks add column if not exists tier      text;

-- Backfill the reference from what is already stored. Edexcel files ingested
-- before this migration were named "..._13" for paper 1 Higher, so a variant of
-- 3 means H and 1 means F. Everything else keeps its digits.
update public.papers
   set paper_ref = case
         when subject_code like 'E-%' and variant = 3 then paper_no::text || 'H'
         when subject_code like 'E-%' and variant = 1 then paper_no::text || 'F'
         else coalesce(paper_no::text, '') || coalesce(variant::text, '')
       end
 where paper_ref = '';

update public.papers
   set tier = right(paper_ref, 1)
 where tier is null and subject_code like 'E-%' and paper_ref ~ '^[0-9]+[FH]$';

update public.chunks c
   set paper_ref = p.paper_ref,
       tier      = p.tier
  from public.papers p
 where p.id = c.paper_id
   and (c.paper_ref is distinct from p.paper_ref or c.tier is distinct from p.tier);

-- Duplicates that the NULL-blind key allowed. Keep the most recently ingested
-- row of each identity; its chunks go with the others via ON DELETE CASCADE.
delete from public.papers p
 using public.papers keeper
 where p.subject_code = keeper.subject_code
   and p.kind = keeper.kind
   and p.year    is not distinct from keeper.year
   and p.session is not distinct from keeper.session
   and p.paper_ref = keeper.paper_ref
   and p.id <> keeper.id
   and (p.ingested_at, p.id) < (keeper.ingested_at, keeper.id);

-- Replace the old key with one that treats NULLs as equal.
do $key$
declare
  old_name text;
begin
  for old_name in
    select conname from pg_constraint
     where conrelid = 'public.papers'::regclass and contype = 'u'
       and conname <> 'papers_identity_key'
  loop
    execute format('alter table public.papers drop constraint %I', old_name);
  end loop;

  if not exists (select 1 from pg_constraint where conname = 'papers_identity_key') then
    begin
      execute 'alter table public.papers add constraint papers_identity_key
               unique nulls not distinct (subject_code, kind, year, session, paper_ref)';
    exception when syntax_error or feature_not_supported then
      -- Postgres older than 15: an expression index does the same job.
      execute 'create unique index if not exists papers_identity_key
               on public.papers (subject_code, kind, coalesce(year, 0), coalesce(session, ''''), paper_ref)';
    end;
  end if;
end
$key$;

-- Edexcel sits January. Cambridge's Feb/March is kept so nothing already stored
-- is invalidated.
alter table public.papers drop constraint if exists papers_session_check;
alter table public.papers add  constraint papers_session_check
  check (session is null or session in ('Jan', 'Mar', 'Jun', 'Nov'));

-- Chunks are upserted on (paper, kind, question number) so a re-ingest keeps
-- their ids. Remove exact duplicates first, then enforce it.
delete from public.chunks a
 using public.chunks b
 where a.paper_id = b.paper_id
   and a.kind = b.kind
   and a.question_no is not null
   and a.question_no = b.question_no
   and a.id > b.id;

create unique index if not exists chunks_paper_kind_qno_key
  on public.chunks (paper_id, kind, question_no);

create index if not exists chunks_paper_ref_idx on public.chunks (subject_code, paper_ref);


-- ---------------------------------------------------------------------------
-- 2. Ordering: 2 before 10, and (a) before (b) before (i) before (ii)
-- ---------------------------------------------------------------------------

create or replace function public.question_sort_key(q text)
returns text
language sql
immutable
as $fn$
  select lpad(coalesce((regexp_match(coalesce(q, ''), '^\*?(\d+)'))[1], '0'), 3, '0')
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

create or replace function public.session_order(s text)
returns integer
language sql
immutable
as $fn$
  select case s when 'Jan' then 1 when 'Mar' then 2 when 'Jun' then 3 when 'Nov' then 4 else 0 end;
$fn$;

-- Siblings in reading order. This was ordered by the raw text, so 10(a) came
-- before 2(a) and the stem context handed to the marker was jumbled.
create or replace function public.question_siblings(p_chunk_id uuid)
returns setof public.chunk_result
language sql stable security definer set search_path = public as $fn$
  select sib.id, sib.subject_code, sib.kind, sib.paper_code, sib.year, sib.session,
         sib.paper_no, sib.variant, sib.question_no, sib.question_root, sib.marks,
         sib.command_word, sib.topic, sib.syllabus_refs, sib.content, sib.ms_content,
         sib.er_content, sib.page
  from public.chunks me
  join public.chunks sib
    on sib.paper_id = me.paper_id
   and sib.question_root is not distinct from me.question_root
  where me.id = p_chunk_id
  order by public.question_sort_key(sib.question_no);
$fn$;


-- ---------------------------------------------------------------------------
-- 3. Retrieval that can name a paper
--
-- match_chunks could filter by year and a paper-code substring but not by the
-- series or the paper reference, so "June 2024 Paper 1P" returned every series
-- of 2024. Both are now real filters.
-- ---------------------------------------------------------------------------

drop function if exists public.match_chunks(
  vector, text, text, text[], int[], text, text, int, int, int
);

create or replace function public.match_chunks(
  query_embedding vector(768),
  query_text      text    default '',
  p_subject       text    default null,
  p_kinds         text[]  default null,
  p_years         int[]   default null,
  p_paper_code    text    default null,
  p_topic         text    default null,
  match_count     int     default 8,
  pool            int     default 60,
  rrf_k           int     default 60,
  p_session       text    default null,
  p_paper_ref     text    default null
)
returns table (
  id            uuid,
  subject_code  text,
  kind          text,
  paper_code    text,
  year          integer,
  session       text,
  paper_no      integer,
  variant       integer,
  question_no   text,
  marks         integer,
  command_word  text,
  topic         text,
  syllabus_refs text[],
  content       text,
  ms_content    text,
  er_content    text,
  page          integer,
  score         double precision
)
language sql
stable
security definer
set search_path = public
as $fn$
  with filtered as (
    select c.*
    from public.chunks c
    where (p_subject    is null or c.subject_code = p_subject)
      and (p_kinds      is null or c.kind = any(p_kinds))
      and (p_years      is null or c.year = any(p_years))
      and (p_paper_code is null or c.paper_code ilike '%' || p_paper_code || '%')
      and (p_topic      is null or c.topic = p_topic)
      and (p_session    is null or c.session = p_session)
      and (p_paper_ref  is null or upper(c.paper_ref) = upper(p_paper_ref))
  ),
  semantic as (
    select f.id, row_number() over (order by f.embedding <=> query_embedding) as rnk
    from filtered f
    where query_embedding is not null and f.embedding is not null
    order by f.embedding <=> query_embedding
    limit pool
  ),
  keyword as (
    select k.id, row_number() over (order by k.r desc) as rnk
    from (
      select f.id, ts_rank_cd(f.fts, websearch_to_tsquery('english', query_text)) as r
      from filtered f
      where coalesce(query_text, '') <> ''
        and f.fts @@ websearch_to_tsquery('english', query_text)
      order by r desc
      limit pool
    ) k
  ),
  fused as (
    select coalesce(s.id, k.id) as id,
           coalesce(1.0 / (rrf_k + s.rnk), 0.0) +
           coalesce(1.0 / (rrf_k + k.rnk), 0.0) as score
    from semantic s
    full outer join keyword k on k.id = s.id
  )
  select c.id, c.subject_code, c.kind, c.paper_code, c.year, c.session,
         c.paper_no, c.variant, c.question_no, c.marks, c.command_word,
         c.topic, c.syllabus_refs, c.content, c.ms_content, c.er_content,
         c.page, f.score
  from fused f
  join public.chunks c on c.id = f.id
  order by f.score desc
  limit match_count;
$fn$;


-- ---------------------------------------------------------------------------
-- 4. Mock and library helpers that respect tier, paper and diagrams
-- ---------------------------------------------------------------------------

drop function if exists public.sample_questions(text, text[], int, int, int, uuid[]);

create or replace function public.sample_questions(
  p_subject   text,
  p_topics    text[] default null,
  p_limit     int    default 12,
  p_min_marks int    default 1,
  p_max_marks int    default 99,
  p_exclude   uuid[] default null,
  p_tier      text   default null,
  p_paper_ref text   default null,
  p_no_figure boolean default true
)
returns setof public.chunk_result
language sql stable security definer set search_path = public as $fn$
  select c.id, c.subject_code, c.kind, c.paper_code, c.year, c.session,
         c.paper_no, c.variant, c.question_no, c.question_root, c.marks,
         c.command_word, c.topic, c.syllabus_refs, c.content, c.ms_content,
         c.er_content, c.page
  from public.chunks c
  where c.subject_code = p_subject
    and c.kind = 'question'
    and c.ms_content is not null
    and coalesce(c.marks, 0) between p_min_marks and p_max_marks
    and (p_topics    is null or c.topic = any(p_topics))
    and (p_exclude   is null or not (c.id = any(p_exclude)))
    and (p_tier      is null or c.tier = p_tier)
    and (p_paper_ref is null or upper(c.paper_ref) = upper(p_paper_ref))
    -- A question about "the diagram above" is unanswerable as plain text, and
    -- a mock made of them is a bad mock. Callers can turn this off when a
    -- subject has too little text-only material to build a paper from.
    and (not p_no_figure or c.content !~* '(diagram|figure|fig\.|graph paper|the grid|sketch)')
  order by random()
  limit p_limit;
$fn$;

-- Papers with counts, in reading order, with their reference and tier.
drop function if exists public.subject_papers(text);

create or replace function public.subject_papers(p_subject text)
returns table (
  paper_id uuid, title text, code text, year integer, session text,
  paper_no integer, variant integer, paper_ref text, tier text,
  questions integer, markable integer
)
language sql stable security definer set search_path = public as $fn$
  select p.id, p.title, p.code, p.year, p.session, p.paper_no, p.variant,
         p.paper_ref, p.tier,
         count(c.id) filter (where c.kind = 'question')::integer,
         count(c.id) filter (where c.kind = 'question' and c.ms_content is not null)::integer
  from public.papers p
  left join public.chunks c on c.paper_id = p.id
  where p.subject_code = p_subject and p.kind = 'qp'
  group by p.id
  having count(c.id) filter (where c.kind = 'question') > 0
  order by p.year desc nulls last, public.session_order(p.session) desc, p.paper_ref;
$fn$;


-- ---------------------------------------------------------------------------
-- 5. Grade boundaries: 9-1, per paper reference and tier
-- ---------------------------------------------------------------------------

alter table public.grade_boundaries add column if not exists paper_ref   text not null default '';
alter table public.grade_boundaries add column if not exists tier        text not null default '';
alter table public.grade_boundaries add column if not exists total_marks integer;

do $gb$
declare
  old_name text;
begin
  for old_name in
    select conname from pg_constraint
     where conrelid = 'public.grade_boundaries'::regclass and contype = 'u'
       and conname <> 'grade_boundaries_identity_key'
  loop
    execute format('alter table public.grade_boundaries drop constraint %I', old_name);
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'grade_boundaries_identity_key') then
    alter table public.grade_boundaries
      add constraint grade_boundaries_identity_key
      unique (subject_code, year, session, paper_ref, tier, grade);
  end if;
end
$gb$;

-- The grade a raw score would earn.
--
-- The old function took the highest year's rows across EVERY series, so a June
-- score could be graded against January's boundaries, and returned null
-- whenever max_marks was missing (which for Edexcel it always was). It now
-- takes the latest single series that matches, prefers a boundary for this
-- exact paper over the overall subject one, and compares against the paper's
-- own total. A score below the lowest boundary is a U.
drop function if exists public.predict_grade(text, integer, numeric);

create or replace function public.predict_grade(
  p_subject   text,
  p_paper_ref text,
  p_pct       numeric,
  p_tier      text    default null,
  p_year      integer default null,
  p_session   text    default null
) returns text
language sql stable security definer set search_path = public as $fn$
  with candidates as (
    select gb.*,
           (gb.paper_ref = coalesce(p_paper_ref, '')) as exact_paper
    from public.grade_boundaries gb
    where gb.subject_code = p_subject
      and (gb.paper_ref = coalesce(p_paper_ref, '') or gb.paper_ref = '')
      and (p_tier is null or gb.tier = '' or gb.tier = p_tier)
      and (p_year    is null or gb.year = p_year)
      and (p_session is null or gb.session = p_session)
  ),
  series as (
    select year, session
    from candidates
    order by exact_paper desc, year desc, public.session_order(session) desc
    limit 1
  ),
  scoped as (
    select c.*
    from candidates c, series s
    where c.year = s.year and c.session = s.session
      and c.exact_paper = (select bool_or(exact_paper) from candidates
                            where year = s.year and session = s.session)
  )
  select coalesce(
    (select grade
       from scoped
      where coalesce(total_marks, max_marks, 0) > 0
        and p_pct >= (min_marks::numeric / coalesce(total_marks, max_marks)) * 100
      order by min_marks desc
      limit 1),
    case when exists (select 1 from scoped) then 'U' end
  );
$fn$;


-- ---------------------------------------------------------------------------
-- 6. Catalogue: Edexcel International GCSE
-- ---------------------------------------------------------------------------

-- Edexcel codes, verified against Pearson's specification list. Subjects Pearson
-- does not publish papers for are pruned by the corpus loader, not guessed here.
insert into public.subjects (code, board, name, level) values
  ('E-4MA1', 'Edexcel', 'Mathematics A',                          'International GCSE'),
  ('E-4MB1', 'Edexcel', 'Mathematics B',                          'International GCSE'),
  ('E-4PM1', 'Edexcel', 'Further Pure Mathematics',               'International GCSE'),
  ('E-4PH1', 'Edexcel', 'Physics',                                'International GCSE'),
  ('E-4CH1', 'Edexcel', 'Chemistry',                              'International GCSE'),
  ('E-4BI1', 'Edexcel', 'Biology',                                'International GCSE'),
  ('E-4SD0', 'Edexcel', 'Science (Double Award)',                 'International GCSE'),
  ('E-4HB1', 'Edexcel', 'Human Biology',                          'International GCSE'),
  ('E-4EA1', 'Edexcel', 'English Language A',                     'International GCSE'),
  ('E-4EB1', 'Edexcel', 'English Language B',                     'International GCSE'),
  ('E-4ET1', 'Edexcel', 'English Literature',                     'International GCSE'),
  ('E-4BS1', 'Edexcel', 'Business',                               'International GCSE'),
  ('E-4EC1', 'Edexcel', 'Economics',                              'International GCSE'),
  ('E-4AC1', 'Edexcel', 'Accounting',                             'International GCSE'),
  ('E-4CM1', 'Edexcel', 'Commerce',                               'International GCSE'),
  ('E-4GE1', 'Edexcel', 'Geography',                              'International GCSE'),
  ('E-4HI1', 'Edexcel', 'History',                                'International GCSE'),
  ('E-4IT1', 'Edexcel', 'Information and Communication Technology', 'International GCSE'),
  ('E-4CP0', 'Edexcel', 'Computer Science',                       'International GCSE')
on conflict (code) do update
  set board = excluded.board,
      name  = excluded.name,
      level = excluded.level;

-- Cambridge codes and their Edexcel counterparts. Used to move existing users.
create or replace function public.cambridge_to_edexcel(p_code text)
returns text
language sql
immutable
as $fn$
  select edexcel from (values
    ('0580', 'E-4MA1'), ('0607', 'E-4MA1'), ('0606', 'E-4PM1'),
    ('0625', 'E-4PH1'), ('0620', 'E-4CH1'), ('0610', 'E-4BI1'),
    ('0653', 'E-4SD0'), ('0654', 'E-4SD0'), ('0648', 'E-4HB1'),
    ('0500', 'E-4EA1'), ('0990', 'E-4EA1'), ('0475', 'E-4ET1'),
    ('0450', 'E-4BS1'), ('0455', 'E-4EC1'), ('0452', 'E-4AC1'),
    ('7100', 'E-4CM1'), ('0460', 'E-4GE1'), ('0470', 'E-4HI1'),
    ('0417', 'E-4IT1'), ('0478', 'E-4CP0')
  ) as m(cambridge, edexcel)
  where m.cambridge = p_code;
$fn$;

-- The old name -> code map now lands on Edexcel. A student who wrote "Physics"
-- in the original tracker takes Edexcel Physics.
create or replace function public.legacy_subject_code(p_name text)
returns text
language sql
immutable
as $fn$
  select code from (values
    ('Geography',                 'E-4GE1'),
    ('English Literature',        'E-4ET1'),
    ('English Language',          'E-4EA1'),
    ('Extra English',             'X-XENG'),
    ('Sinhala',                   '0505'),
    ('French',                    '0520'),
    ('Maths',                     'E-4MA1'),
    ('Extra Maths',               'X-XMATH'),
    ('Further Pure Maths',        'X-FPM'),
    ('Physics',                   'E-4PH1'),
    ('Chemistry',                 'E-4CH1'),
    ('Biology',                   'E-4BI1'),
    ('Human Biology',             'E-4HB1'),
    ('Single Science Physics',    'X-SSPHY'),
    ('Single Science Chemistry',  'X-SSCHE'),
    ('Single Science Biology',    'X-SSBIO'),
    ('History',                   'E-4HI1'),
    ('Economics',                 'E-4EC1'),
    ('Business',                  'E-4BS1'),
    ('Accounting',                'E-4AC1'),
    ('Commerce',                  'E-4CM1'),
    ('ICT',                       'E-4IT1'),
    ('Computer Science',          'E-4CP0'),
    ('Psychology',                'X-PSY'),
    ('Art',                       '0400'),
    ('Drama',                     '0411'),
    ('BTEC Sport',                'X-BSPT'),
    ('BTEC Music',                'X-BMUS')
  ) as m(name, code)
  where m.name = p_name;
$fn$;

-- School support courses answer from the Edexcel subject they support.
update public.subjects s
   set corpus_code = m.corpus
  from (values
    ('X-XMATH', 'E-4MA1'),
    ('X-XENG',  'E-4EA1'),
    ('X-FPM',   'E-4PM1'),
    ('X-SSPHY', 'E-4PH1'),
    ('X-SSCHE', 'E-4CH1'),
    ('X-SSBIO', 'E-4BI1')
  ) as m(code, corpus)
 where s.code = m.code
   and s.corpus_code is distinct from m.corpus;

-- Move existing users off Cambridge codes. Every statement is scoped to rows
-- that still hold one, so re-running changes nothing.
update public.tasks t
   set subject = public.cambridge_to_edexcel(t.subject)
 where public.cambridge_to_edexcel(t.subject) is not null;

update public.tuition_sessions s
   set subject = public.cambridge_to_edexcel(s.subject)
 where public.cambridge_to_edexcel(s.subject) is not null;

update public.mocks m
   set subject_code = public.cambridge_to_edexcel(m.subject_code)
 where public.cambridge_to_edexcel(m.subject_code) is not null;

update public.chat_threads c
   set subject_code = public.cambridge_to_edexcel(c.subject_code)
 where public.cambridge_to_edexcel(c.subject_code) is not null;

update public.profiles p
   set subjects = mapped.arr,
       updated_at = now()
  from (
    select p2.id,
           array_agg(distinct coalesce(public.cambridge_to_edexcel(elem), elem)) as arr
      from public.profiles p2
      cross join lateral unnest(p2.subjects) as elem
     where exists (
       select 1 from unnest(p2.subjects) e where public.cambridge_to_edexcel(e) is not null
     )
     group by p2.id
  ) as mapped
 where p.id = mapped.id;

update public.profiles p
   set prefs = jsonb_set(p.prefs, '{lastSubject}', to_jsonb(public.cambridge_to_edexcel(p.prefs->>'lastSubject')))
 where jsonb_exists(p.prefs, 'lastSubject')
   and public.cambridge_to_edexcel(p.prefs->>'lastSubject') is not null;

-- Cambridge rows that now have an Edexcel counterpart go quiet. They are
-- deactivated rather than deleted: deleting cascades through papers and chunks
-- and would orphan any text[] column that still names them.
update public.subjects s
   set active = false
 where s.board = 'Cambridge'
   and public.cambridge_to_edexcel(s.code) is not null;

-- The rest (Sinhala, Art, Drama, French, ...) are courses a student still
-- tracks homework for but which have no Edexcel corpus. They are honestly
-- school courses, not Cambridge ones.
update public.subjects
   set board = 'School'
 where board = 'Cambridge' and active;

update public.subjects
   set active = false
 where board = 'BTEC';

alter table public.profiles alter column board set default 'Edexcel';
update public.profiles set board = 'Edexcel' where board = 'Cambridge';

-- The coverage view reads through corpus_code, so it needs no change; only the
-- subjects it lists have.


-- ---------------------------------------------------------------------------
-- 7. Who may change the corpus
--
-- The ingest edge function let any signed-in user replace any paper's
-- questions and mark schemes, and create subjects that then appeared in
-- everyone's onboarding. It is now restricted to admins.
-- ---------------------------------------------------------------------------

create table if not exists public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admins enable row level security;
-- No policies: nobody can read or write this through the API. Only the
-- service role, which is what the edge function uses, can see it.

create or replace function public.is_admin(p_user uuid)
returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (select 1 from public.admins where user_id = p_user);
$fn$;


-- ---------------------------------------------------------------------------
-- 8. The daily allowance
--
-- claim_ai_call counted then inserted with nothing in between, so concurrent
-- requests both saw "one left" and both ran. And release_ai_call deleted the
-- newest row for the route, which could belong to a different, successful
-- request, or to none at all when the claim itself had failed open.
--
-- A claim now takes an advisory lock per user and route and returns the id of
-- the row it wrote; a release deletes exactly that row.
-- ---------------------------------------------------------------------------

create or replace function public.claim_ai_call_id(p_user uuid, p_route text)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  cap  integer;
  used integer;
  new_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user::text || ':' || p_route, 0));

  select per_day into cap from public.ai_limits where route = p_route;
  if cap is null then cap := 30; end if;

  select count(*) into used
    from public.ai_usage
   where user_id = p_user and route = p_route
     and day = (now() at time zone 'utc')::date;

  if used >= cap then
    return null;                     -- over the cap
  end if;

  insert into public.ai_usage (user_id, route) values (p_user, p_route)
  returning id into new_id;
  return new_id;
end
$fn$;

create or replace function public.release_ai_call_id(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $fn$
  delete from public.ai_usage where id = p_id;
$fn$;

revoke all on function public.claim_ai_call_id(uuid, text) from public, anon, authenticated;
revoke all on function public.release_ai_call_id(uuid)     from public, anon, authenticated;
grant execute on function public.claim_ai_call_id(uuid, text) to service_role;
grant execute on function public.release_ai_call_id(uuid)     to service_role;


-- ---------------------------------------------------------------------------
-- 9. Revision schedule: advance once per day, not once per answer
--
-- A ten-question mock on one topic ran the schedule ten times in a sitting, so
-- one decent mock pushed a topic out by months. The schedule now moves at most
-- once per topic per day; later answers the same day still count towards the
-- marks and the latest percentage.
-- ---------------------------------------------------------------------------

create or replace function public.fold_attempt_into_mastery()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  this_pct   numeric;
  prev       public.topic_mastery%rowtype;
  next_ease  numeric;
  next_int   integer;
  moves      boolean;
begin
  if new.topic is null or new.total = 0 then
    return new;
  end if;

  this_pct := 100.0 * new.awarded / nullif(new.total, 0);

  select * into prev
  from public.topic_mastery
  where user_id = new.user_id and subject_code = new.subject_code and topic = new.topic;

  -- Has the schedule already moved today?
  moves := prev.updated_at is null or prev.updated_at::date < current_date;

  if moves then
    next_ease := coalesce(prev.ease, 2.5)
               + (0.1 - (100 - this_pct) / 100.0 * (0.28 + (100 - this_pct) / 100.0 * 0.12));
    next_ease := greatest(1.3, least(2.8, next_ease));

    if this_pct < 60 then
      next_int := 1;
    elsif coalesce(prev.interval_days, 0) = 0 then
      next_int := 3;
    elsif prev.interval_days <= 3 then
      next_int := 7;
    else
      next_int := least(120, ceil(prev.interval_days * next_ease)::integer);
    end if;
  else
    next_ease := prev.ease;
    next_int  := prev.interval_days;
    -- A bad answer today still pulls the review date in, never out.
    if this_pct < 60 and prev.review_at > current_date + 1 then
      next_int := 1;
    end if;
  end if;

  insert into public.topic_mastery as m
    (user_id, subject_code, topic, attempts, marks_awarded, marks_total,
     review_at, interval_days, ease, last_pct, updated_at)
  values
    (new.user_id, new.subject_code, new.topic, 1, new.awarded, new.total,
     (current_date + coalesce(next_int, 1)), coalesce(next_int, 1), coalesce(next_ease, 2.5), this_pct, now())
  on conflict (user_id, subject_code, topic) do update
    set attempts      = m.attempts + 1,
        marks_awarded = m.marks_awarded + excluded.marks_awarded,
        marks_total   = m.marks_total + excluded.marks_total,
        review_at     = case when moves or excluded.interval_days < m.interval_days
                             then excluded.review_at else m.review_at end,
        interval_days = case when moves or excluded.interval_days < m.interval_days
                             then excluded.interval_days else m.interval_days end,
        ease          = excluded.ease,
        last_pct      = excluded.last_pct,
        updated_at    = case when moves then now() else m.updated_at end;
  return new;
end
$fn$;


-- ---------------------------------------------------------------------------
-- 10. Recall: validate, and treat a first-ever "again" as a lapse
-- ---------------------------------------------------------------------------

create or replace function public.record_recall(
  p_chunk_id uuid,
  p_subject  text,
  p_grade    smallint
) returns void
language plpgsql security definer set search_path = public as $fn$
declare
  prev public.recall_reviews%rowtype;
  next_ease numeric;
  next_int  integer;
  real_subject text;
begin
  if p_grade is null or p_grade not between 0 and 3 then
    raise exception 'grade must be between 0 and 3';
  end if;

  -- Trust the chunk, not the caller, for which subject it belongs to.
  select subject_code into real_subject from public.chunks where id = p_chunk_id;
  if real_subject is null then
    raise exception 'unknown question';
  end if;

  select * into prev
  from public.recall_reviews
  where user_id = auth.uid() and chunk_id = p_chunk_id;

  next_ease := greatest(1.3, least(2.8, coalesce(prev.ease, 2.5) + (p_grade - 2) * 0.13));

  if p_grade = 0 then
    next_int := 1;
  elsif coalesce(prev.reps, 0) = 0 then
    next_int := case when p_grade >= 3 then 4 else 2 end;
  else
    next_int := greatest(1, least(180, ceil(greatest(1, coalesce(prev.interval_days, 1)) * next_ease)::integer));
  end if;

  insert into public.recall_reviews as r
    (user_id, chunk_id, subject_code, reps, interval_days, ease, due_at, last_grade, updated_at)
  values
    (auth.uid(), p_chunk_id, real_subject, case when p_grade = 0 then 0 else 1 end,
     next_int, next_ease, current_date + next_int, p_grade, now())
  on conflict (user_id, chunk_id) do update
    set reps          = case when p_grade = 0 then 0 else r.reps + 1 end,
        interval_days = excluded.interval_days,
        ease          = excluded.ease,
        due_at        = excluded.due_at,
        last_grade    = excluded.last_grade,
        updated_at    = now();
end
$fn$;


-- ---------------------------------------------------------------------------
-- 11. Nothing in the corpus is for anonymous callers
--
-- Postgres grants EXECUTE to PUBLIC on every new function, and Supabase's
-- default privileges add anon on top. The corpus functions are SECURITY
-- DEFINER, so an unauthenticated request could read question text and mark
-- schemes through them regardless of what the row-level policies say.
-- ---------------------------------------------------------------------------

do $lock$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as sig, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       and p.prorettype <> 'trigger'::regtype
       -- Never touch functions an extension owns (pgvector may live in public).
       and not exists (
         select 1 from pg_depend d
          where d.objid = p.oid and d.deptype = 'e'
       )
  loop
    execute format('revoke all on function %s from public, anon', fn.sig);
    if fn.proname in (
      'match_chunks','similar_chunks','question_siblings','subject_topics',
      'sample_questions','subject_papers','weak_topics','predict_grade',
      'due_revisions','recall_deck','record_recall','progress_series',
      'subject_readiness','my_ai_usage'
    ) then
      execute format('grant execute on function %s to authenticated, service_role', fn.sig);
    end if;
  end loop;
end
$lock$;

grant execute on function public.predict_grade(text, text, numeric, text, integer, text)
  to authenticated, service_role;


do $report$
declare
  dup int;
begin
  select count(*) into dup from (
    select 1 from public.papers
     group by subject_code, kind, year, session, paper_ref having count(*) > 1
  ) d;
  raise notice 'Markwise: Edexcel foundation applied. Duplicate papers remaining: %', dup;
end
$report$;
