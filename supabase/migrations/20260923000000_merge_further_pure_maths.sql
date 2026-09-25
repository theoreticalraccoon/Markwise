-- X-FPM duplicated the real subject E-4PM1 in the catalogue. Move user data to
-- E-4PM1 and hide X-FPM (kept, not deleted). Idempotent; to roll back, reactivate X-FPM.

-- Profiles store subject codes in an array. Preserve their original order,
-- replace the alias, and collapse a duplicate if both codes were selected.
update public.profiles p
set subjects = (
      select coalesce(array_agg(code order by first_position), '{}'::text[])
      from (
        select case when item = 'X-FPM' then 'E-4PM1' else item end as code,
               min(position) as first_position
        from unnest(p.subjects) with ordinality as selected(item, position)
        group by case when item = 'X-FPM' then 'E-4PM1' else item end
      ) deduplicated
    ),
    updated_at = now()
where p.subjects @> array['X-FPM']::text[];

update public.profiles
set prefs = jsonb_set(prefs, '{lastSubject}', to_jsonb('E-4PM1'::text), false),
    updated_at = now()
where prefs->>'lastSubject' = 'X-FPM';

update public.profiles
set prefs = jsonb_set(prefs, '{lastCorpus}', to_jsonb('E-4PM1'::text), false),
    updated_at = now()
where prefs->>'lastCorpus' = 'X-FPM';

-- User-owned records are text-keyed rather than foreign-keyed, so normalise
-- every current writer even though the live audit found no alias rows here.
update public.tasks set subject = 'E-4PM1' where subject = 'X-FPM';
update public.tuition_sessions set subject = 'E-4PM1' where subject = 'X-FPM';
update public.mocks set subject_code = 'E-4PM1' where subject_code = 'X-FPM';
update public.chat_threads set subject_code = 'E-4PM1' where subject_code = 'X-FPM';
update public.attempts set subject_code = 'E-4PM1' where subject_code = 'X-FPM';
update public.paper_attempts set subject_code = 'E-4PM1' where subject_code = 'X-FPM';
update public.recall_reviews set subject_code = 'E-4PM1' where subject_code = 'X-FPM';

-- topic_mastery is keyed by user + subject + topic. Merge counters if an old
-- account somehow accumulated rows under both codes before removing the alias.
insert into public.topic_mastery (
  user_id, subject_code, topic, attempts, marks_awarded, marks_total,
  updated_at, review_at, interval_days, ease, last_pct
)
select user_id, 'E-4PM1', topic, attempts, marks_awarded, marks_total,
       updated_at, review_at, interval_days, ease, last_pct
from public.topic_mastery
where subject_code = 'X-FPM'
on conflict (user_id, subject_code, topic) do update
set attempts = public.topic_mastery.attempts + excluded.attempts,
    marks_awarded = public.topic_mastery.marks_awarded + excluded.marks_awarded,
    marks_total = public.topic_mastery.marks_total + excluded.marks_total,
    updated_at = greatest(public.topic_mastery.updated_at, excluded.updated_at),
    review_at = least(public.topic_mastery.review_at, excluded.review_at),
    interval_days = least(public.topic_mastery.interval_days, excluded.interval_days),
    ease = least(public.topic_mastery.ease, excluded.ease),
    last_pct = case
      when excluded.updated_at >= public.topic_mastery.updated_at then excluded.last_pct
      else public.topic_mastery.last_pct
    end;

delete from public.topic_mastery where subject_code = 'X-FPM';

-- E-4PM1 is the only selectable course. The inactive alias remains available
-- for old audit trails and continues to point at the canonical corpus.
update public.subjects
set active = true,
    board = 'Edexcel',
    name = 'Further Pure Mathematics'
where code = 'E-4PM1';

update public.subjects
set active = false,
    corpus_code = 'E-4PM1'
where code = 'X-FPM';
