-- ============================================================================
-- Stack profiles, assignments, rubric criteria, extensions, repositories and
-- submissions. See docs/ARCHITECTURE.md §6.1 and docs/DATA_MODEL.md.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Stack profiles: how to build, run and test a project in a given stack.
-- Global profiles have institution_id null. Immutable: changes are new versions.
-- ---------------------------------------------------------------------------
create table public.stack_profiles (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid references public.institutions (id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  version integer not null check (version > 0),
  display_name text not null check (length(btrim(display_name)) between 2 and 100),
  description text,
  definition jsonb not null,
  status text not null default 'active' check (status in ('active', 'retired')),
  created_at timestamptz not null default now(),
  unique nulls not distinct (institution_id, key, version)
);

create function private.stack_profile_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.key <> old.key or new.version <> old.version or new.definition <> old.definition
     or new.institution_id is distinct from old.institution_id then
    raise exception 'Stack profiles are immutable; publish a new version instead' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger stack_profile_immutable before update on public.stack_profiles
  for each row execute function private.stack_profile_immutable();

insert into public.stack_profiles (key, version, display_name, description, definition) values
(
  'mern-node20', 1, 'MERN (Node 20, React, MongoDB)',
  'React frontend and an Express API on Node 20, with MongoDB. Run with Docker Compose.',
  '{
    "detect": ["backend/package.json", "frontend/package.json", "compose.yaml"],
    "services": {"frontend": {"port": 3000, "health": "/"}, "backend": {"port": 4000, "health": "/health"}},
    "datastores": ["mongo:7"],
    "env_required": ["MONGODB_URI", "JWT_SECRET"],
    "stages": {
      "build": {"run": "docker compose build"},
      "lint": {"run": "npm run lint --prefix frontend && npm run lint --prefix backend", "report": "eslint-json"},
      "student_tests": {"run": "npm test --prefix backend", "report": "junit"}
    },
    "ignore_paths": ["**/node_modules/**", "**/dist/**", "**/build/**", "**/package-lock.json"]
  }'::jsonb
),
(
  'django-react', 1, 'Django REST + React (Python 3.12, PostgreSQL)',
  'Django REST Framework API on Python 3.12 with PostgreSQL, and a React frontend. Run with Docker Compose.',
  '{
    "detect": ["backend/manage.py", "frontend/package.json", "compose.yaml"],
    "services": {"frontend": {"port": 3000, "health": "/"}, "backend": {"port": 8000, "health": "/health"}},
    "datastores": ["postgres:16"],
    "env_required": ["DATABASE_URL", "SECRET_KEY"],
    "stages": {
      "build": {"run": "docker compose build"},
      "lint": {"run": "ruff check backend && npm run lint --prefix frontend", "report": "text"},
      "student_tests": {"run": "python backend/manage.py test", "report": "junit"}
    },
    "ignore_paths": ["**/node_modules/**", "**/__pycache__/**", "**/.venv/**", "**/migrations/**", "**/package-lock.json"]
  }'::jsonb
);

-- ---------------------------------------------------------------------------
-- Assignments
-- ---------------------------------------------------------------------------
create type public.assignment_status as enum ('draft', 'published', 'closed');

create table public.assignments (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  course_id uuid not null,
  -- Used in repository names ({slug}-{github-login}), so fixed once published.
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$'),
  title text not null check (length(btrim(title)) between 2 and 200),
  spec_md text not null default '',
  stack_profile_id uuid not null references public.stack_profiles (id),
  template_repo text check (template_repo is null or template_repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  release_at timestamptz,
  due_at timestamptz not null,
  late_policy jsonb not null default '{"per_day_percent": 10, "max_days": 5, "grace_minutes": 15}'::jsonb,
  weights jsonb not null default '{"automated": 60, "rubric": 25, "process": 15}'::jsonb,
  process_policy jsonb not null default '{
    "criteria": [
      {"key": "active_days", "target": 6, "weight": 40},
      {"key": "steady_progress", "threshold": 0.4, "weight": 25},
      {"key": "pr_workflow", "target": 3, "weight": 20},
      {"key": "issue_tracking", "target": 3, "weight": 15}
    ],
    "meaningful_commit_min_lines": 3,
    "max_commits_per_day": 3
  }'::jsonb,
  triggers jsonb not null default '{"on_push": true, "on_pull_request": true, "manual": true}'::jsonb,
  run_quota_per_day integer not null default 5 check (run_quota_per_day between 0 and 100),
  status public.assignment_status not null default 'draft',
  published_at timestamptz,
  grades_released_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (institution_id, id),
  unique (course_id, slug),
  foreign key (institution_id, course_id) references public.courses (institution_id, id) on delete cascade,
  check (release_at is null or release_at < due_at),
  check (
    jsonb_typeof(weights -> 'automated') = 'number' and jsonb_typeof(weights -> 'rubric') = 'number'
    and jsonb_typeof(weights -> 'process') = 'number'
    and (weights ->> 'automated')::numeric >= 0 and (weights ->> 'rubric')::numeric >= 0 and (weights ->> 'process')::numeric >= 0
    and (weights ->> 'automated')::numeric + (weights ->> 'rubric')::numeric + (weights ->> 'process')::numeric = 100
  )
);
create index assignments_course_idx on public.assignments (course_id);

create trigger set_updated_at before update on public.assignments
  for each row execute function private.set_updated_at();
create trigger set_created_by before insert on public.assignments
  for each row execute function private.set_created_by();
create trigger audit after insert or update or delete on public.assignments
  for each row execute function private.audit_row();

-- Stack profile must be global or the assignment's own institution's; slug and stack are
-- locked once published (repositories and grading depend on them).
create function private.check_assignment() returns trigger
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
    if new.status = 'draft' then
      raise exception 'A published assignment cannot go back to draft' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger check_assignment before insert or update on public.assignments
  for each row execute function private.check_assignment();

-- Rubric criteria (scored by staff)
create table public.assignment_criteria (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  assignment_id uuid not null,
  title text not null check (length(btrim(title)) between 2 and 200),
  description text,
  max_points numeric(6, 2) not null check (max_points > 0),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  unique (institution_id, id),
  foreign key (institution_id, assignment_id) references public.assignments (institution_id, id) on delete cascade
);
create index assignment_criteria_assignment_idx on public.assignment_criteria (assignment_id, position);

-- Per-student deadline extensions
create table public.assignment_extensions (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  assignment_id uuid not null,
  user_id uuid not null,
  due_at timestamptz not null,
  reason text,
  granted_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (assignment_id, user_id),
  unique (institution_id, id),
  foreign key (institution_id, assignment_id) references public.assignments (institution_id, id) on delete cascade,
  foreign key (institution_id, user_id) references public.institution_memberships (institution_id, user_id) on delete cascade
);
create trigger audit after insert or update or delete on public.assignment_extensions
  for each row execute function private.audit_row();

-- ---------------------------------------------------------------------------
-- Repositories and submissions
-- ---------------------------------------------------------------------------
create table public.repositories (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  github_installation_id uuid not null,
  owner text not null,
  name text not null,
  github_repo_id bigint unique,
  default_branch text not null default 'main',
  private boolean not null default true,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner, name),
  unique (institution_id, id),
  foreign key (institution_id) references public.institutions (id) on delete cascade,
  -- Also blocks unlinking an installation from its institution while repositories use it.
  foreign key (institution_id, github_installation_id) references public.github_installations (institution_id, id)
);
create trigger set_updated_at before update on public.repositories
  for each row execute function private.set_updated_at();

create type public.submission_status as enum (
  'waiting_for_github', 'provisioning', 'active', 'provisioning_failed', 'submitted', 'graded'
);

create table public.submissions (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  assignment_id uuid not null,
  user_id uuid not null,
  repository_id uuid,
  status public.submission_status not null default 'provisioning',
  status_detail text,
  provisioning_attempts integer not null default 0,
  final_sha text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (assignment_id, user_id),
  unique (institution_id, id),
  foreign key (institution_id, assignment_id) references public.assignments (institution_id, id) on delete cascade,
  foreign key (institution_id, user_id) references public.institution_memberships (institution_id, user_id) on delete cascade,
  -- Direct link too, so the Data API can embed the student's profile.
  foreign key (user_id) references public.profiles (id) on delete cascade,
  foreign key (institution_id, repository_id) references public.repositories (institution_id, id)
);
create index submissions_user_idx on public.submissions (user_id);
create index submissions_provisioning_idx on public.submissions (updated_at) where status = 'provisioning';

create trigger set_updated_at before update on public.submissions
  for each row execute function private.set_updated_at();

/** Creates the missing submissions of a published assignment (one per enrolled student). */
create function private.ensure_submissions(p_assignment uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  created integer;
begin
  insert into public.submissions (institution_id, assignment_id, user_id, status)
  select a.institution_id, a.id, cm.user_id,
         case when p.github_user_id is null then 'waiting_for_github'::public.submission_status
              else 'provisioning'::public.submission_status end
  from public.assignments a
  join public.course_memberships cm on cm.course_id = a.course_id and cm.role = 'student'
  join public.institution_memberships im on im.institution_id = cm.institution_id and im.user_id = cm.user_id and im.status = 'active'
  join public.profiles p on p.id = cm.user_id
  where a.id = p_assignment and a.status = 'published'
  on conflict (assignment_id, user_id) do nothing;
  get diagnostics created = row_count;
  return created;
end;
$$;

-- Students who join a course later get submissions for its published assignments.
create function private.on_course_student_added() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a record;
begin
  if new.role = 'student' then
    for a in select id from public.assignments where course_id = new.course_id and status = 'published' loop
      perform private.ensure_submissions(a.id);
    end loop;
  end if;
  return null;
end;
$$;
create trigger on_course_student_added after insert or update of role on public.course_memberships
  for each row execute function private.on_course_student_added();

-- Linking GitHub releases submissions that were waiting for it.
create function private.on_github_linked() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.github_user_id is not null and old.github_user_id is null then
    update public.submissions set status = 'provisioning', status_detail = null
    where user_id = new.id and status = 'waiting_for_github';
  end if;
  return null;
end;
$$;
create trigger on_github_linked after update of github_user_id on public.profiles
  for each row execute function private.on_github_linked();

-- ---------------------------------------------------------------------------
-- RLS helpers for courses
-- ---------------------------------------------------------------------------
-- Instructors, TAs and institution admins of the course's institution.
create function private.is_course_staff(cid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_course_role(cid, '{instructor,ta}')
      or private.has_institution_role((select institution_id from public.courses where id = cid), '{admin}');
$$;

-- Instructors and institution admins (who may change course content).
create function private.can_manage_course(cid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select (private.has_course_role(cid, '{instructor}')
          or private.has_institution_role((select institution_id from public.courses where id = cid), '{admin}'))
     and private.institution_is_writable((select institution_id from public.courses where id = cid));
$$;

-- Students see an assignment once it is published and released.
create function private.can_view_assignment(aid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.assignments a
    where a.id = aid
      and (private.is_course_staff(a.course_id)
           or (private.has_course_role(a.course_id, '{student}')
               and a.status <> 'draft'
               and (a.release_at is null or a.release_at <= now())))
  );
$$;

grant execute on all functions in schema private to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.stack_profiles enable row level security;
alter table public.assignments enable row level security;
alter table public.assignment_criteria enable row level security;
alter table public.assignment_extensions enable row level security;
alter table public.repositories enable row level security;
alter table public.submissions enable row level security;

create policy stack_profiles_select on public.stack_profiles for select to authenticated
  using (institution_id is null or institution_id = any ((select private.my_institution_ids())::uuid[]));
create policy stack_profiles_insert on public.stack_profiles for insert to authenticated
  with check (
    (institution_id is null and (select private.is_super_admin()))
    or (institution_id is not null and private.has_institution_role(institution_id, '{admin}'))
  );
create policy stack_profiles_update on public.stack_profiles for update to authenticated
  using (
    (institution_id is null and (select private.is_super_admin()))
    or (institution_id is not null and private.has_institution_role(institution_id, '{admin}'))
  );

-- Uses the row's own columns: a lookup by id can't see a row inserted by the same
-- statement, which would break INSERT ... RETURNING (what the Data API does).
create policy assignments_select on public.assignments for select to authenticated
  using (
    private.is_course_staff(course_id)
    or (private.has_course_role(course_id, '{student}')
        and status <> 'draft'
        and (release_at is null or release_at <= now()))
  );
create policy assignments_insert on public.assignments for insert to authenticated
  with check (private.can_manage_course(course_id) and status = 'draft');
-- Publishing goes through the API (it also creates submissions and queues provisioning).
create policy assignments_update on public.assignments for update to authenticated
  using (private.can_manage_course(course_id))
  with check (private.can_manage_course(course_id));
create policy assignments_delete on public.assignments for delete to authenticated
  using (private.can_manage_course(course_id) and status = 'draft');

create policy assignment_criteria_select on public.assignment_criteria for select to authenticated
  using (private.can_view_assignment(assignment_id));
create policy assignment_criteria_write on public.assignment_criteria for all to authenticated
  using (private.can_manage_course((select course_id from public.assignments where id = assignment_id)))
  with check (private.can_manage_course((select course_id from public.assignments where id = assignment_id)));

create policy assignment_extensions_select on public.assignment_extensions for select to authenticated
  using (
    (user_id = (select auth.uid()) and institution_id = any ((select private.my_institution_ids())::uuid[]))
    or private.is_course_staff((select course_id from public.assignments where id = assignment_id))
  );
create policy assignment_extensions_write on public.assignment_extensions for all to authenticated
  using (private.can_manage_course((select course_id from public.assignments where id = assignment_id)))
  with check (private.can_manage_course((select course_id from public.assignments where id = assignment_id)));

create policy submissions_select on public.submissions for select to authenticated
  using (
    (user_id = (select auth.uid()) and institution_id = any ((select private.my_institution_ids())::uuid[]))
    or private.is_course_staff((select course_id from public.assignments where id = assignment_id))
  );

create policy repositories_select on public.repositories for select to authenticated
  using (
    exists (
      select 1 from public.submissions s
      join public.assignments a on a.id = s.assignment_id
      where s.repository_id = repositories.id
        and ((s.user_id = (select auth.uid()) and s.institution_id = any ((select private.my_institution_ids())::uuid[]))
             or private.is_course_staff(a.course_id))
    )
  );

-- Status changes of submissions and repositories come from the api/worker only.
revoke insert, update, delete on public.submissions, public.repositories from authenticated;
revoke all on public.stack_profiles, public.assignments, public.assignment_criteria, public.assignment_extensions,
  public.repositories, public.submissions from anon;

-- Users edit assignment content; status, publication and grade release go through the API.
revoke insert, update on public.assignments from authenticated;
grant insert (institution_id, course_id, slug, title, spec_md, stack_profile_id, template_repo, release_at, due_at,
              late_policy, weights, process_policy, triggers, run_quota_per_day)
  on public.assignments to authenticated;
grant update (slug, title, spec_md, stack_profile_id, template_repo, release_at, due_at,
              late_policy, weights, process_policy, triggers, run_quota_per_day)
  on public.assignments to authenticated;
