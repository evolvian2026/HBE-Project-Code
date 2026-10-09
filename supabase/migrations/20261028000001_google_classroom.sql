-- ============================================================================
-- LMS integration, part 3: Google Classroom (docs/ARCHITECTURE.md §13). Teachers connect their
-- Google account (the platform's OAuth client; their refresh token is stored encrypted), link
-- Classroom classes to courses, and post assignments as Classroom coursework, which is where
-- grades are written. Rosters and grade syncs reuse the LTI tables.
-- ============================================================================

-- One Google Classroom connection per institution (an admin turns it on).
create unique index lms_connections_google_idx on public.lms_connections (institution_id)
  where type = 'google_classroom';

-- A teacher's Google account, as their consent gave it to the platform.
create table public.google_accounts (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  profile_id uuid not null,
  google_user_id text not null,
  email text,
  -- AES-256-GCM under TOKEN_ENCRYPTION_KEY (apps/server/src/secrets.ts); never readable by users.
  refresh_token_encrypted text not null,
  scopes text[] not null default '{}',
  connected_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_error text,
  unique (institution_id, profile_id),
  unique (institution_id, id),
  foreign key (institution_id, profile_id) references public.institution_memberships (institution_id, user_id)
    on delete cascade
);

-- OAuth state of a consent in progress (ten minutes, single use, with the PKCE verifier).
create table public.google_oauth_states (
  state text primary key,
  institution_id uuid not null references public.institutions (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  code_verifier text not null,
  next text not null,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);

-- Whose Google access a linked class uses (the teacher who linked it).
alter table public.lms_course_links
  add column google_account_id uuid,
  add foreign key (institution_id, google_account_id) references public.google_accounts (institution_id, id)
    on delete set null (google_account_id);

-- The Classroom coursework made for an assignment (grades go there).
alter table public.lms_assignment_links
  add column classroom_coursework_id text,
  add column classroom_link text;

-- Not audited row by row: the audit log keeps whole rows, and this one holds a token.
alter table public.google_accounts enable row level security;
alter table public.google_oauth_states enable row level security;

-- People see their own connection, admins their institution's; never the token.
create policy google_accounts_select on public.google_accounts for select to authenticated
  using ((profile_id = (select auth.uid()) and institution_id = any ((select private.my_institution_ids())::uuid[]))
         or private.has_institution_role(institution_id, '{admin}'));
revoke all on public.google_accounts, public.google_oauth_states from anon, authenticated;
-- OAuth states: RLS without policies, so selects find nothing (and nobody writes).
grant select on public.google_oauth_states to authenticated;
grant select (id, institution_id, profile_id, google_user_id, email, scopes, connected_at, revoked_at, last_error)
  on public.google_accounts to authenticated;
