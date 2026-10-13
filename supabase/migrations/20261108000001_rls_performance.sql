-- Faster row-level security for submissions and the team work hanging off them (found by the
-- Phase 2G load test). The old policies called security-definer functions once per row: for a
-- student opening an assignment with 100 submissions, ~200 small queries per statement.
-- These compute the caller's staff courses and teammates' submissions once per statement
-- (a hashed subplan), and let runs, test results, files and snapshots follow their
-- submission's (or run's) own policy. Who can see what is unchanged.

-- Courses the caller teaches (instructor or TA), and every course of an institution they
-- administer: the same rule as private.is_course_staff, as a set.
create function private.staff_course_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select cm.course_id
  from public.course_memberships cm
  join public.institution_memberships m on m.institution_id = cm.institution_id and m.user_id = cm.user_id
  join public.institutions i on i.id = cm.institution_id
  where cm.user_id = (select auth.uid())
    and cm.role in ('instructor', 'ta')
    and m.status = 'active'
    and i.status in ('active', 'read_only')
  union
  select c.id
  from public.courses c
  join public.institution_memberships m on m.institution_id = c.institution_id
  join public.institutions i on i.id = c.institution_id
  where m.user_id = (select auth.uid())
    and m.role = 'admin'
    and m.status = 'active'
    and i.status in ('active', 'read_only')
    and (select private.admin_mfa_ok());
$$;

create function private.staff_assignment_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select a.id from public.assignments a where a.course_id in (select private.staff_course_ids());
$$;

-- Submissions of the caller's teams (their own included): the same rule as
-- private.is_teammate_submission, as a set.
create function private.teammate_submission_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select s.id
  from public.submissions mine
  join public.submissions s on s.assignment_id = mine.assignment_id and s.team_id = mine.team_id
  where mine.user_id = (select auth.uid())
    and mine.team_id is not null
    and mine.institution_id = any (private.my_institution_ids());
$$;

revoke all on function private.staff_course_ids(), private.staff_assignment_ids(), private.teammate_submission_ids()
  from public, anon;
grant execute on function private.staff_course_ids(), private.staff_assignment_ids(), private.teammate_submission_ids()
  to authenticated;

drop policy submissions_select on public.submissions;
create policy submissions_select on public.submissions for select to authenticated
  using (
    (user_id = (select auth.uid()) and institution_id = any ((select private.my_institution_ids())::uuid[]))
    or assignment_id in (select private.staff_assignment_ids())
    or id in (select private.teammate_submission_ids())
  );

-- Visible exactly when the submission is (its policy is private.can_view_team_work's rule).
drop policy evaluation_runs_select on public.evaluation_runs;
create policy evaluation_runs_select on public.evaluation_runs for select to authenticated
  using (exists (select 1 from public.submissions s where s.id = submission_id));
drop policy submission_snapshots_select on public.submission_snapshots;
create policy submission_snapshots_select on public.submission_snapshots for select to authenticated
  using (exists (select 1 from public.submissions s where s.id = submission_id));

-- Visible exactly when the run is.
drop policy test_results_select on public.test_results;
create policy test_results_select on public.test_results for select to authenticated
  using (exists (select 1 from public.evaluation_runs r where r.id = run_id));
drop policy run_artifacts_select on public.run_artifacts;
create policy run_artifacts_select on public.run_artifacts for select to authenticated
  using (exists (select 1 from public.evaluation_runs r where r.id = run_id));
