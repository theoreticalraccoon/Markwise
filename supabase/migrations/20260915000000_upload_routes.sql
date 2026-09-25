-- Daily caps for ingest (a PDF into the corpus) and markpaper (photos of
-- answers). Whole documents cost far more than chat, so the caps are lower.

insert into public.ai_limits (route, per_day) values
  ('ingest', 25),
  ('markpaper', 10)
on conflict (route) do nothing;
