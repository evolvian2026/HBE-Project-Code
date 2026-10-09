-- ============================================================================
-- Run artifacts (FR-5.4): files a test run leaves behind (the build log, the app's logs, the
-- output and JUnit report of the student's tests, screenshots and Playwright traces of failed
-- browser tests). The grader uploads them to the private bucket `run-artifacts` with signed
-- URLs; everyone who can see the run can download them. Artifacts of graded runs are kept for
-- the institution's retention period; others expire (profile retention.nonfinal_artifact_days).
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('run-artifacts', 'run-artifacts', false, 26214400,
   array['image/png', 'application/zip', 'text/plain', 'application/xml'])
on conflict (id) do nothing;

create table public.run_artifacts (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  run_id uuid not null,
  -- <stage>/<file>, e.g. ui/ui.add.png or logs/build.log
  name text not null check (name ~ '^[a-z0-9_-]{1,40}/[A-Za-z0-9_.-]{1,160}$'),
  path text not null unique,
  content_type text not null check (content_type in ('image/png', 'application/zip', 'text/plain', 'application/xml')),
  size bigint not null check (size >= 0),
  -- Null: kept for the institution's retention period (graded runs).
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (run_id, name),
  unique (institution_id, id),
  foreign key (institution_id, run_id) references public.evaluation_runs (institution_id, id) on delete cascade
);
create index run_artifacts_expiry_idx on public.run_artifacts (expires_at) where expires_at is not null;

alter table public.run_artifacts enable row level security;
create policy run_artifacts_select on public.run_artifacts for select to authenticated
  using (private.can_view_submission((select submission_id from public.evaluation_runs where id = run_id)));
revoke insert, update, delete on public.run_artifacts from authenticated;
revoke all on public.run_artifacts from anon;

-- A test's screenshot and trace: artifact names, e.g. {"screenshot": "ui/ui.add.png"}.
alter table public.test_results add column attachments jsonb;
grant select (attachments) on public.test_results to authenticated;

-- Downloads use signed URLs made with the user's own session: visible runs only.
create policy run_artifacts_objects_read on storage.objects for select to authenticated
  using (bucket_id = 'run-artifacts' and exists (select 1 from public.run_artifacts a where a.path = objects.name));
