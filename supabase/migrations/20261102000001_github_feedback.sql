-- ============================================================================
-- Feedback on GitHub (docs/ARCHITECTURE.md §5.5): when an assignment opts in, the released
-- written feedback and inline code comments are also posted to the student's (or team's)
-- repository as a "Feedback" issue, which the worker keeps up to date. Code comments appear as
-- permalinks, which GitHub shows as code snippets. Scores are never posted. (A pull request
-- review would need write access to the students' code, which the App doesn't have.)
-- ============================================================================

alter table public.assignments add column post_feedback_to_github boolean not null default false;
grant insert (post_feedback_to_github), update (post_feedback_to_github) on public.assignments to authenticated;

-- The repository's feedback issue, and what was last posted there (a hash of the body).
alter table public.repositories
  add column feedback_issue_number integer check (feedback_issue_number > 0),
  add column feedback_hash text,
  add column feedback_posted_at timestamptz,
  add column feedback_error text check (length(feedback_error) <= 1000);
