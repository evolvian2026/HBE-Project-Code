-- ============================================================================
-- Grading: rubric scores, feedback, and versioned grades with overrides and release.
-- All writes go through the API (which recomputes the grade); the Data API only reads.
-- Students see their grade, rubric scores and feedback once staff release them.
-- See docs/ARCHITECTURE.md §6.6.
-- ============================================================================

-- Set when the submission's grade is released; later grade versions are released at once.
alter table public.submissions add column grade_released_at timestamptz;

create table public.rubric_scores (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  submission_id uuid not null,
  criterion_id uuid not null,
  points numeric(6, 2) not null check (points >= 0),
  comment text check (length(comment) <= 5000),
  scored_by uuid references public.profiles (id) on delete set null,
  scored_at timestamptz not null default now(),
  unique (submission_id, criterion_id),
  unique (institution_id, id),
  foreign key (institution_id, submission_id) references public.submissions (institution_id, id) on delete cascade,
  foreign key (institution_id, criterion_id) references public.assignment_criteria (institution_id, id) on delete cascade
);

-- Points can't exceed the criterion's maximum, and the criterion must be the submission's assignment's.
create function private.check_rubric_score() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c record;
begin
  select ac.max_points, ac.assignment_id into c from public.assignment_criteria ac where ac.id = new.criterion_id;
  if c.assignment_id <> (select assignment_id from public.submissions where id = new.submission_id) then
    raise exception 'That criterion belongs to another assignment' using errcode = '23503';
  end if;
  if new.points > c.max_points then
    raise exception 'At most % points for this criterion', c.max_points using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger check_rubric_score before insert or update on public.rubric_scores
  for each row execute function private.check_rubric_score();

create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  submission_id uuid not null unique,
  body_md text not null default '' check (length(body_md) <= 50000),
  author_id uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (institution_id, id),
  foreign key (institution_id, submission_id) references public.submissions (institution_id, id) on delete cascade
);

-- Append-only: every change makes a new version; exactly one is current per submission.
create table public.grades (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null,
  submission_id uuid not null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  version integer not null check (version > 0),
  evaluation_run_id uuid references public.evaluation_runs (id) on delete set null,
  -- Per component: score (0–100 or null), weight, and what it came from; plus what is still missing.
  components jsonb not null,
  late_days integer not null default 0,
  late_penalty numeric(5, 2) not null default 0 check (late_penalty between 0 and 100),
  computed_score numeric(5, 2) not null check (computed_score between 0 and 100),
  override_score numeric(5, 2) check (override_score between 0 and 100),
  override_reason text check ((override_score is null) = (override_reason is null)),
  final_score numeric(5, 2) not null check (final_score between 0 and 100),
  complete boolean not null,
  is_current boolean not null default true,
  released_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (submission_id, version),
  unique (institution_id, id),
  foreign key (institution_id, submission_id) references public.submissions (institution_id, id) on delete cascade
);
create unique index grades_current_idx on public.grades (submission_id) where is_current;
create index grades_user_idx on public.grades (institution_id, user_id) where is_current;

create trigger audit after insert or update or delete on public.rubric_scores
  for each row execute function private.audit_row();
create trigger audit after insert or update or delete on public.feedback
  for each row execute function private.audit_row();
create trigger audit after insert or update or delete on public.grades
  for each row execute function private.audit_row();

-- ---------------------------------------------------------------------------
-- RLS: staff of the course see everything; the student once the grade is released.
-- ---------------------------------------------------------------------------
create function private.grade_visible(p_submission uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.submissions s
    join public.assignments a on a.id = s.assignment_id
    where s.id = p_submission
      and (private.is_course_staff(a.course_id)
           or (s.user_id = auth.uid() and s.grade_released_at is not null
               and s.institution_id = any ((select private.my_institution_ids())::uuid[])))
  );
$$;

alter table public.rubric_scores enable row level security;
alter table public.feedback enable row level security;
alter table public.grades enable row level security;

create policy rubric_scores_select on public.rubric_scores for select to authenticated
  using (private.grade_visible(submission_id));
create policy feedback_select on public.feedback for select to authenticated
  using (private.grade_visible(submission_id));
-- Students see released versions only (a version made after release is released with it).
create policy grades_select on public.grades for select to authenticated
  using (
    private.is_course_staff((select a.course_id from public.submissions s join public.assignments a on a.id = s.assignment_id
                             where s.id = submission_id))
    or (released_at is not null and private.grade_visible(submission_id))
  );

revoke insert, update, delete on public.rubric_scores, public.feedback, public.grades from authenticated;
revoke all on public.rubric_scores, public.feedback, public.grades from anon;
-- Why staff overrode a grade is for staff.
revoke select on public.grades from authenticated;
grant select (id, institution_id, submission_id, user_id, version, evaluation_run_id, components, late_days,
              late_penalty, computed_score, override_score, final_score, complete, is_current, released_at, created_at)
  on public.grades to authenticated;

create function public.grade_override_reasons(p_submission uuid)
returns table (version integer, override_reason text, created_by uuid)
language sql stable security definer set search_path = '' as $$
  select g.version, g.override_reason, g.created_by
  from public.grades g
  join public.submissions s on s.id = g.submission_id
  join public.assignments a on a.id = s.assignment_id
  where g.submission_id = p_submission and private.is_course_staff(a.course_id);
$$;
revoke execute on function public.grade_override_reasons(uuid) from public, anon;
grant execute on function public.grade_override_reasons(uuid) to authenticated;
