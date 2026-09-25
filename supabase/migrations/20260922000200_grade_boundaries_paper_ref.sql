-- Edexcel boundaries are keyed by paper_ref ("1H"); the old not-null paper_no
-- rejected every row and nothing reads it any more.
alter table public.grade_boundaries alter column paper_no drop not null;
alter table public.grade_boundaries alter column paper_no set default 0;
