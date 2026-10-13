-- ============================================================================
-- Erasure requests (FR-9.6, ARCHITECTURE §12.5): the institution is the data controller, so its
-- admins decide how a person's data in the institution is erased:
--   anonymise: their records stay (grades, reports, feedback, test results, source snapshots)
--              but belong to a pseudonymous placeholder ("Erased student 3F7A2C"), and the
--              identifiers that point back to them (email, names, GitHub and LMS ids, student
--              id) are removed, also from the audit log;
--   delete:    the same, then their own records are deleted as well (work shared with a team
--              stays, as the placeholder's).
-- A person can ask for it themselves; an admin can also start it. The worker carries it out
-- (apps/server/src/erasure.ts) and leaves a certificate (counts, no personal data).
-- ============================================================================

alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (
  type in ('run_finished', 'grade_released', 'deadline_soon', 'extension_granted', 'regrade_requested',
           'regrade_answered', 'records_notice', 'commit_claim', 'account_security', 'erasure_request')
);

-- Admins can also get these by email.
alter table public.profiles drop constraint profiles_email_notification_types_check;
alter table public.profiles add constraint profiles_email_notification_types_check
  check (email_notification_types <@ array['run_finished', 'grade_released', 'deadline_soon', 'extension_granted',
                                           'regrade_requested', 'regrade_answered', 'commit_claim', 'erasure_request']);

create table public.erasure_requests (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions (id) on delete cascade,
  -- The person, until the erasure is done; then null, so nothing links them to the pseudonym.
  subject_id uuid,
  subject_role public.institution_role not null,
  requested_via text not null check (requested_via in ('admin', 'self')),
  -- Null once done when it was the person themselves.
  requested_by uuid,
  note text check (length(note) <= 2000),
  status text not null default 'requested'
    check (status in ('requested', 'approved', 'running', 'completed', 'rejected', 'failed')),
  mode text check (mode in ('anonymise', 'delete')),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text check (length(decision_note) <= 2000),
  -- The placeholder account the records now belong to, and its display name.
  pseudonym_id uuid,
  pseudonym text,
  -- Files still to delete (bucket and path), kept between the database step and the file step.
  pending_objects jsonb,
  certificate jsonb,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (status in ('requested', 'rejected') or mode is not null),
  check (status <> 'completed' or subject_id is null)
);
create unique index erasure_requests_open_idx on public.erasure_requests (institution_id, subject_id)
  where status in ('requested', 'approved', 'running', 'failed');
create index erasure_requests_institution_idx on public.erasure_requests (institution_id, created_at desc);

alter table public.erasure_requests enable row level security;
create policy erasure_requests_select on public.erasure_requests for select to authenticated
  using (
    private.has_institution_role(institution_id, '{admin}')
    or (subject_id = (select auth.uid()) and institution_id = any ((select private.my_institution_ids())::uuid[]))
  );
revoke insert, update, delete on public.erasure_requests from authenticated;
revoke all on public.erasure_requests from anon;

-- Moves everything in one institution that points at a person (any foreign key to profiles,
-- or to their institution membership, in a table with institution_id) to another account.
-- Generic, so tables added later are covered. Returns the rows moved per table and column.
create function private.rekey_person(p_institution uuid, p_from uuid, p_to uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  n bigint;
  moved jsonb := '{}'::jsonb;
begin
  for r in
    select distinct c.conrelid::regclass as tbl, a.attname as col
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    join pg_attribute fa on fa.attrelid = c.confrelid and fa.attnum = c.confkey[array_position(c.conkey, a.attnum)]
    where c.contype = 'f'
      and ((c.confrelid = 'public.profiles'::regclass and fa.attname = 'id')
           or (c.confrelid = 'public.institution_memberships'::regclass and fa.attname = 'user_id'))
      and c.conrelid <> 'public.institution_memberships'::regclass
      and exists (select 1 from pg_attribute ia
                  where ia.attrelid = c.conrelid and ia.attname = 'institution_id' and not ia.attisdropped)
    order by 1, 2
  loop
    execute format('update %s set %I = $1 where institution_id = $2 and %I = $3', r.tbl, r.col, r.col)
      using p_to, p_institution, p_from;
    get diagnostics n = row_count;
    if n > 0 then
      moved := moved || jsonb_build_object(r.tbl::text || '.' || r.col, n);
    end if;
  end loop;
  return moved;
end;
$$;

-- Removes identifiers of a person from one institution's data, once their rows belong to the
-- placeholder p_to: git and GitHub identities, raw webhooks, invitations, LMS and Google
-- links, notifications, queued emails, commit aliases, repository names, and the audit log.
create function private.scrub_person(
  p_institution uuid, p_from uuid, p_to uuid, p_label text, p_slug text,
  p_github_id bigint, p_github_login text, p_emails text[]
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  n bigint;
  done jsonb := '{}'::jsonb;
  login text := lower(nullif(p_github_login, ''));
  emails text[] := coalesce((select array_agg(distinct lower(e)) from unnest(p_emails) e where e is not null and e <> ''), '{}');
  pattern text;
begin
  update public.commits set author_login = null, author_github_id = null, author_email = null, author_name = p_label
  where institution_id = p_institution
    and (author_profile_id = p_to or author_github_id = p_github_id or lower(author_login) = login
         or lower(author_email) = any (emails));
  get diagnostics n = row_count; done := done || jsonb_build_object('commits', n);

  update public.pull_requests set author_github_id = null
  where institution_id = p_institution and (author_profile_id = p_to or author_github_id = p_github_id);
  update public.issues set author_github_id = null
  where institution_id = p_institution and (author_profile_id = p_to or author_github_id = p_github_id);
  update public.pr_reviews set reviewer_github_id = null
  where institution_id = p_institution and (reviewer_profile_id = p_to or reviewer_github_id = p_github_id);
  update public.branch_pushes set pusher_github_id = null
  where institution_id = p_institution and pusher_github_id = p_github_id;

  -- Raw webhooks can name them anywhere in the payload.
  update public.github_events
  set payload = '{}'::jsonb, sender_id = null,
      processed_at = coalesce(processed_at, now()), error = coalesce(error, 'erased')
  where institution_id = p_institution
    and (sender_id = p_github_id
         or (login is not null and lower(payload::text) like '%"' || login || '"%')
         or exists (select 1 from unnest(emails) e where lower(payload::text) like '%' || e || '%'));
  get diagnostics n = row_count; done := done || jsonb_build_object('github_events', n);

  delete from public.invitations
  where institution_id = p_institution
    and (accepted_by = p_to or lower(email) = any (emails) or lower(github_login) = login);
  get diagnostics n = row_count; done := done || jsonb_build_object('invitations', n);

  delete from public.lms_grade_syncs s using public.grades g
  where s.grade_id = g.id and g.institution_id = p_institution and g.user_id = p_to;
  delete from public.lms_user_links where institution_id = p_institution and profile_id = p_to;
  get diagnostics n = row_count; done := done || jsonb_build_object('lms_user_links', n);
  delete from public.google_accounts where institution_id = p_institution and profile_id = p_to;
  delete from public.google_oauth_states where institution_id = p_institution and profile_id = p_to;
  delete from public.lti_deep_link_requests where profile_id = p_from;
  delete from public.github_link_requests where institution_id = p_institution and requested_by = p_to;
  delete from public.commit_author_aliases where institution_id = p_institution and profile_id = p_to;

  delete from public.notifications where institution_id = p_institution and user_id = p_to;
  get diagnostics n = row_count; done := done || jsonb_build_object('notifications', n);
  delete from public.email_outbox where institution_id = p_institution and lower(to_email) = any (emails);
  get diagnostics n = row_count; done := done || jsonb_build_object('email_outbox', n);

  -- Repositories are named after the student's GitHub login ({assignment}-{login}).
  if login is not null then
    update public.repositories r
    set name = regexp_replace(r.name, login, p_slug, 'gi')
    where r.institution_id = p_institution
      and r.id in (select repository_id from public.submissions where institution_id = p_institution and user_id = p_to)
      and lower(r.name) like '%' || login || '%';
  end if;

  -- The audit log: their id becomes the placeholder's, their email and GitHub login go, and
  -- snapshots of rows about them lose the identifying fields.
  pattern := '(' || array_to_string(array(
    select regexp_replace(x, '([.+*?^$()\[\]{}|\\])', '\\\1', 'g')
    from unnest(emails || case when login is null then '{}'::text[] else array[login] end) x), '|') || ')';
  update public.audit_logs a
  set actor_id = case when a.actor_id = p_from then p_to else a.actor_id end,
      entity_id = case when a.entity_id = p_from::text then p_to::text else a.entity_id end,
      before = private.strip_identity(private.erase_text(a.before, p_from, p_to, pattern), p_to),
      after = private.strip_identity(private.erase_text(a.after, p_from, p_to, pattern), p_to)
  where a.institution_id = p_institution
    and (a.actor_id = p_from or a.entity_id = p_from::text
         or a.before::text like '%' || p_from::text || '%' or a.after::text like '%' || p_from::text || '%'
         or (pattern <> '()' and (lower(a.before::text) ~ pattern or lower(a.after::text) ~ pattern)));
  get diagnostics n = row_count; done := done || jsonb_build_object('audit_logs', n);

  return done;
end;
$$;

-- A JSON value with one id replaced by another and matches of `pattern` (emails, login) erased.
create function private.erase_text(j jsonb, p_from uuid, p_to uuid, pattern text) returns jsonb
language sql immutable set search_path = '' as $$
  select case when j is null then null
              when pattern = '()' then replace(j::text, p_from::text, p_to::text)::jsonb
              else regexp_replace(replace(j::text, p_from::text, p_to::text), pattern, '[erased]', 'gi')::jsonb end;
$$;

-- A row snapshot about the placeholder, without the fields that identify a person.
create function private.strip_identity(j jsonb, p_to uuid) returns jsonb
language sql immutable set search_path = '' as $$
  select case
    when j is null then null
    when p_to::text in (j ->> 'user_id', j ->> 'profile_id', j ->> 'id', j ->> 'accepted_by', j ->> 'claimed_by')
      then j - array['email', 'github_login', 'external_id', 'full_name', 'name', 'lms_user_id', 'to_email',
                     'reason', 'note', 'message']
    else j end;
$$;

revoke all on function private.rekey_person(uuid, uuid, uuid),
  private.scrub_person(uuid, uuid, uuid, text, text, bigint, text, text[]),
  private.erase_text(jsonb, uuid, uuid, text), private.strip_identity(jsonb, uuid)
  from public, anon, authenticated;
