-- brief_jobs.stage was created as free text, so nothing stopped the database
-- from holding a stage the code does not know. This limits it to the values of
-- BRIEF_JOB_STAGES (src/lib/state/brief-job.ts).
--
-- A new stage needs a migration that replaces this constraint, applied before
-- the code that writes the stage is deployed; until then the write is rejected.
--
-- Added NOT VALID so the add takes only a brief lock and does not scan the
-- table, then validated in a second statement. If a row already holds a value
-- outside the list, the validation fails and changes nothing. The drop makes
-- the file safe to run again.

alter table public.brief_jobs drop constraint if exists brief_jobs_stage_check;

alter table public.brief_jobs
  add constraint brief_jobs_stage_check
  check (stage in ('queued', 'syncing', 'selecting', 'writing', 'scripting', 'rendering', 'publishing', 'done', 'failed'))
  not valid;

alter table public.brief_jobs validate constraint brief_jobs_stage_check;
