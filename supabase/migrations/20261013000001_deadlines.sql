-- ============================================================================
-- Deadlines: which commit is graded, and whether it was late.
-- The graded commit is the head of the default branch as of the cutoff, by GitHub's push
-- time (commit dates can be set to anything). See docs/ARCHITECTURE.md §6.2.
-- ============================================================================

alter type public.submission_status add value 'missing' after 'submitted';

-- Every push to a repository's default branch.
create table public.branch_pushes (
  id bigint generated always as identity primary key,
  institution_id uuid not null,
  repository_id uuid not null,
  sha text not null check (sha ~ '^[0-9a-f]{40}$'),
  -- GitHub's time of the push (repository.pushed_at in the push event).
  pushed_at timestamptz not null,
  pusher_github_id bigint,
  by_bot boolean not null default false,
  forced boolean not null default false,
  received_at timestamptz not null default now(),
  unique (repository_id, pushed_at, sha),
  foreign key (institution_id, repository_id) references public.repositories (institution_id, id) on delete cascade
);
create index branch_pushes_repository_idx on public.branch_pushes (repository_id, pushed_at desc);

alter table public.branch_pushes enable row level security;
create policy branch_pushes_select on public.branch_pushes for select to authenticated
  using (private.can_view_repository(repository_id));
revoke insert, update, delete on public.branch_pushes from authenticated;
revoke all on public.branch_pushes from anon;

-- Fixed once the cutoff passes (deadline + grace, or the end of the late window).
alter table public.submissions
  add column submitted_at timestamptz,
  add column late_days integer check (late_days >= 0),
  add column finalized_at timestamptz;

create index submissions_open_idx on public.submissions (assignment_id) where finalized_at is null;

-- An extension whose cutoff is still ahead reopens a submission that was already fixed: the
-- student can keep working, and the graded commit is chosen again at the new cutoff.
create function private.on_extension_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.submissions s
  set finalized_at = null, final_sha = null, submitted_at = null, late_days = null,
      status = case
        when s.repository_id is not null then 'active'::public.submission_status
        when p.github_user_id is null then 'waiting_for_github'::public.submission_status
        else 'provisioning'::public.submission_status end
  from public.assignments a, public.profiles p
  where s.assignment_id = new.assignment_id and s.user_id = new.user_id
    and a.id = s.assignment_id and p.id = s.user_id
    and s.finalized_at is not null
    and new.due_at + make_interval(
          days => coalesce((a.late_policy->>'max_days')::int, 0),
          mins => coalesce((a.late_policy->>'grace_minutes')::int, 0)) > now();
  if found then
    update public.process_snapshots ps set is_final = false
    from public.submissions s
    where ps.submission_id = s.id and s.assignment_id = new.assignment_id and s.user_id = new.user_id;
  end if;
  return null;
end;
$$;
create trigger on_extension_changed after insert or update of due_at on public.assignment_extensions
  for each row execute function private.on_extension_changed();
