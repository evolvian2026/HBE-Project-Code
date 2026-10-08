-- ============================================================================
-- Code review (FR-6.1, FR-6.2): inline comments on a student's code, and the commit the
-- student started from (the template's), cached for "changes since the start" diffs.
-- ============================================================================

alter table public.repositories add column start_sha text check (start_sha ~ '^[0-9a-f]{40}$');

create table public.review_comments (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  submission_id uuid not null,
  sha text not null check (sha ~ '^[0-9a-f]{40}$'),
  path text not null check (length(path) between 1 and 1000),
  line integer not null check (line > 0),
  body text not null check (length(trim(body)) between 1 and 5000),
  author_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (institution_id, id),
  foreign key (institution_id, submission_id) references public.submissions (institution_id, id) on delete cascade
);
create index review_comments_submission_idx on public.review_comments (submission_id, path, line);

create function private.set_comment_author() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.author_id := auth.uid();
  return new;
end;
$$;
create trigger set_comment_author before insert on public.review_comments
  for each row execute function private.set_comment_author();
create trigger set_updated_at before update on public.review_comments
  for each row execute function private.set_updated_at();
create trigger audit after insert or update or delete on public.review_comments
  for each row execute function private.audit_row();

alter table public.review_comments enable row level security;

-- Course staff, and the student once the grade is released (comments are feedback).
create policy review_comments_select on public.review_comments for select to authenticated
  using (private.grade_visible(submission_id));
create policy review_comments_insert on public.review_comments for insert to authenticated
  with check (
    private.is_course_staff((select a.course_id from public.submissions s join public.assignments a on a.id = s.assignment_id
                             where s.id = submission_id))
    and institution_id = (select s.institution_id from public.submissions s where s.id = submission_id)
  );
-- Authors edit and delete their own comments while they are still course staff.
create policy review_comments_update on public.review_comments for update to authenticated
  using (
    author_id = (select auth.uid())
    and private.is_course_staff((select a.course_id from public.submissions s join public.assignments a on a.id = s.assignment_id
                                 where s.id = submission_id))
  );
create policy review_comments_delete on public.review_comments for delete to authenticated
  using (
    author_id = (select auth.uid())
    and private.is_course_staff((select a.course_id from public.submissions s join public.assignments a on a.id = s.assignment_id
                                 where s.id = submission_id))
  );

revoke insert, update on public.review_comments from authenticated;
grant insert (institution_id, submission_id, sha, path, line, body), update (body) on public.review_comments to authenticated;
revoke all on public.review_comments from anon;
