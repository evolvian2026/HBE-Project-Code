-- ============================================================================
-- GitHub App installations, the webhook inbox, and linking an installation to
-- an institution. See docs/ARCHITECTURE.md §5.
--
-- Linking is proven by the signed webhook, not by the setup redirect (whose
-- query string can be forged): an institution admin with a linked GitHub
-- account creates a link request; when GitHub delivers `installation.created`
-- whose sender is that same GitHub user, the worker maps the installation.
-- ============================================================================

create table public.github_installations (
  id uuid primary key default gen_random_uuid(),
  -- Null until linked to an institution. Events for unlinked installations are stored, not processed.
  institution_id uuid references public.institutions (id) on delete set null,
  installation_id bigint not null unique,
  account_id bigint not null,
  account_login text not null,
  account_type text not null check (account_type in ('Organization', 'User', 'Enterprise')),
  repository_selection text,
  permissions jsonb not null default '{}'::jsonb,
  events text[] not null default '{}',
  suspended_at timestamptz,
  deleted_at timestamptz,
  linked_at timestamptz,
  linked_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (institution_id, id)
);
create index github_installations_institution_idx on public.github_installations (institution_id);

create trigger set_updated_at before update on public.github_installations
  for each row execute function private.set_updated_at();
create trigger audit after insert or update or delete on public.github_installations
  for each row execute function private.audit_row();

create table public.github_link_requests (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete cascade,
  requested_by uuid not null references public.profiles (id) on delete cascade,
  github_user_id bigint not null,
  expires_at timestamptz not null default now() + interval '1 hour',
  completed_at timestamptz,
  installation_id bigint,
  created_at timestamptz not null default now(),
  unique (institution_id, id)
);
create index github_link_requests_pending_idx on public.github_link_requests (github_user_id)
  where completed_at is null;

-- Raw webhook inbox. Persist first, process later (idempotent on delivery_id).
create table public.github_events (
  id bigint generated always as identity primary key,
  delivery_id text not null unique,
  event text not null,
  action text,
  installation_id bigint,
  institution_id uuid references public.institutions (id) on delete cascade,
  repository_full_name text,
  sender_id bigint,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  attempts integer not null default 0,
  error text
);
create index github_events_unprocessed_idx on public.github_events (received_at) where processed_at is null;
create index github_events_installation_idx on public.github_events (installation_id, received_at desc);

-- Courses use one of their institution's GitHub installations (composite FK keeps it in-tenant).
alter table public.courses
  add column github_installation_id uuid,
  add constraint courses_github_installation_fk
    foreign key (institution_id, github_installation_id)
    references public.github_installations (institution_id, id);

-- ---------------------------------------------------------------------------
-- RLS: reads only; all writes come from the api/worker.
-- ---------------------------------------------------------------------------
alter table public.github_installations enable row level security;
alter table public.github_link_requests enable row level security;
alter table public.github_events enable row level security;

create policy github_installations_select on public.github_installations for select to authenticated
  using (
    (select private.is_super_admin())
    or (institution_id is not null and private.has_institution_role(institution_id, '{admin,teacher}'))
  );

create policy github_link_requests_select on public.github_link_requests for select to authenticated
  using (private.has_institution_role(institution_id, '{admin}'));

create policy github_events_select on public.github_events for select to authenticated
  using ((select private.is_super_admin()));

revoke insert, update, delete on public.github_installations, public.github_link_requests, public.github_events
  from authenticated;
revoke all on public.github_installations, public.github_link_requests, public.github_events from anon;
