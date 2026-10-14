-- ============================================================================
-- Similar code between submissions (Phase 3C). Course staff ask for a check of an assignment;
-- the worker compares the graded commits' archived source (submission_snapshots), leaving out
-- the starter code and what most submissions share, and keeps the pairs that look alike with
-- the passages that match. For staff only, and never part of a grade: similar code is a
-- reason to look, not proof. Algorithm: packages/core/src/similarity.ts.
-- ============================================================================

create table public.similarity_reports (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  assignment_id uuid not null,
  requested_by uuid references public.profiles (id) on delete set null,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  error text check (char_length(error) <= 2000),
  -- Repositories compared (a team's counts once), and why others weren't.
  compared integer not null default 0 check (compared >= 0),
  skipped jsonb not null default '[]'::jsonb check (jsonb_typeof(skipped) = 'array'),
  -- Whether the starter code could be read (and so left out).
  starter_excluded boolean not null default false,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (institution_id, id),
  foreign key (institution_id, assignment_id) references public.assignments (institution_id, id) on delete cascade
);
create index similarity_reports_assignment on public.similarity_reports (assignment_id, created_at desc);
-- One check at a time per assignment.
create unique index similarity_reports_one_active on public.similarity_reports (assignment_id)
  where status in ('queued', 'running');

create table public.similarity_pairs (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  report_id uuid not null,
  submission_a uuid not null,
  submission_b uuid not null,
  -- The share of the smaller submission's distinctive code also found in the other (0–1).
  score numeric(4, 3) not null check (score between 0 and 1),
  shared integer not null check (shared > 0),
  -- Matching passages: [{a: {path, from, to}, b: {path, from, to}, fingerprints}], longest first.
  matches jsonb not null default '[]'::jsonb check (jsonb_typeof(matches) = 'array'),
  check (submission_a <> submission_b),
  foreign key (institution_id, report_id) references public.similarity_reports (institution_id, id) on delete cascade,
  foreign key (institution_id, submission_a) references public.submissions (institution_id, id) on delete cascade,
  foreign key (institution_id, submission_b) references public.submissions (institution_id, id) on delete cascade
);
create index similarity_pairs_report on public.similarity_pairs (report_id, score desc);
create index similarity_pairs_a on public.similarity_pairs (submission_a);
create index similarity_pairs_b on public.similarity_pairs (submission_b);

alter table public.similarity_reports enable row level security;
alter table public.similarity_pairs enable row level security;

-- Course staff of the assignment only; the platform's server writes.
create policy similarity_reports_select on public.similarity_reports for select to authenticated
  using (assignment_id in (select private.staff_assignment_ids()));
create policy similarity_pairs_select on public.similarity_pairs for select to authenticated
  using (exists (select 1 from public.similarity_reports r where r.id = report_id));

revoke all on public.similarity_reports, public.similarity_pairs from anon;
revoke insert, update, delete on public.similarity_reports, public.similarity_pairs from authenticated;
grant select on public.similarity_reports, public.similarity_pairs to authenticated;
