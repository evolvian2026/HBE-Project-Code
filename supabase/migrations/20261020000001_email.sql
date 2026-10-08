-- ============================================================================
-- Email notifications (FR-7.4): a new in-app notification is also queued in email_outbox
-- (same transaction) when its user wants that type by email; the worker sends the outbox.
-- Users choose the types on their account page. Test-run results are in-app only unless a
-- user asks for them, since every push makes one.
-- ============================================================================

alter table public.profiles
  add column email_notification_types text[] not null
    default '{grade_released,deadline_soon,extension_granted,regrade_requested,regrade_answered}'
    check (email_notification_types <@ array['run_finished', 'grade_released', 'deadline_soon', 'extension_granted',
                                             'regrade_requested', 'regrade_answered']);
grant update (email_notification_types) on public.profiles to authenticated;

alter table public.email_outbox drop constraint email_outbox_template_check;
alter table public.email_outbox add constraint email_outbox_template_check
  check (template in ('invitation', 'notification'));

create function private.queue_notification_email() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  recipient record;
  inst record;
begin
  select p.email, p.email_notification_types into recipient from public.profiles p where p.id = new.user_id;
  select i.name, i.slug, i.status into inst from public.institutions i where i.id = new.institution_id;
  if recipient.email is null or not (new.type = any (recipient.email_notification_types))
     or inst.status <> 'active' then
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

create trigger queue_notification_email after insert on public.notifications
  for each row execute function private.queue_notification_email();
