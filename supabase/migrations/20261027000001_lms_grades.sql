-- ============================================================================
-- LMS integration, part 2: grades and rosters (docs/ARCHITECTURE.md §13.1). Platform
-- assignments are linked to LMS gradebook columns (AGS line items), released grades are sent
-- there, rosters come from NRPS, and a nightly reconciliation flags grades changed in the LMS.
-- The api and worker write everything; staff read what concerns their courses.
-- ============================================================================

-- A platform assignment's gradebook column in one LMS course.
create table public.lms_assignment_links (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  assignment_id uuid not null,
  lms_course_link_id uuid not null,
  -- Known once someone launches from the LMS link (deep linking creates it in the LMS).
  resource_link_id text,
  lineitem_url text,
  score_maximum numeric(7, 2) not null default 100 check (score_maximum > 0),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lms_course_link_id, assignment_id),
  unique (institution_id, id),
  foreign key (institution_id, assignment_id) references public.assignments (institution_id, id) on delete cascade,
  foreign key (institution_id, lms_course_link_id) references public.lms_course_links (institution_id, id) on delete cascade
);
create index lms_assignment_links_assignment_idx on public.lms_assignment_links (assignment_id);

-- Each released grade version sent to each linked gradebook column: idempotent per pair.
create table public.lms_grade_syncs (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  grade_id uuid not null,
  submission_id uuid not null,
  lms_assignment_link_id uuid not null,
  lms_user_id text,
  status text not null default 'pending'
    check (status in ('pending', 'synced', 'failed', 'skipped', 'conflict')),
  score_given numeric(7, 2),
  -- What the LMS gradebook showed at the last reconciliation (on the LMS's scale).
  lms_score numeric(7, 2),
  attempts integer not null default 0,
  last_error text,
  synced_at timestamptz,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (grade_id, lms_assignment_link_id),
  foreign key (institution_id, grade_id) references public.grades (institution_id, id) on delete cascade,
  foreign key (institution_id, submission_id) references public.submissions (institution_id, id) on delete cascade,
  foreign key (institution_id, lms_assignment_link_id)
    references public.lms_assignment_links (institution_id, id) on delete cascade
);
create index lms_grade_syncs_submission_idx on public.lms_grade_syncs (submission_id);
create index lms_grade_syncs_open_idx on public.lms_grade_syncs (status) where status in ('pending', 'failed', 'conflict');

-- The roster's last sync, per LMS course.
alter table public.lms_course_links
  add column roster_synced_at timestamptz,
  add column roster_summary jsonb;

-- A deep linking request waiting for the instructor to pick assignments (one hour, single use).
-- The token is the only credential of the picker page, which runs inside the LMS's frame.
create table public.lti_deep_link_requests (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  lms_connection_id uuid not null references public.lms_connections (id) on delete cascade,
  lms_course_link_id uuid references public.lms_course_links (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  deployment_id text not null,
  return_url text not null,
  data text,
  accept_multiple boolean not null default true,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create trigger set_updated_at before update on public.lms_assignment_links
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.lms_grade_syncs
  for each row execute function private.set_updated_at();
create trigger audit after insert or update or delete on public.lms_assignment_links
  for each row execute function private.audit_row();

alter table public.lms_assignment_links enable row level security;
alter table public.lms_grade_syncs enable row level security;
alter table public.lti_deep_link_requests enable row level security;

create policy lms_assignment_links_select on public.lms_assignment_links for select to authenticated
  using (private.has_institution_role(institution_id, '{admin}')
         or exists (select 1 from public.assignments a where a.id = assignment_id and private.is_course_staff(a.course_id)));
create policy lms_grade_syncs_select on public.lms_grade_syncs for select to authenticated
  using (private.has_institution_role(institution_id, '{admin}')
         or exists (select 1 from public.submissions s join public.assignments a on a.id = s.assignment_id
                    where s.id = submission_id and private.is_course_staff(a.course_id)));

revoke insert, update, delete on public.lms_assignment_links, public.lms_grade_syncs, public.lti_deep_link_requests
  from authenticated;
revoke all on public.lms_assignment_links, public.lms_grade_syncs, public.lti_deep_link_requests from anon;
