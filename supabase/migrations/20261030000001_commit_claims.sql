-- ============================================================================
-- Commit claims (docs/ARCHITECTURE.md §5.4): a commit whose git email isn't linked to anyone's
-- GitHub account counts for nobody. Its author claims it, course staff confirm, and the commit
-- counts for them; staff can also remember the email, so later commits from it are credited
-- at once. The api writes everything.
-- ============================================================================

-- Who git says wrote the commit (from the push), and how the platform attributed it.
alter table public.commits
  add column author_email text,
  add column author_name text,
  add column attribution text check (attribution in ('github', 'claim', 'alias'));
update public.commits set attribution = 'github' where author_profile_id is not null;
create index commits_unattributed_idx on public.commits (repository_id) where author_profile_id is null;

create table public.commit_claims (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  commit_id uuid not null,
  repository_id uuid not null,
  claimed_by uuid not null references public.profiles (id) on delete cascade,
  note text check (length(note) <= 500),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (commit_id, claimed_by),
  unique (institution_id, id),
  foreign key (institution_id, commit_id) references public.commits (institution_id, id) on delete cascade,
  foreign key (institution_id, repository_id) references public.repositories (institution_id, id) on delete cascade
);
-- A commit is credited to one person.
create unique index commit_claims_approved_idx on public.commit_claims (commit_id) where status = 'approved';
create index commit_claims_open_idx on public.commit_claims (repository_id) where status = 'pending';

-- Git emails staff confirmed as someone's (within the institution).
create table public.commit_author_aliases (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete cascade,
  email text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+$'),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  confirmed_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (institution_id, email)
);

create trigger audit after insert or update or delete on public.commit_claims
  for each row execute function private.audit_row();
create trigger audit after insert or update or delete on public.commit_author_aliases
  for each row execute function private.audit_row();

-- Course staff of any assignment using the repository.
create function private.is_repository_staff(rid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.submissions s
    join public.assignments a on a.id = s.assignment_id
    where s.repository_id = rid and private.is_course_staff(a.course_id)
  );
$$;

alter table public.commit_claims enable row level security;
alter table public.commit_author_aliases enable row level security;

create policy commit_claims_select on public.commit_claims for select to authenticated
  using ((claimed_by = (select auth.uid()) and institution_id = any ((select private.my_institution_ids())::uuid[]))
         or private.is_repository_staff(repository_id));
create policy commit_author_aliases_select on public.commit_author_aliases for select to authenticated
  using ((profile_id = (select auth.uid()) and institution_id = any ((select private.my_institution_ids())::uuid[]))
         or private.has_institution_role(institution_id, '{admin,teacher}'));
revoke insert, update, delete on public.commit_claims, public.commit_author_aliases from authenticated;
revoke all on public.commit_claims, public.commit_author_aliases from anon;

-- Staff hear about new claims; students about the decision.
alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (
  type in ('run_finished', 'grade_released', 'deadline_soon', 'extension_granted', 'regrade_requested',
           'regrade_answered', 'records_notice', 'commit_claim')
);
alter table public.profiles drop constraint profiles_email_notification_types_check;
alter table public.profiles add constraint profiles_email_notification_types_check
  check (email_notification_types <@ array['run_finished', 'grade_released', 'deadline_soon', 'extension_granted',
                                           'regrade_requested', 'regrade_answered', 'commit_claim']);
