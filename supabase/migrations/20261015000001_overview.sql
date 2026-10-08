-- ============================================================================
-- One row per submission with what dashboards need: the latest finished run, the last
-- activity, and the current grade. security_invoker: every underlying table's RLS and
-- column privileges apply to whoever queries it (students see their own row, and their
-- grade only once released; staff see their courses).
-- ============================================================================

create view public.submission_overview with (security_invoker = true) as
select
  s.id as submission_id,
  s.institution_id,
  s.assignment_id,
  a.course_id,
  s.user_id,
  s.status,
  s.repository_id,
  s.final_sha,
  s.submitted_at,
  s.late_days,
  s.finalized_at,
  s.grade_released_at,
  -- When the platform received the latest commit (commit dates can be set to anything).
  (select max(c.created_at) from public.commits c where c.repository_id = s.repository_id) as last_activity_at,
  lr.id as latest_run_id,
  lr.score as latest_run_score,
  lr.summary as latest_run_summary,
  lr.queued_at as latest_run_at,
  g.version as grade_version,
  g.final_score,
  g.complete as grade_complete,
  g.released_at as grade_released_at_version,
  g.components as grade_components,
  s.created_at,
  g.computed_score,
  g.late_penalty,
  g.override_score
from public.submissions s
join public.assignments a on a.id = s.assignment_id
left join lateral (
  select r.id, r.score, r.summary, r.queued_at
  from public.evaluation_runs r
  where r.submission_id = s.id and r.status = 'completed'
  order by r.queued_at desc
  limit 1
) lr on true
left join public.grades g on g.submission_id = s.id and g.is_current;

revoke all on public.submission_overview from anon;
grant select on public.submission_overview to authenticated;
