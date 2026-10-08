-- ============================================================================
-- Automated evaluation: grader suites, evaluation runs and test results.
-- See docs/ARCHITECTURE.md §6.
-- ============================================================================

-- Hidden test suites (global when institution_id is null). Immutable: new version per change.
create table public.grader_suites (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid references public.institutions (id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  version integer not null check (version > 0),
  title text not null,
  -- Path in the grader repository and the git ref the workflow checks out.
  path text not null,
  git_ref text not null default 'main',
  stack_profile_id uuid references public.stack_profiles (id),
  manifest jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'retired')),
  created_at timestamptz not null default now(),
  unique nulls not distinct (institution_id, key, version)
);

-- An API-only stack, used by the sample suite (grader/suites/sample/todo-api).
insert into public.stack_profiles (key, version, display_name, description, definition) values (
  'node22-api', 1, 'Node.js API (Node 22)',
  'An HTTP API on Node.js 22 with no frontend or database. Run with Docker Compose.',
  '{
    "detect": ["package.json", "compose.yaml"],
    "services": {"backend": {"port": 4000, "health": "/health"}},
    "datastores": [],
    "env_required": [],
    "stages": {"build": {"run": "docker compose build"}},
    "ignore_paths": ["**/node_modules/**", "**/dist/**", "**/package-lock.json"]
  }'::jsonb
);

insert into public.grader_suites (key, version, title, path, stack_profile_id, manifest) values (
  'todo-api', 1, 'Todo API (sample suite)', 'suites/sample/todo-api',
  (select id from public.stack_profiles where key = 'node22-api' and version = 1 and institution_id is null),
  '{"stages": ["contract", "build", "health", "api"], "tests": 7}'::jsonb
);

alter table public.assignments
  add column grader_suite_id uuid references public.grader_suites (id);

-- A suite must be global or the assignment's own institution's (suites are hidden tests),
-- and active when chosen.
create function private.check_assignment_suite() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  suite_institution uuid;
  suite_status text;
begin
  if new.grader_suite_id is null then
    return new;
  end if;
  select institution_id, status into suite_institution, suite_status
    from public.grader_suites where id = new.grader_suite_id;
  if suite_institution is not null and suite_institution <> new.institution_id then
    raise exception 'That grader suite belongs to another institution' using errcode = '23503';
  end if;
  if suite_status <> 'active' and (tg_op = 'INSERT' or new.grader_suite_id is distinct from old.grader_suite_id) then
    raise exception 'That grader suite is retired' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger check_assignment_suite before insert or update of grader_suite_id on public.assignments
  for each row execute function private.check_assignment_suite();

-- Head of the default branch as last pushed (manual runs test it). pushed_at orders
-- out-of-order webhook deliveries.
alter table public.repositories
  add column head_sha text check (head_sha ~ '^[0-9a-f]{40}$'),
  add column head_pushed_at timestamptz;

create type public.run_trigger as enum ('push', 'pull_request', 'manual', 'deadline', 'regrade');
create type public.run_status as enum ('queued', 'dispatched', 'running', 'completed', 'failed', 'infra_error', 'cancelled');

create table public.evaluation_runs (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  submission_id uuid not null,
  sha text not null check (sha ~ '^[0-9a-f]{40}$'),
  trigger public.run_trigger not null,
  status public.run_status not null default 'queued',
  grader_suite_id uuid references public.grader_suites (id),
  stack_profile_id uuid references public.stack_profiles (id),
  score numeric(5, 2) check (score is null or score between 0 and 100),
  summary jsonb,
  error text,
  requested_by uuid references public.profiles (id) on delete set null,
  -- Local development only: hash of a per-run token the harness presents instead of an OIDC token.
  callback_token_hash text,
  gh_workflow_run_id bigint,
  check_run_id bigint,
  queued_at timestamptz not null default now(),
  dispatched_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  unique (institution_id, id),
  foreign key (institution_id, submission_id) references public.submissions (institution_id, id) on delete cascade
);
create index evaluation_runs_submission_idx on public.evaluation_runs (submission_id, queued_at desc);
create index evaluation_runs_active_idx on public.evaluation_runs (queued_at) where status in ('queued', 'dispatched', 'running');

create table public.test_results (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  run_id uuid not null,
  stage text not null,
  test_key text not null,
  title text not null,
  category text,
  status text not null check (status in ('passed', 'failed', 'skipped', 'error')),
  weight numeric(6, 2) not null default 1 check (weight >= 0),
  duration_ms integer,
  expected text,
  actual text,
  message text,
  hint text,
  evidence jsonb,
  -- For course staff only (column privilege below): e.g. common causes of a failure.
  staff_notes text,
  unique (run_id, stage, test_key),
  unique (institution_id, id),
  foreign key (institution_id, run_id) references public.evaluation_runs (institution_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.grader_suites enable row level security;
alter table public.evaluation_runs enable row level security;
alter table public.test_results enable row level security;

create policy grader_suites_select on public.grader_suites for select to authenticated
  using (institution_id is null or institution_id = any ((select private.my_institution_ids())::uuid[]));

create policy evaluation_runs_select on public.evaluation_runs for select to authenticated
  using (private.can_view_submission(submission_id));

create policy test_results_select on public.test_results for select to authenticated
  using (private.can_view_submission((select submission_id from public.evaluation_runs where id = run_id)));

revoke insert, update, delete on public.grader_suites, public.evaluation_runs, public.test_results from authenticated;
revoke all on public.grader_suites, public.evaluation_runs, public.test_results from anon;

-- Students must not read staff notes or the callback token hash: grant every other column.
revoke select on public.test_results from authenticated;
grant select (id, institution_id, run_id, stage, test_key, title, category, status, weight, duration_ms, expected, actual,
              message, hint, evidence)
  on public.test_results to authenticated;
revoke select on public.evaluation_runs from authenticated;
grant select (id, institution_id, submission_id, sha, trigger, status, grader_suite_id, stack_profile_id, score, summary, error,
              requested_by, gh_workflow_run_id, check_run_id, queued_at, dispatched_at, started_at, finished_at)
  on public.evaluation_runs to authenticated;

grant insert (grader_suite_id), update (grader_suite_id) on public.assignments to authenticated;

-- Course staff read the staff notes through this function (the column is not granted).
create function public.run_staff_notes(p_run_id uuid)
returns table (stage text, test_key text, staff_notes text)
language sql stable security definer set search_path = '' as $$
  select t.stage, t.test_key, t.staff_notes
  from public.test_results t
  join public.evaluation_runs r on r.id = t.run_id
  join public.submissions s on s.id = r.submission_id
  join public.assignments a on a.id = s.assignment_id
  where t.run_id = p_run_id and t.staff_notes is not null and private.is_course_staff(a.course_id);
$$;
revoke execute on function public.run_staff_notes(uuid) from public, anon;
grant execute on function public.run_staff_notes(uuid) to authenticated;
