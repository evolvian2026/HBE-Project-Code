-- ============================================================================
-- Two-factor authentication for admins (FR-1.3).
--
-- Admin powers (institution admin, super admin) only apply to sessions that
-- passed MFA (JWT aal = aal2). An admin signed in with one factor keeps their
-- membership but acts with no admin privileges until they complete MFA.
-- Enforced here, so a password-only session can't use the Data API directly.
-- ============================================================================

create table public.platform_settings (
  key text primary key,
  value jsonb not null,
  description text,
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.platform_settings (key, value, description) values
  ('require_admin_mfa', 'true', 'Admins must pass two-factor authentication before using admin powers.');

create trigger set_updated_at before update on public.platform_settings
  for each row execute function private.set_updated_at();
create trigger audit after insert or update or delete on public.platform_settings
  for each row execute function private.audit_row('-');

create function private.admin_mfa_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((auth.jwt() ->> 'aal') = 'aal2', false)
      or coalesce((select value = 'false'::jsonb from public.platform_settings where key = 'require_admin_mfa'), false);
$$;

-- Super admin powers need MFA.
create or replace function private.is_super_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.user_roles
    where user_id = (select auth.uid()) and role = 'super_admin'
  ) and private.admin_mfa_ok();
$$;

-- An admin membership only counts as admin once MFA is satisfied.
create or replace function private.has_institution_role(iid uuid, roles public.institution_role[]) returns boolean
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
      and (m.role <> 'admin' or private.admin_mfa_ok())
  );
$$;

grant execute on function private.admin_mfa_ok() to authenticated, service_role;

alter table public.platform_settings enable row level security;
-- Everyone signed in may read settings (the UI needs to know whether MFA is required).
create policy platform_settings_select on public.platform_settings for select to authenticated using (true);
create policy platform_settings_update on public.platform_settings for update to authenticated
  using ((select private.is_super_admin()))
  with check ((select private.is_super_admin()));
revoke insert, delete on public.platform_settings from authenticated;
revoke all on public.platform_settings from anon;
