-- ============================================================================
-- Records: versioned grade reports (JSON + PDF) and source snapshots of graded commits,
-- stored in private Storage buckets. See docs/ARCHITECTURE.md §12.
-- Only the platform (service role) writes; users read what they may see through RLS, and
-- download through short-lived signed URLs created with their own session.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('grade-reports', 'grade-reports', false, 10485760, array['application/json', 'application/pdf']),
  ('submission-archive', 'submission-archive', false, 262144000,
   array['application/octet-stream', 'application/gzip', 'application/x-git-bundle'])
on conflict (id) do nothing;

-- One immutable report per released grade version.
create table public.grade_reports (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  submission_id uuid not null,
  grade_id uuid not null unique references public.grades (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  version integer not null check (version > 0),
  grade_version integer not null,
  json_path text not null unique,
  pdf_path text not null unique,
  -- SHA-256 of the JSON as stored: tamper evidence, printed in the PDF.
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  pdf_sha256 text not null check (pdf_sha256 ~ '^[0-9a-f]{64}$'),
  generated_at timestamptz not null default now(),
  unique (submission_id, version),
  unique (institution_id, id),
  foreign key (institution_id, submission_id) references public.submissions (institution_id, id) on delete cascade
);
create index grade_reports_user_idx on public.grade_reports (institution_id, user_id);

-- Source of each graded commit, archived by the grader job (git bundle and tarball).
create table public.submission_snapshots (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  submission_id uuid not null,
  run_id uuid references public.evaluation_runs (id) on delete set null,
  sha text not null check (sha ~ '^[0-9a-f]{40}$'),
  bundle_path text not null unique,
  bundle_sha256 text not null check (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  bundle_size bigint not null check (bundle_size >= 0),
  tarball_path text not null unique,
  tarball_sha256 text not null check (tarball_sha256 ~ '^[0-9a-f]{64}$'),
  tarball_size bigint not null check (tarball_size >= 0),
  created_at timestamptz not null default now(),
  unique (submission_id, sha),
  unique (institution_id, id),
  foreign key (institution_id, submission_id) references public.submissions (institution_id, id) on delete cascade
);

alter table public.grade_reports enable row level security;
alter table public.submission_snapshots enable row level security;

-- Staff of the course see every report; the student sees reports of released versions.
create policy grade_reports_select on public.grade_reports for select to authenticated
  using (
    private.is_course_staff((select a.course_id from public.submissions s join public.assignments a on a.id = s.assignment_id
                             where s.id = submission_id))
    or (private.grade_visible(submission_id)
        and exists (select 1 from public.grades g where g.id = grade_id and g.released_at is not null))
  );
create policy submission_snapshots_select on public.submission_snapshots for select to authenticated
  using (private.can_view_submission(submission_id));

revoke insert, update, delete on public.grade_reports, public.submission_snapshots from authenticated;
revoke all on public.grade_reports, public.submission_snapshots from anon;

-- Objects are readable exactly when their record is (the subqueries run under the reader's RLS).
create policy records_objects_read on storage.objects for select to authenticated
  using (
    (bucket_id = 'grade-reports'
     and exists (select 1 from public.grade_reports r where r.json_path = name or r.pdf_path = name))
    or (bucket_id = 'submission-archive'
        and exists (select 1 from public.submission_snapshots x where x.bundle_path = name or x.tarball_path = name))
  );
