-- ============================================================================
-- Institution administration: invitation de-duplication and the email outbox.
-- ============================================================================

-- One pending invitation per person per institution and course.
create unique index invitations_pending_email_unique
  on public.invitations (institution_id, lower(email), coalesce(course_id, '00000000-0000-0000-0000-000000000000'))
  where accepted_at is null and email is not null;
create unique index invitations_pending_login_unique
  on public.invitations (institution_id, lower(github_login), coalesce(course_id, '00000000-0000-0000-0000-000000000000'))
  where accepted_at is null and github_login is not null;

-- ---------------------------------------------------------------------------
-- Email outbox: rows are written in the same transaction as the change that
-- needs an email, then sent by the worker with retries. No user access.
-- ---------------------------------------------------------------------------
create table public.email_outbox (
  id bigint generated always as identity primary key,
  institution_id uuid references public.institutions (id) on delete cascade,
  to_email text not null,
  template text not null check (template in ('invitation')),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index email_outbox_pending_idx on public.email_outbox (created_at) where status = 'pending';

-- RLS with no policies: users see no rows and cannot write.
alter table public.email_outbox enable row level security;
revoke insert, update, delete on public.email_outbox from authenticated;
revoke all on public.email_outbox from anon;

create function private.queue_invitation_email() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  inst record;
  course_name text;
  inviter text;
begin
  if new.email is null then
    return null;
  end if;
  select name, slug into inst from public.institutions where id = new.institution_id;
  select c.code || ' · ' || c.name into course_name from public.courses c where c.id = new.course_id;
  select coalesce(p.full_name, p.email) into inviter from public.profiles p where p.id = new.invited_by;

  insert into public.email_outbox (institution_id, to_email, template, payload)
  values (
    new.institution_id,
    new.email,
    'invitation',
    jsonb_build_object(
      'invitation_id', new.id,
      'institution_name', inst.name,
      'institution_slug', inst.slug,
      'role', new.role,
      'course_name', course_name,
      'course_role', new.course_role,
      'invited_by', inviter,
      'expires_at', new.expires_at
    )
  );
  return null;
end;
$$;

create trigger queue_invitation_email after insert on public.invitations
  for each row execute function private.queue_invitation_email();

-- Course memberships also point straight at the profile (in addition to the composite key
-- through institution_memberships), so the Data API can embed member profiles.
alter table public.course_memberships
  add constraint course_memberships_user_profile_fk foreign key (user_id) references public.profiles (id) on delete cascade;
