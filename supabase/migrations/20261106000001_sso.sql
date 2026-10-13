-- ============================================================================
-- Single sign-on with the institution's identity provider (SAML 2.0, through Supabase Auth;
-- docs/ARCHITECTURE.md §4 and CONFIGURATION.md §5.3).
--
-- An institution's admins ask for it (their IdP's metadata and their email domains); the
-- platform operator turns it on after checking that the institution owns those domains, since
-- an IdP can assert any email address in them. Turning it on registers the IdP with Supabase
-- Auth; people then sign in through it with their institution email.
--
-- People signed in through an institution's IdP only accept invitations of that institution
-- (whatever email their IdP asserts), and can join it as students when it allows that.
-- ============================================================================

create function private.valid_domains(d text[]) returns boolean
language sql immutable set search_path = '' as $$
  select cardinality(d) between 1 and 10
     and not exists (select 1 from unnest(d) x where x !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$');
$$;

create table public.sso_connections (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null unique references public.institutions (id) on delete cascade,
  domains text[] not null check (private.valid_domains(domains)),
  metadata_url text check (metadata_url ~ '^https://'),
  metadata_xml text check (length(metadata_xml) <= 100000),
  status text not null default 'pending' check (status in ('pending', 'active', 'rejected', 'disabled')),
  -- The provider in Supabase Auth (set when the operator turns it on).
  supabase_provider_id uuid unique,
  join_as_student boolean not null default false,
  requested_by uuid references public.profiles (id) on delete set null,
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  review_note text check (length(review_note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (metadata_url is not null or metadata_xml is not null),
  check (status <> 'active' or supabase_provider_id is not null)
);

create trigger set_updated_at before update on public.sso_connections
  for each row execute function private.set_updated_at();
create trigger audit after insert or update or delete on public.sso_connections
  for each row execute function private.audit_row();

alter table public.sso_connections enable row level security;
create policy sso_connections_select on public.sso_connections for select to authenticated
  using (private.has_institution_role(institution_id, '{admin}') or (select private.is_super_admin()));
revoke insert, update, delete on public.sso_connections from authenticated;
revoke all on public.sso_connections from anon;

-- The institutions whose IdP signed this person in (none for email or GitHub sign-in).
create function private.sso_institution_ids(uid uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct c.institution_id), '{}')
  from auth.identities i
  join public.sso_connections c on i.provider = 'sso:' || c.supabase_provider_id::text
  where i.user_id = uid;
$$;

create or replace function public.accept_my_invitations() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  v_email text;
  v_email_confirmed timestamptz;
  v_login text;
  v_sso boolean;
  v_sso_institutions uuid[];
  inv record;
  conn record;
  accepted integer := 0;
begin
  if uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  select u.email, u.email_confirmed_at, coalesce(u.is_sso_user, false)
    into v_email, v_email_confirmed, v_sso
    from auth.users u where u.id = uid;
  select p.github_login into v_login from public.profiles p where p.id = uid;
  v_sso_institutions := private.sso_institution_ids(uid);

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
      -- An institution's IdP vouches for its own people only.
      and (not v_sso or i.institution_id = any (v_sso_institutions))
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

  -- Signed in through an institution's IdP that lets its people join as students.
  for conn in
    select c.institution_id, (inst.limits ->> 'max_active_students')::integer as cap
    from public.sso_connections c
    join public.institutions inst on inst.id = c.institution_id and inst.status = 'active'
    where c.status = 'active' and c.join_as_student and c.institution_id = any (v_sso_institutions)
      and not exists (select 1 from public.institution_memberships m
                      where m.institution_id = c.institution_id and m.user_id = uid)
  loop
    if conn.cap is null or (select count(*) from public.institution_memberships m
                            where m.institution_id = conn.institution_id and m.role = 'student'
                              and m.status = 'active') < conn.cap then
      insert into public.institution_memberships (institution_id, user_id, role)
      values (conn.institution_id, uid, 'student');
      accepted := accepted + 1;
    end if;
  end loop;

  return accepted;
end;
$$;
