-- ============================================================================
-- LMS integration, part 1: LTI 1.3 (docs/ARCHITECTURE.md §13). Each institution registers its
-- LMS (Canvas, Moodle, …) as a platform; launches sign people in and land them in the linked
-- course. Everything is written by the API; users read what concerns them.
-- ============================================================================

create table public.lms_connections (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete cascade,
  type text not null check (type in ('canvas', 'moodle', 'lti', 'google_classroom')),
  name text not null check (length(trim(name)) between 1 and 120),
  status text not null default 'active' check (status in ('active', 'disabled')),
  -- LTI 1.3 platform details.
  issuer text,
  client_id text,
  deployment_ids text[] not null default '{}',
  auth_login_url text,
  auth_token_url text,
  jwks_url text,
  -- What dynamic registration returned (for support), and how the connection was made.
  registration jsonb,
  registered_by text not null default 'manual' check (registered_by in ('manual', 'dynamic')),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (institution_id, id),
  check (type = 'google_classroom' or (issuer is not null and client_id is not null and auth_login_url is not null
                                        and auth_token_url is not null and jwks_url is not null))
);
-- One registration per platform and client across all institutions: a launch identifies it.
create unique index lms_connections_platform_idx on public.lms_connections (issuer, client_id) where issuer is not null;

-- LMS users, matched to platform profiles. A null profile waits for an admin.
create table public.lms_user_links (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  lms_connection_id uuid not null,
  lms_user_id text not null,
  profile_id uuid references public.profiles (id) on delete cascade,
  email text,
  name text,
  matched_by text check (matched_by in ('email', 'admin', 'launch')),
  status text not null default 'linked' check (status in ('linked', 'pending', 'rejected')),
  last_launch_at timestamptz,
  created_at timestamptz not null default now(),
  unique (lms_connection_id, lms_user_id),
  foreign key (institution_id, lms_connection_id) references public.lms_connections (institution_id, id) on delete cascade,
  check ((status = 'linked') = (profile_id is not null))
);
create index lms_user_links_profile_idx on public.lms_user_links (profile_id);

-- LMS courses (LTI contexts), linked to platform courses by an instructor. A null course waits.
create table public.lms_course_links (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  lms_connection_id uuid not null,
  context_id text not null,
  context_title text,
  course_id uuid,
  -- LTI Advantage service endpoints seen in launches.
  nrps_url text,
  ags_lineitems_url text,
  linked_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lms_connection_id, context_id),
  unique (institution_id, id),
  foreign key (institution_id, lms_connection_id) references public.lms_connections (institution_id, id) on delete cascade,
  foreign key (institution_id, course_id) references public.courses (institution_id, id) on delete cascade
);
create index lms_course_links_course_idx on public.lms_course_links (course_id);

-- OIDC login state: single use, ten minutes (replay protection for launches).
create table public.lti_launch_states (
  state text primary key,
  nonce text not null,
  lms_connection_id uuid not null references public.lms_connections (id) on delete cascade,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);

-- One-time dynamic registration URLs an admin hands to their LMS.
create table public.lti_registration_invites (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete cascade,
  token_hash text not null unique,
  type text not null check (type in ('canvas', 'moodle', 'lti')),
  name text not null,
  created_by uuid references public.profiles (id) on delete set null,
  expires_at timestamptz not null,
  used_at timestamptz,
  lms_connection_id uuid references public.lms_connections (id) on delete set null,
  created_at timestamptz not null default now()
);

create trigger set_updated_at before update on public.lms_connections
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.lms_course_links
  for each row execute function private.set_updated_at();
create trigger audit after insert or update or delete on public.lms_connections
  for each row execute function private.audit_row();
create trigger audit after insert or update or delete on public.lms_user_links
  for each row execute function private.audit_row();
create trigger audit after insert or update or delete on public.lms_course_links
  for each row execute function private.audit_row();

alter table public.lms_connections enable row level security;
alter table public.lms_user_links enable row level security;
alter table public.lms_course_links enable row level security;
alter table public.lti_launch_states enable row level security;
alter table public.lti_registration_invites enable row level security;

-- Staff see their institution's connections (they hold no secrets).
create policy lms_connections_select on public.lms_connections for select to authenticated
  using (private.has_institution_role(institution_id, '{admin,teacher}'));
-- Admins see every link (and the review queue); people see their own.
create policy lms_user_links_select on public.lms_user_links for select to authenticated
  using ((profile_id = (select auth.uid()) and institution_id = any ((select private.my_institution_ids())::uuid[]))
         or private.has_institution_role(institution_id, '{admin}'));
-- Teachers see LMS courses nobody has linked yet, to link their own.
create policy lms_course_links_select on public.lms_course_links for select to authenticated
  using (private.has_institution_role(institution_id, '{admin}')
         or (course_id is null and private.has_institution_role(institution_id, '{teacher}'))
         or (course_id is not null and private.is_course_staff(course_id)));

revoke insert, update, delete on public.lms_connections, public.lms_user_links, public.lms_course_links,
  public.lti_launch_states, public.lti_registration_invites from authenticated;
revoke all on public.lms_connections, public.lms_user_links, public.lms_course_links,
  public.lti_launch_states, public.lti_registration_invites from anon;
