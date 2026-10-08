-- ============================================================================
-- Activity tracking: commits, pull requests, reviews and issues in student
-- repositories, plus the computed process score. See ARCHITECTURE §5.4.
-- ============================================================================

-- Who may see a repository's activity: its student (in a usable institution) or course staff.
create function private.can_view_repository(rid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.submissions s
    join public.assignments a on a.id = s.assignment_id
    where s.repository_id = rid
      and ((s.user_id = (select auth.uid()) and s.institution_id = any (private.my_institution_ids()))
           or private.is_course_staff(a.course_id))
  );
$$;

create function private.can_view_submission(sid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.submissions s
    join public.assignments a on a.id = s.assignment_id
    where s.id = sid
      and ((s.user_id = (select auth.uid()) and s.institution_id = any (private.my_institution_ids()))
           or private.is_course_staff(a.course_id))
  );
$$;

create table public.commits (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  repository_id uuid not null,
  sha text not null check (sha ~ '^[0-9a-f]{40}$'),
  branch text,
  message text not null default '',
  authored_at timestamptz not null,
  pushed_at timestamptz not null default now(),
  -- From the push payload (may be absent or wrong); replaced by the commit API's matched user.
  author_login text,
  author_github_id bigint,
  author_profile_id uuid references public.profiles (id) on delete set null,
  -- Filled in by the commit-details job.
  details_status text not null default 'pending' check (details_status in ('pending', 'done', 'unavailable')),
  parent_count integer,
  additions integer,
  deletions integer,
  files_changed integer,
  -- Changed lines that count: outside the stack profile's ignore_paths, not whitespace-only.
  effective_lines integer,
  is_bot boolean not null default false,
  created_at timestamptz not null default now(),
  unique (repository_id, sha),
  unique (institution_id, id),
  foreign key (institution_id, repository_id) references public.repositories (institution_id, id) on delete cascade
);
create index commits_repository_time_idx on public.commits (repository_id, authored_at);
create index commits_pending_idx on public.commits (created_at) where details_status = 'pending';

create table public.pull_requests (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  repository_id uuid not null,
  number integer not null,
  github_id bigint not null,
  author_github_id bigint,
  author_profile_id uuid references public.profiles (id) on delete set null,
  title text not null default '',
  body_length integer not null default 0,
  linked_issues integer[] not null default '{}',
  state text not null check (state in ('open', 'closed', 'merged')),
  review_count integer not null default 0,
  opened_at timestamptz not null,
  closed_at timestamptz,
  merged_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (repository_id, number),
  unique (institution_id, id),
  foreign key (institution_id, repository_id) references public.repositories (institution_id, id) on delete cascade
);

create table public.pr_reviews (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  repository_id uuid not null,
  pr_number integer not null,
  github_review_id bigint not null unique,
  reviewer_github_id bigint,
  reviewer_profile_id uuid references public.profiles (id) on delete set null,
  state text not null,
  submitted_at timestamptz not null,
  unique (institution_id, id),
  foreign key (institution_id, repository_id) references public.repositories (institution_id, id) on delete cascade
);

create table public.issues (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  repository_id uuid not null,
  number integer not null,
  github_id bigint not null,
  author_github_id bigint,
  author_profile_id uuid references public.profiles (id) on delete set null,
  title text not null default '',
  state text not null check (state in ('open', 'closed')),
  opened_at timestamptz not null,
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (repository_id, number),
  unique (institution_id, id),
  foreign key (institution_id, repository_id) references public.repositories (institution_id, id) on delete cascade
);

-- Latest process score per submission (frozen with is_final at the deadline).
create table public.process_snapshots (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  submission_id uuid not null unique,
  score numeric(5, 2) not null check (score between 0 and 100),
  breakdown jsonb not null,
  policy jsonb not null,
  is_final boolean not null default false,
  computed_at timestamptz not null default now(),
  unique (institution_id, id),
  foreign key (institution_id, submission_id) references public.submissions (institution_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- RLS: read-only for users; the worker writes.
-- ---------------------------------------------------------------------------
alter table public.commits enable row level security;
alter table public.pull_requests enable row level security;
alter table public.pr_reviews enable row level security;
alter table public.issues enable row level security;
alter table public.process_snapshots enable row level security;

create policy commits_select on public.commits for select to authenticated using (private.can_view_repository(repository_id));
create policy pull_requests_select on public.pull_requests for select to authenticated using (private.can_view_repository(repository_id));
create policy pr_reviews_select on public.pr_reviews for select to authenticated using (private.can_view_repository(repository_id));
create policy issues_select on public.issues for select to authenticated using (private.can_view_repository(repository_id));
create policy process_snapshots_select on public.process_snapshots for select to authenticated
  using (private.can_view_submission(submission_id));

revoke insert, update, delete on public.commits, public.pull_requests, public.pr_reviews, public.issues, public.process_snapshots
  from authenticated;
revoke all on public.commits, public.pull_requests, public.pr_reviews, public.issues, public.process_snapshots from anon;

grant execute on all functions in schema private to authenticated, service_role;
