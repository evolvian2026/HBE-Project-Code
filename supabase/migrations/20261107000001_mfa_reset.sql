-- ============================================================================
-- Admins reset a member's two-factor authentication (FR-8.1), e.g. after a lost phone. The api
-- removes the person's authenticator factors (Supabase Auth's admin API), records it in the
-- audit log, and tells the person: account security notices are always emailed, whatever
-- their email preferences.
-- ============================================================================

alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (
  type in ('run_finished', 'grade_released', 'deadline_soon', 'extension_granted', 'regrade_requested',
           'regrade_answered', 'records_notice', 'commit_claim', 'account_security')
);

create or replace function private.queue_notification_email() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  recipient record;
  inst record;
begin
  select p.email, p.email_notification_types into recipient from public.profiles p where p.id = new.user_id;
  select i.name, i.slug, i.status into inst from public.institutions i where i.id = new.institution_id;
  if recipient.email is null
     or (new.type not in ('records_notice', 'account_security') and not (new.type = any (recipient.email_notification_types)))
     or inst.status not in ('active', 'read_only') then
    return null;
  end if;
  insert into public.email_outbox (institution_id, to_email, template, payload)
  values (
    new.institution_id,
    recipient.email,
    'notification',
    jsonb_build_object(
      'notification_id', new.id,
      'type', new.type,
      'title', new.title,
      'body', new.body,
      'link', new.link,
      'institution_name', inst.name,
      'institution_slug', inst.slug
    )
  );
  return null;
end;
$$;
