-- ============================================================================
-- Teams (docs/ARCHITECTURE.md §5.2, §5.4): students work in teams within a course, and team
-- assignments give each team one repository. Every member keeps their own submission (and so
-- their own grade, grade report, LMS score and process score), pointing at the team's
-- repository; the team shares the repository, its test runs, the graded commit and the rubric.
-- Teams are written by the api only (changes move people between repositories).
-- ============================================================================

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  course_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 80),
  slug text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (course_id, slug),
  unique (institution_id, id),
  unique (institution_id, course_id, id),
  foreign key (institution_id, course_id) references public.courses (institution_id, id) on delete cascade
);

-- A student is in at most one team per course.
create table public.team_members (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  course_id uuid not null,
  team_id uuid not null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (course_id, user_id),
  unique (institution_id, id),
  -- One key to the team: same institution and same course (and one relationship for the Data API).
  foreign key (institution_id, course_id, team_id) references public.teams (institution_id, course_id, id)
    on delete cascade,
  foreign key (course_id, user_id) references public.course_memberships (course_id, user_id) on delete cascade
);
create index team_members_team_idx on public.team_members (team_id);

create trigger set_updated_at before update on public.teams
  for each row execute function private.set_updated_at();
create trigger audit after insert or update or delete on public.teams
  for each row execute function private.audit_row();
create trigger audit after insert or update or delete on public.team_members
  for each row execute function private.audit_row();

-- Individual or team work, fixed once published (repositories depend on it).
alter table public.assignments
  add column mode text not null default 'individual' check (mode in ('individual', 'team'));
grant insert (mode), update (mode) on public.assignments to authenticated;

create or replace function private.check_assignment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  profile_institution uuid;
  profile_status text;
begin
  select institution_id, status into profile_institution, profile_status
    from public.stack_profiles where id = new.stack_profile_id;
  if profile_institution is not null and profile_institution <> new.institution_id then
    raise exception 'That stack profile belongs to another institution' using errcode = '23503';
  end if;
  if tg_op = 'INSERT' and profile_status <> 'active' then
    raise exception 'That stack profile is retired' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and old.status <> 'draft' then
    if new.stack_profile_id <> old.stack_profile_id then
      raise exception 'The stack profile is locked once an assignment is published' using errcode = 'P0001';
    end if;
    if new.slug <> old.slug then
      raise exception 'The assignment slug is locked once published (repository names use it)' using errcode = 'P0001';
    end if;
    if new.mode <> old.mode then
      raise exception 'Individual or team work is locked once an assignment is published' using errcode = 'P0001';
    end if;
    if new.status = 'draft' then
      raise exception 'A published assignment cannot go back to draft' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

-- Team assignments: each member's submission names their team.
alter table public.submissions
  add column team_id uuid,
  add foreign key (institution_id, team_id) references public.teams (institution_id, id);
create index submissions_team_idx on public.submissions (team_id) where team_id is not null;

alter type public.submission_status add value 'waiting_for_team' after 'waiting_for_github';

/** Creates the missing submissions of a published assignment (one per enrolled student). */
create or replace function private.ensure_submissions(p_assignment uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  created integer;
begin
  insert into public.submissions (institution_id, assignment_id, user_id, team_id, status)
  select a.institution_id, a.id, cm.user_id, tm.team_id,
         case when a.mode = 'team' and tm.team_id is null then 'waiting_for_team'::public.submission_status
              when p.github_user_id is null then 'waiting_for_github'::public.submission_status
              else 'provisioning'::public.submission_status end
  from public.assignments a
  join public.course_memberships cm on cm.course_id = a.course_id and cm.role = 'student'
  join public.institution_memberships im on im.institution_id = cm.institution_id and im.user_id = cm.user_id and im.status = 'active'
  join public.profiles p on p.id = cm.user_id
  left join public.team_members tm on a.mode = 'team' and tm.course_id = a.course_id and tm.user_id = cm.user_id
  where a.id = p_assignment and a.status = 'published'
  on conflict (assignment_id, user_id) do nothing;
  get diagnostics created = row_count;
  return created;
end;
$$;

-- The student's teammates on an assignment (their submissions), for sharing team work.
create function private.is_teammate_submission(sid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.submissions s
    join public.submissions mine on mine.assignment_id = s.assignment_id and mine.team_id = s.team_id
    where s.id = sid and s.team_id is not null
      and mine.user_id = (select auth.uid()) and mine.institution_id = any (private.my_institution_ids())
  );
$$;

-- Team work (the shared repository's runs, results, files and snapshots) is visible to the
-- whole team; grades, rubric scores, feedback and process scores stay personal.
create function private.can_view_team_work(sid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.can_view_submission(sid) or private.is_teammate_submission(sid);
$$;

drop policy submissions_select on public.submissions;
create policy submissions_select on public.submissions for select to authenticated
  using (
    (user_id = (select auth.uid()) and institution_id = any ((select private.my_institution_ids())::uuid[]))
    or private.is_course_staff((select course_id from public.assignments where id = assignment_id))
    or private.is_teammate_submission(id)
  );
drop policy evaluation_runs_select on public.evaluation_runs;
create policy evaluation_runs_select on public.evaluation_runs for select to authenticated
  using (private.can_view_team_work(submission_id));
drop policy test_results_select on public.test_results;
create policy test_results_select on public.test_results for select to authenticated
  using (private.can_view_team_work((select submission_id from public.evaluation_runs where id = run_id)));
drop policy run_artifacts_select on public.run_artifacts;
create policy run_artifacts_select on public.run_artifacts for select to authenticated
  using (private.can_view_team_work((select submission_id from public.evaluation_runs where id = run_id)));
drop policy submission_snapshots_select on public.submission_snapshots;
create policy submission_snapshots_select on public.submission_snapshots for select to authenticated
  using (private.can_view_team_work(submission_id));
-- Code review comments on a team's code: every member sees them once their own grade is out.
drop policy review_comments_select on public.review_comments;
create policy review_comments_select on public.review_comments for select to authenticated
  using (
    private.grade_visible(submission_id)
    or (private.is_teammate_submission(submission_id) and exists (
      select 1 from public.submissions mine
      join public.submissions s on s.id = review_comments.submission_id
      where mine.assignment_id = s.assignment_id and mine.team_id = s.team_id
        and mine.user_id = (select auth.uid()) and mine.grade_released_at is not null
    ))
  );

alter table public.teams enable row level security;
alter table public.team_members enable row level security;

-- Everyone in the course sees its teams; members see their teammates, staff see everyone.
create policy teams_select on public.teams for select to authenticated
  using (private.is_course_staff(course_id) or private.has_course_role(course_id, '{student}'));
create function private.is_team_member(tid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.team_members
    where team_id = tid and user_id = (select auth.uid()) and institution_id = any (private.my_institution_ids())
  );
$$;
create policy team_members_select on public.team_members for select to authenticated
  using (private.is_course_staff(course_id) or private.is_team_member(team_id));
-- Teammates see each other's names and GitHub logins (and nothing else is added).
drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or exists (
      select 1 from public.institution_memberships target
      where target.user_id = profiles.id
        and private.has_institution_role(target.institution_id, '{admin,teacher}'))
    or exists (
      select 1 from public.course_memberships cm
      where cm.user_id = profiles.id
        and private.has_course_role(cm.course_id, '{instructor,ta}'))
    or exists (
      select 1 from public.team_members tm
      where tm.user_id = profiles.id and private.is_team_member(tm.team_id))
  );

revoke insert, update, delete on public.teams, public.team_members from authenticated;
revoke all on public.teams, public.team_members from anon;
