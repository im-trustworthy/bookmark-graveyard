-- Count the analysis passes that failed because of a post's own content: the
-- model answered and left the post out, answered with something that is not
-- JSON, or the provider rejected the request (HTTP 400, 413 or 422). A post at
-- MAX_ANALYSIS_ATTEMPTS (src/lib/state/pipeline.ts) is given up, so one bad
-- post can no longer keep the analysis backlog from draining. Outages, rate
-- limits and configuration errors are not counted. Writing an analysis row,
-- or the user asking to retry, sets it back to 0.
alter table public.bookmarks
  add column if not exists analysis_attempts integer not null default 0
  constraint bookmarks_analysis_attempts_check check (analysis_attempts >= 0);
