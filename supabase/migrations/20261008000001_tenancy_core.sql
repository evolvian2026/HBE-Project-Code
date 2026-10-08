-- ============================================================================
-- Tenancy core: institutions, people, roles, memberships, courses, invitations,
-- audit log. See docs/ARCHITECTURE.md §4 and docs/DATA_MODEL.md.
--
-- Conventions
--   * Every tenant-owned table carries institution_id NOT NULL and has
--     unique (institution_id, id), so children reference parents with composite
--     foreign keys and can never point at another institution's rows.
--   * RLS is enabled on every table. Policy helpers live in the `private`
--     schema (not exposed through the Data API) and are SECURITY DEFINER.
--   * Server code (api/worker) connects as the table owner and bypasses RLS;
--     it must enforce permissions itself (packages/core).
-- ============================================================================

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.platform_role as enum ('super_admin');
-- Declaration order is privilege order: least(a, b) returns the stronger role.
create type public.institution_role as enum ('admin', 'teacher', 'student');
create type public.course_role as enum ('instructor', 'ta', 'student');
create type public.membership_status as enum ('active', 'deactivated');
create type public.institution_status as enum ('active', 'read_only', 'suspended', 'purged');

-- ---------------------------------------------------------------------------
-- Generic triggers
-- ---------------------------------------------------------------------------
create function private.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.institutions (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 2 and 200),
  slug text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$'),
  status public.institution_status not null default 'active',
  limits jsonb not null default '{}'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  contract_started_at timestamptz,
  contract_ended_at timestamptz,
  purge_after timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on column public.institutions.purge_after is
  'contract_ended_at + retention.contract_grace_years; set by the platform when the contract ends.';

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text,
  avatar_url text,
  -- Immutable numeric GitHub id: the key for commit/PR attribution. Never the login.
  github_user_id bigint unique,
  github_login text,
  status public.membership_status not null default 'active',
  anonymised_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_roles (
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.platform_role not null,
  granted_by uuid,
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

create table public.institution_memberships (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.institution_role not null,
  status public.membership_status not null default 'active',
  external_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (institution_id, user_id),
  unique (institution_id, id)
);
create index institution_memberships_user_idx on public.institution_memberships (user_id);

create table public.courses (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete cascade,
  code text not null check (length(btrim(code)) between 1 and 50),
  name text not null check (length(btrim(name)) between 2 and 200),
  term text not null check (length(btrim(term)) between 1 and 50),
  timezone text not null default 'Asia/Singapore',
  archived_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (institution_id, id),
  unique (institution_id, code, term)
);

create table public.course_memberships (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  course_id uuid not null,
  user_id uuid not null,
  role public.course_role not null,
  section text,
  source text not null default 'manual' check (source in ('manual', 'csv', 'lms', 'invitation')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (course_id, user_id),
  unique (institution_id, id),
  -- Composite keys: the course and the person must both belong to this institution.
  foreign key (institution_id, course_id) references public.courses (institution_id, id) on delete cascade,
  foreign key (institution_id, user_id) references public.institution_memberships (institution_id, user_id) on delete cascade
);
create index course_memberships_user_idx on public.course_memberships (user_id);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete cascade,
  email text check (email is null or email ~ '^[^@\s]+@[^@\s]+$'),
  github_login text check (github_login is null or github_login ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$'),
  role public.institution_role not null,
  course_id uuid,
  course_role public.course_role,
  token_hash text unique,
  invited_by uuid references public.profiles (id) on delete set null,
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  accepted_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (institution_id, id),
  check (email is not null or github_login is not null),
  check ((course_id is null) = (course_role is null)),
  foreign key (institution_id, course_id) references public.courses (institution_id, id) on delete cascade
);
create index invitations_institution_idx on public.invitations (institution_id);
create index invitations_pending_email_idx on public.invitations (lower(email)) where accepted_at is null;
create index invitations_pending_login_idx on public.invitations (lower(github_login)) where accepted_at is null;

-- Append-only. No FK on institution_id on purpose: rows must survive the
-- statement that deletes their institution (purge removes them explicitly).
create table public.audit_logs (
  id bigint generated always as identity primary key,
  institution_id uuid,
  actor_id uuid,
  action text not null,
  entity text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  ip inet,
  at timestamptz not null default now()
);
create index audit_logs_institution_at_idx on public.audit_logs (institution_id, at desc);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create trigger set_updated_at before update on public.institutions
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.institution_memberships
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.courses
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.course_memberships
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Audit trigger. Actor = hbe.actor_id (set by server code) or the JWT subject.
-- TG_ARGV[0] names the column holding the institution id (default institution_id).
-- ---------------------------------------------------------------------------
create function private.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rec jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  inst_col text := coalesce(tg_argv[0], 'institution_id');
begin
  insert into public.audit_logs (institution_id, actor_id, action, entity, entity_id, before, after)
  values (
    nullif(rec ->> inst_col, '')::uuid,
    coalesce(nullif(current_setting('hbe.actor_id', true), '')::uuid, auth.uid()),
    lower(tg_op),
    tg_table_name,
    coalesce(rec ->> 'id', rec ->> 'user_id'),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  return null;
end;
$$;

create trigger audit after insert or update or delete on public.institutions
  for each row execute function private.audit_row('id');
create trigger audit after insert or update or delete on public.user_roles
  for each row execute function private.audit_row('-');
create trigger audit after insert or update or delete on public.institution_memberships
  for each row execute function private.audit_row();
create trigger audit after insert or update or delete on public.course_memberships
  for each row execute function private.audit_row();
create trigger audit after insert or update or delete on public.invitations
  for each row execute function private.audit_row();

-- ---------------------------------------------------------------------------
-- RLS helpers (SECURITY DEFINER avoids recursive policy evaluation)
-- ---------------------------------------------------------------------------
create function private.is_super_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.user_roles
    where user_id = (select auth.uid()) and role = 'super_admin'
  );
$$;

-- Institutions where the caller is an active member and the institution is usable.
create function private.my_institution_ids() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(m.institution_id), '{}')
  from public.institution_memberships m
  join public.institutions i on i.id = m.institution_id
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and i.status in ('active', 'read_only');
$$;

create function private.has_institution_role(iid uuid, roles public.institution_role[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.institution_memberships m
    join public.institutions i on i.id = m.institution_id
    where m.institution_id = iid
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and m.role = any (roles)
      and i.status in ('active', 'read_only')
  );
$$;

create function private.has_course_role(cid uuid, roles public.course_role[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.course_memberships cm
    join public.institution_memberships m
      on m.institution_id = cm.institution_id and m.user_id = cm.user_id
    join public.institutions i on i.id = cm.institution_id
    where cm.course_id = cid
      and cm.user_id = (select auth.uid())
      and cm.role = any (roles)
      and m.status = 'active'
      and i.status in ('active', 'read_only')
  );
$$;

-- Read-only and suspended institutions accept no writes from users.
create function private.institution_is_writable(iid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.institutions where id = iid and status = 'active');
$$;

grant execute on all functions in schema private to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------

-- An institution must always keep at least one active admin (except while it is being deleted).
create function private.protect_last_admin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'admin' and old.status = 'active'
     and (tg_op = 'DELETE' or new.role <> 'admin' or new.status <> 'active')
     and not exists (
       select 1 from public.institution_memberships m
       where m.institution_id = old.institution_id and m.id <> old.id
         and m.role = 'admin' and m.status = 'active')
     and exists (select 1 from public.institutions i where i.id = old.institution_id)
  then
    raise exception 'An institution must keep at least one active admin'
      using errcode = 'P0001', hint = 'Promote another member to admin first.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger protect_last_admin before update or delete on public.institution_memberships
  for each row execute function private.protect_last_admin();

-- The user who creates a course becomes its instructor.
create function private.add_course_creator() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null then
    insert into public.course_memberships (institution_id, course_id, user_id, role)
    values (new.institution_id, new.id, auth.uid(), 'instructor')
    on conflict (course_id, user_id) do nothing;
  end if;
  return null;
end;
$$;

create trigger add_course_creator after insert on public.courses
  for each row execute function private.add_course_creator();

create function private.set_created_by() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.created_by := coalesce(new.created_by, auth.uid());
  return new;
end;
$$;

create trigger set_created_by before insert on public.courses
  for each row execute function private.set_created_by();
create trigger set_created_by before insert on public.institutions
  for each row execute function private.set_created_by();

-- ---------------------------------------------------------------------------
-- Profiles from Supabase Auth
-- ---------------------------------------------------------------------------
create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do update
    set email = excluded.email,
        full_name = coalesce(public.profiles.full_name, excluded.full_name),
        avatar_url = coalesce(public.profiles.avatar_url, excluded.avatar_url);
  return null;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

create function private.sync_user_email() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return null;
end;
$$;

create trigger on_auth_user_email_changed after update of email on auth.users
  for each row when (old.email is distinct from new.email)
  execute function private.sync_user_email();

-- Linking a GitHub identity (at sign-up or later) records the immutable GitHub id.
create function private.sync_github_identity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.provider = 'github' then
    insert into public.profiles (id, github_user_id, github_login)
    values (new.user_id, new.provider_id::bigint, new.identity_data ->> 'user_name')
    on conflict (id) do update
      set github_user_id = excluded.github_user_id,
          github_login = excluded.github_login;
  end if;
  return null;
end;
$$;

create trigger on_auth_identity_linked after insert or update on auth.identities
  for each row execute function private.sync_github_identity();

-- ---------------------------------------------------------------------------
-- Invitations: accept every pending invitation matching the caller's verified
-- email or linked GitHub login. Called by the web app after sign-in.
-- ---------------------------------------------------------------------------
create function public.accept_my_invitations() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  v_email text;
  v_email_confirmed timestamptz;
  v_login text;
  inv record;
  accepted integer := 0;
begin
  if uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  select u.email, u.email_confirmed_at into v_email, v_email_confirmed from auth.users u where u.id = uid;
  select p.github_login into v_login from public.profiles p where p.id = uid;

  for inv in
    select i.*
    from public.invitations i
    join public.institutions inst on inst.id = i.institution_id and inst.status = 'active'
    where i.accepted_at is null
      and i.expires_at > now()
      and (
        (v_email_confirmed is not null and lower(i.email) = lower(v_email))
        or (v_login is not null and lower(i.github_login) = lower(v_login))
      )
    for update of i skip locked
  loop
    insert into public.institution_memberships (institution_id, user_id, role)
    values (inv.institution_id, uid, inv.role)
    on conflict (institution_id, user_id) do update
      set status = 'active',
          -- keep the stronger of the existing and invited roles (enum order)
          role = least(public.institution_memberships.role, excluded.role);

    if inv.course_id is not null then
      insert into public.course_memberships (institution_id, course_id, user_id, role, source)
      values (inv.institution_id, inv.course_id, uid, inv.course_role, 'invitation')
      on conflict (course_id, user_id) do nothing;
    end if;

    update public.invitations set accepted_at = now(), accepted_by = uid where id = inv.id;
    accepted := accepted + 1;
  end loop;

  return accepted;
end;
$$;

revoke execute on function public.accept_my_invitations() from public, anon;
grant execute on function public.accept_my_invitations() to authenticated;

-- ---------------------------------------------------------------------------
-- Custom Access Token Hook: adds platform_role and institutions to the JWT.
-- Used by the UI for routing only; authorisation always re-checks the database.
-- ---------------------------------------------------------------------------
create function public.custom_access_token_hook(event jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  uid uuid := (event ->> 'user_id')::uuid;
  claims jsonb := coalesce(event -> 'claims', '{}'::jsonb);
  is_super boolean;
  insts jsonb;
begin
  select exists (select 1 from public.user_roles where user_id = uid and role = 'super_admin')
    into is_super;

  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'slug', i.slug, 'role', m.role) order by i.name), '[]'::jsonb)
    into insts
    from public.institution_memberships m
    join public.institutions i on i.id = m.institution_id
   where m.user_id = uid and m.status = 'active' and i.status in ('active', 'read_only');

  claims := jsonb_set(claims, '{platform_role}', case when is_super then '"super_admin"'::jsonb else 'null'::jsonb end);
  claims := jsonb_set(claims, '{institutions}', insts);
  return jsonb_set(event, '{claims}', claims);
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;
grant select on public.user_roles, public.institution_memberships, public.institutions to supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.institutions enable row level security;
alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.institution_memberships enable row level security;
alter table public.courses enable row level security;
alter table public.course_memberships enable row level security;
alter table public.invitations enable row level security;
alter table public.audit_logs enable row level security;

-- The auth server reads these to build JWT claims.
create policy auth_admin_read on public.user_roles for select to supabase_auth_admin using (true);
create policy auth_admin_read on public.institution_memberships for select to supabase_auth_admin using (true);
create policy auth_admin_read on public.institutions for select to supabase_auth_admin using (true);

-- institutions
create policy institutions_select on public.institutions for select to authenticated
  using ((select private.is_super_admin()) or id = any ((select private.my_institution_ids())::uuid[]));
create policy institutions_insert on public.institutions for insert to authenticated
  with check ((select private.is_super_admin()));
create policy institutions_update on public.institutions for update to authenticated
  using ((select private.is_super_admin()))
  with check ((select private.is_super_admin()));

-- profiles: yourself, plus people you administer or teach
create policy profiles_select on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or exists (
      select 1 from public.institution_memberships target
      where target.user_id = profiles.id
        and private.has_institution_role(target.institution_id, '{admin,teacher}'))
    or exists (
      select 1 from public.course_memberships cm
      where cm.user_id = profiles.id
        and private.has_course_role(cm.course_id, '{instructor,ta}'))
  );
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));
-- Only cosmetic fields are user-editable; GitHub identity and status are not.
revoke insert, update, delete on public.profiles from authenticated;
grant update (full_name, avatar_url) on public.profiles to authenticated;

-- user_roles: read your own; super admins read all; writes go through the API
create policy user_roles_select on public.user_roles for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_super_admin()));
revoke insert, update, delete on public.user_roles from authenticated;

-- institution_memberships
create policy memberships_select on public.institution_memberships for select to authenticated
  using (
    (user_id = (select auth.uid()) and institution_id = any ((select private.my_institution_ids())::uuid[]))
    or private.has_institution_role(institution_id, '{admin,teacher}')
  );
create policy memberships_insert on public.institution_memberships for insert to authenticated
  with check (private.has_institution_role(institution_id, '{admin}') and private.institution_is_writable(institution_id));
create policy memberships_update on public.institution_memberships for update to authenticated
  using (private.has_institution_role(institution_id, '{admin}') and private.institution_is_writable(institution_id))
  with check (private.has_institution_role(institution_id, '{admin}'));
create policy memberships_delete on public.institution_memberships for delete to authenticated
  using (private.has_institution_role(institution_id, '{admin}') and private.institution_is_writable(institution_id));

-- courses
create policy courses_select on public.courses for select to authenticated
  using (
    private.has_institution_role(institution_id, '{admin,teacher}')
    or private.has_course_role(id, '{instructor,ta,student}')
  );
create policy courses_insert on public.courses for insert to authenticated
  with check (private.has_institution_role(institution_id, '{admin,teacher}') and private.institution_is_writable(institution_id));
create policy courses_update on public.courses for update to authenticated
  using (
    (private.has_institution_role(institution_id, '{admin}') or private.has_course_role(id, '{instructor}'))
    and private.institution_is_writable(institution_id))
  with check (private.has_institution_role(institution_id, '{admin}') or private.has_course_role(id, '{instructor}'));
create policy courses_delete on public.courses for delete to authenticated
  using (private.has_institution_role(institution_id, '{admin}') and private.institution_is_writable(institution_id));

-- course_memberships
create policy course_memberships_select on public.course_memberships for select to authenticated
  using (
    (user_id = (select auth.uid()) and institution_id = any ((select private.my_institution_ids())::uuid[]))
    or private.has_institution_role(institution_id, '{admin}')
    or private.has_course_role(course_id, '{instructor,ta}')
  );
create policy course_memberships_insert on public.course_memberships for insert to authenticated
  with check (
    (private.has_institution_role(institution_id, '{admin}') or private.has_course_role(course_id, '{instructor}'))
    and private.institution_is_writable(institution_id));
create policy course_memberships_update on public.course_memberships for update to authenticated
  using (
    (private.has_institution_role(institution_id, '{admin}') or private.has_course_role(course_id, '{instructor}'))
    and private.institution_is_writable(institution_id))
  with check (private.has_institution_role(institution_id, '{admin}') or private.has_course_role(course_id, '{instructor}'));
create policy course_memberships_delete on public.course_memberships for delete to authenticated
  using (
    (private.has_institution_role(institution_id, '{admin}') or private.has_course_role(course_id, '{instructor}'))
    and private.institution_is_writable(institution_id));

-- invitations: institution admins; super admins may invite an institution's admins
create policy invitations_select on public.invitations for select to authenticated
  using (
    private.has_institution_role(institution_id, '{admin}')
    or (role = 'admin' and (select private.is_super_admin()))
  );
create policy invitations_insert on public.invitations for insert to authenticated
  with check (
    (private.has_institution_role(institution_id, '{admin}') and private.institution_is_writable(institution_id))
    or (role = 'admin' and (select private.is_super_admin()))
  );
create policy invitations_delete on public.invitations for delete to authenticated
  using (private.has_institution_role(institution_id, '{admin}') and accepted_at is null);

-- audit_logs: institution admins see their institution; super admins see platform rows
create policy audit_logs_select on public.audit_logs for select to authenticated
  using (
    (institution_id is null and (select private.is_super_admin()))
    or (institution_id is not null and private.has_institution_role(institution_id, '{admin}'))
  );
revoke insert, update, delete, truncate on public.audit_logs from authenticated, service_role;

-- Anonymous visitors get nothing from these tables, even before RLS.
revoke all on all tables in schema public from anon;
