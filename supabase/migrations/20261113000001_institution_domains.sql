-- ============================================================================
-- Institution addresses (Phase 3E). Every institution can be reached at <slug>.<base domain>
-- when the platform sets INSTITUTION_BASE_DOMAIN; an admin can also add one vanity domain of
-- their own (projects.example.edu): they prove they control it with a DNS TXT record, then the
-- platform adds it to the hosting (Render's API, or the platform operator) and serves it.
--
-- People sign in on the platform's address; a one-time code hands a new session to the
-- institution's address (session_handoffs), so no sign-in provider needs to know it.
-- ============================================================================

create table public.institution_domains (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null unique references public.institutions (id) on delete cascade,
  hostname text not null unique check (
    char_length(hostname) <= 253
    and hostname ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
  ),
  -- pending: waiting for the TXT record; provisioning: ownership proven, the hosting is adding
  -- it (certificate, routing); active: served; failed: the hosting couldn't add it.
  status text not null default 'pending' check (status in ('pending', 'provisioning', 'active', 'failed')),
  verification_token text not null check (verification_token ~ '^[A-Za-z0-9_-]{20,64}$'),
  error text check (char_length(error) <= 1000),
  -- The hosting's id for the domain (a Render custom domain id).
  provider_id text,
  last_checked_at timestamptz,
  verified_at timestamptz,
  activated_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create trigger institution_domains_audit after insert or update or delete on public.institution_domains
  for each row execute function private.audit_row();

alter table public.institution_domains enable row level security;
create policy institution_domains_select on public.institution_domains for select to authenticated
  using (private.has_institution_role(institution_id, '{admin}') or (select private.is_super_admin()));
revoke insert, update, delete on public.institution_domains from authenticated;
revoke all on public.institution_domains from anon;

-- One-time codes that move a signed-in person to an institution's address. Only the server
-- reads and writes them (no policies); codes are stored hashed and live for a minute.
create table public.session_handoffs (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references auth.users (id) on delete cascade,
  host text not null check (char_length(host) <= 260),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index session_handoffs_expires on public.session_handoffs (expires_at);
alter table public.session_handoffs enable row level security;
revoke all on public.session_handoffs from anon, authenticated;
