-- ============================================================================
-- Bulk re-runs (docs/ARCHITECTURE.md §6.2): course instructors re-run the tests of every
-- submission of an assignment at once (or only those whose last run didn't finish), with the
-- assignment's test suite or another version of it. Each run of a batch points to it, so the
-- assignment page can show its progress. The api writes everything.
-- ============================================================================

create table public.run_batches (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  assignment_id uuid not null,
  requested_by uuid references public.profiles (id) on delete set null,
  grader_suite_id uuid not null references public.grader_suites (id),
  scope text not null check (scope in ('all', 'unfinished')),
  runs integer not null default 0 check (runs >= 0),
  skipped integer not null default 0 check (skipped >= 0),
  created_at timestamptz not null default now(),
  unique (institution_id, id),
  foreign key (institution_id, assignment_id) references public.assignments (institution_id, id) on delete cascade
);
create index run_batches_assignment_idx on public.run_batches (assignment_id, created_at desc);

alter table public.evaluation_runs
  add column batch_id uuid,
  add foreign key (institution_id, batch_id) references public.run_batches (institution_id, id) on delete set null (batch_id);
create index evaluation_runs_batch_idx on public.evaluation_runs (batch_id) where batch_id is not null;

create trigger audit after insert or update or delete on public.run_batches
  for each row execute function private.audit_row();

alter table public.run_batches enable row level security;
create policy run_batches_select on public.run_batches for select to authenticated
  using (private.is_course_staff((select a.course_id from public.assignments a where a.id = assignment_id)));
revoke insert, update, delete on public.run_batches from authenticated;
revoke all on public.run_batches from anon;

grant select (batch_id) on public.evaluation_runs to authenticated;

-- Deleting an institution (the records purge) also deletes its own suites and stack profiles,
-- and, through its submissions, the runs and assignments that used them. Checked statement by
-- statement, a suite's delete can be checked before its runs are gone; check at commit instead.
alter table public.run_batches alter constraint run_batches_grader_suite_id_fkey deferrable initially deferred;
alter table public.evaluation_runs alter constraint evaluation_runs_grader_suite_id_fkey deferrable initially deferred;
alter table public.evaluation_runs alter constraint evaluation_runs_stack_profile_id_fkey deferrable initially deferred;
alter table public.assignments alter constraint assignments_grader_suite_id_fkey deferrable initially deferred;
alter table public.assignments alter constraint assignments_stack_profile_id_fkey deferrable initially deferred;
alter table public.grader_suites alter constraint grader_suites_stack_profile_id_fkey deferrable initially deferred;
