-- ============================================================================
-- Institution settings and limits (docs/ARCHITECTURE.md §7, institution admin panel):
--   institutions.settings  chosen by the institution's admins (through the api), e.g. what new
--                          assignments start with
--   institutions.limits    set by the platform operator; each only tightens the deployment's
--                          plan (config/profiles): max_active_students, institution_concurrency,
--                          monthly_runner_minutes
-- The api and worker enforce the run limits; the student limit is enforced here, when someone
-- is invited as a student (pending invitations count, so accepting one never fails).
-- ============================================================================

create function private.check_student_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  cap integer;
  used integer;
begin
  if new.role <> 'student' then
    return new;
  end if;
  select (limits ->> 'max_active_students')::integer into cap from public.institutions where id = new.institution_id;
  if cap is null then
    return new;
  end if;
  select
    (select count(*) from public.institution_memberships m
      where m.institution_id = new.institution_id and m.role = 'student' and m.status = 'active')
    + (select count(*) from public.invitations i
        where i.institution_id = new.institution_id and i.role = 'student' and i.accepted_at is null
          and i.expires_at > now()
          -- someone already a member doesn't take another place
          and not exists (select 1 from public.institution_memberships m join public.profiles p on p.id = m.user_id
                          where m.institution_id = i.institution_id and m.status = 'active' and lower(p.email) = lower(i.email)))
    into used;
  if used >= cap and not exists (
    select 1 from public.institution_memberships m join public.profiles p on p.id = m.user_id
    where m.institution_id = new.institution_id and m.status = 'active' and lower(p.email) = lower(new.email)
  ) then
    raise exception 'This institution has reached its limit of % students. Ask the platform operator to raise it.', cap
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger check_student_limit before insert on public.invitations
  for each row execute function private.check_student_limit();

-- A notice shown at the top of every page (e.g. planned maintenance); the empty string shows none.
insert into public.platform_settings (key, value, description) values
  ('maintenance_banner', '""', 'A notice shown at the top of every page, for example planned maintenance. Empty for none.');
