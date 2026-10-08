-- ============================================================================
-- In-app notifications (FR-7.4). Written by the platform; each user reads their own and
-- marks them read. dedupe_key makes repeated deliveries (retries, sweeps) harmless.
-- ============================================================================

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  type text not null check (type in ('run_finished', 'grade_released', 'deadline_soon', 'extension_granted')),
  title text not null check (length(title) <= 300),
  body text check (length(body) <= 2000),
  -- Path inside the web app, e.g. /i/alpha/courses/…
  link text check (link like '/%'),
  dedupe_key text,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (user_id, dedupe_key)
);
create index notifications_unread_idx on public.notifications (user_id, created_at desc) where read_at is null;

alter table public.notifications enable row level security;
create policy notifications_select on public.notifications for select to authenticated
  using (user_id = (select auth.uid()) and institution_id = any ((select private.my_institution_ids())::uuid[]));
create policy notifications_mark_read on public.notifications for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke insert, update, delete on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;
revoke all on public.notifications from anon;

-- A new or changed extension tells the student.
create function private.notify_extension() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a record;
begin
  select ass.title, ass.course_id, i.slug into a
  from public.assignments ass join public.institutions i on i.id = ass.institution_id
  where ass.id = new.assignment_id;
  insert into public.notifications (institution_id, user_id, type, title, body, link, dedupe_key)
  values (
    new.institution_id, new.user_id, 'extension_granted',
    'Your deadline for ' || a.title || ' was extended',
    new.reason,
    '/i/' || a.slug || '/courses/' || a.course_id || '/assignments/' || new.assignment_id,
    'extension:' || new.id || ':' || extract(epoch from new.due_at)::bigint
  )
  on conflict (user_id, dedupe_key) do nothing;
  return null;
end;
$$;
create trigger notify_extension after insert or update of due_at on public.assignment_extensions
  for each row execute function private.notify_extension();
