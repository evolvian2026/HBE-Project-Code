-- ============================================================================
-- The records lifecycle (docs/ARCHITECTURE.md §12.4–12.5):
-- - replication of record files (grade reports, source snapshots, graded runs' artifacts) to
--   the external archive bucket, tracked per object;
-- - full exports for institution admins (a ZIP of reports, snapshots and CSVs);
-- - notices before the purge, and the purge itself, which leaves only a certificate.
-- The worker does all of it (apps/server/src/records); users only read their exports.
-- ============================================================================

-- Objects copied to the archive bucket (key: <bucket>/<path>). No user access.
create table public.replicated_objects (
  bucket text not null,
  path text not null,
  institution_id uuid not null references public.institutions (id) on delete cascade,
  size bigint not null,
  locked_until timestamptz,
  replicated_at timestamptz not null default now(),
  primary key (bucket, path)
);
create index replicated_objects_institution_idx on public.replicated_objects (institution_id);
-- RLS with no policies: users see no rows and cannot write.
alter table public.replicated_objects enable row level security;
revoke insert, update, delete on public.replicated_objects from authenticated;
revoke all on public.replicated_objects from anon;

-- Full exports an institution admin asked for.
create table public.record_exports (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete cascade,
  requested_by uuid references public.profiles (id) on delete set null,
  status text not null default 'queued' check (status in ('queued', 'running', 'ready', 'failed')),
  -- Where the ZIP is: the external archive bucket, or the record-exports Storage bucket.
  location text check (location in ('archive', 'storage')),
  path text,
  size bigint,
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  files integer,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index record_exports_institution_idx on public.record_exports (institution_id, created_at desc);
alter table public.record_exports enable row level security;
create policy record_exports_select on public.record_exports for select to authenticated
  using (private.has_institution_role(institution_id, '{admin}'));
revoke insert, update, delete on public.record_exports from authenticated;
revoke all on public.record_exports from anon;

-- Exports when no external archive is configured (local development).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('record-exports', 'record-exports', false, 524288000, array['application/zip'])
on conflict (id) do nothing;

-- Admins hear about exports and the coming purge.
alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (
  type in ('run_finished', 'grade_released', 'deadline_soon', 'extension_granted', 'regrade_requested',
           'regrade_answered', 'records_notice')
);

-- Records notices are always emailed (they are about the institution's data), also once the
-- contract has ended and the institution is read-only.
create or replace function private.queue_notification_email() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  recipient record;
  inst record;
begin
  select p.email, p.email_notification_types into recipient from public.profiles p where p.id = new.user_id;
  select i.name, i.slug, i.status into inst from public.institutions i where i.id = new.institution_id;
  if recipient.email is null
     or (new.type <> 'records_notice' and not (new.type = any (recipient.email_notification_types)))
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

-- The purge deletes everything an institution has; auditing each deleted row would copy the
-- personal data it removes into the audit log. It sets hbe.skip_audit for its transaction and
-- writes one certificate instead.
create or replace function private.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rec jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  inst_col text := coalesce(tg_argv[0], 'institution_id');
begin
  if current_setting('hbe.skip_audit', true) = 'on' then
    return null;
  end if;
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
