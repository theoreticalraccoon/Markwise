-- Reset one student's study record as a single transaction. The account,
-- admin permission and daily AI allowance remain so the reset cannot mint quota.
create or replace function public.reset_my_data()
returns void
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'Sign in first.';
  end if;

  delete from public.chat_messages where user_id = me;
  delete from public.chat_threads where user_id = me;
  delete from public.attempts where user_id = me;
  delete from public.topic_mastery where user_id = me;
  delete from public.mocks where user_id = me;
  delete from public.paper_attempts where user_id = me;
  delete from public.recall_reviews where user_id = me;
  delete from public.tasks where user_id = me;
  delete from public.tuition_sessions where user_id = me;

  update public.profiles
  set subjects = '{}', onboarded = false, prefs = '{}', exam_session = null,
      display_name = null, board = 'Edexcel', updated_at = now()
  where id = me;
end
$fn$;

revoke execute on function public.reset_my_data() from public, anon;
grant execute on function public.reset_my_data() to authenticated;
