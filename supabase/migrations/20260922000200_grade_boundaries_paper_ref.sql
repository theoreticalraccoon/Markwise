-- Edexcel grade boundaries are keyed by paper_ref ("1F", "1H"), not a numeric
-- paper_no: `grade_boundaries.paper_no` is still `not null` from the Cambridge
-- schema, which rejects every Edexcel row. Nothing reads paper_no any more
-- (predict_grade and the unique key were switched to paper_ref/tier already),
-- so it just needs to stop being mandatory.
alter table public.grade_boundaries alter column paper_no drop not null;
alter table public.grade_boundaries alter column paper_no set default 0;
