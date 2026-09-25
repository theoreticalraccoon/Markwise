-- Per-user daily AI budget. The Gemini free tier is shared, so one student in
-- a loop could spend everyone's quota. Edge functions check this first.

create table if not exists public.ai_usage (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  route      text not null,                -- 'ask' | 'mark' | 'mock' | 'similar'
  day        date not null default (now() at time zone 'utc')::date,
  tokens_in  integer not null default 0,
  tokens_out integer not null default 0,
  ms         integer not null default 0,
  ok         boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_day_idx on public.ai_usage (user_id, day);

alter table public.ai_usage enable row level security;

drop policy if exists "usage_read_own" on public.ai_usage;
create policy "usage_read_own" on public.ai_usage
  for select using (auth.uid() = user_id);
-- Writes come from edge functions using the service-role key only.

-- Daily caps, per route. Tunable without redeploying a function.
create table if not exists public.ai_limits (
  route     text primary key,
  per_day   integer not null
);

insert into public.ai_limits (route, per_day) values
  ('ask', 60), ('mark', 40), ('mock', 8), ('similar', 40)
on conflict (route) do nothing;

alter table public.ai_limits enable row level security;
drop policy if exists "limits_read" on public.ai_limits;
create policy "limits_read" on public.ai_limits for select to authenticated using (true);

-- Check the cap and record the call in one step. Returns what's left, or -1.
create or replace function public.claim_ai_call(p_user uuid, p_route text)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  cap  integer;
  used integer;
begin
  select per_day into cap from public.ai_limits where route = p_route;
  if cap is null then cap := 30; end if;

  select count(*) into used
  from public.ai_usage
  where user_id = p_user
    and route = p_route
    and day = (now() at time zone 'utc')::date;

  if used >= cap then
    return -1;
  end if;

  insert into public.ai_usage (user_id, route) values (p_user, p_route);
  return cap - used - 1;
end
$fn$;

revoke execute on function public.claim_ai_call(uuid, text) from public, anon, authenticated;
grant  execute on function public.claim_ai_call(uuid, text) to service_role;

-- What the client shows in Settings: today's usage against each cap.
create or replace function public.my_ai_usage()
returns table (route text, used bigint, per_day integer)
language sql stable security definer set search_path = public as $fn$
  select l.route,
         coalesce(u.n, 0) as used,
         l.per_day
  from public.ai_limits l
  left join (
    select route, count(*) as n
    from public.ai_usage
    where user_id = auth.uid() and day = (now() at time zone 'utc')::date
    group by route
  ) u on u.route = l.route
  order by l.route;
$fn$;

grant execute on function public.my_ai_usage to authenticated;
