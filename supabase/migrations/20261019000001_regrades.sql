-- ============================================================================
-- Regrade requests (FR-6.7): after release, a student asks for a regrade with a message
-- (within the assignment's regrade window, one open request at a time); course staff
-- accept or decline it with a response. Accepting doesn't change the grade by itself: staff
-- adjust the rubric or override, which makes a new (released) grade version.
-- Written through the API, which also notifies staff and the student.
-- ============================================================================

-- Days after release during which students may ask for a regrade (0 = not offered).
alter table public.assignments
  add column regrade_window_days integer not null default 7 check (regrade_window_days between 0 and 60);
grant insert (regrade_window_days), update (regrade_window_days) on public.assignments to authenticated;

create table public.regrade_requests (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  submission_id uuid not null,
  requested_by uuid references public.profiles (id) on delete set null,
  message text not null check (length(trim(message)) between 10 and 2000),
  status text not null default 'open' check (status in ('open', 'accepted', 'declined', 'withdrawn')),
  response text check (length(response) <= 2000),
  resolved_by uuid references public.profiles (id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (institution_id, id),
  foreign key (institution_id, submission_id) references public.submissions (institution_id, id) on delete cascade,
  check ((status = 'open') = (resolved_at is null)),
  check (status not in ('accepted', 'declined') or length(trim(response)) >= 5)
);
create unique index regrade_requests_one_open_idx on public.regrade_requests (submission_id) where status = 'open';
create index regrade_requests_submission_idx on public.regrade_requests (submission_id, created_at desc);

create trigger set_updated_at before update on public.regrade_requests
  for each row execute function private.set_updated_at();
create trigger audit after insert or update or delete on public.regrade_requests
  for each row execute function private.audit_row();

alter table public.regrade_requests enable row level security;
-- Course staff, and the student (requests only exist once the grade is released).
create policy regrade_requests_select on public.regrade_requests for select to authenticated
  using (private.grade_visible(submission_id));
revoke insert, update, delete on public.regrade_requests from authenticated;
revoke all on public.regrade_requests from anon;

alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (
  type in ('run_finished', 'grade_released', 'deadline_soon', 'extension_granted', 'regrade_requested', 'regrade_answered')
);
