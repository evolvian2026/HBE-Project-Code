-- Test helpers. Files run in alphabetical order, so this one installs the
-- helpers (committed, not rolled back) before the other test files use them.
-- Nothing here is part of the migrations or ships to any deployed database.

create extension if not exists pgtap with schema extensions;

create schema if not exists tests;
grant usage on schema tests to authenticated;

-- Named fixture ids, filled in by each test file inside its own transaction.
create table if not exists tests.ids (name text primary key, id uuid not null);
grant select on tests.ids to authenticated;

create or replace function tests.id(p_name text) returns uuid
language sql stable security definer set search_path = '' as $$
  select id from tests.ids where name = p_name;
$$;

-- Creates an auth user (the profile is created by the on_auth_user_created trigger)
-- and optionally a linked GitHub identity.
create or replace function tests.create_user(
  p_email text,
  p_github_id bigint default null,
  p_github_login text default null,
  p_confirmed boolean default true
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := gen_random_uuid();
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', p_email,
          case when p_confirmed then now() end,
          '{"provider":"email","providers":["email"]}'::jsonb,
          jsonb_build_object('full_name', split_part(p_email, '@', 1)),
          now(), now());

  if p_github_id is not null then
    insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at, last_sign_in_at)
    values (p_github_id::text, uid,
            jsonb_build_object('sub', p_github_id::text, 'user_name', p_github_login),
            'github', now(), now(), now());
  end if;

  return uid;
end;
$$;

-- Switch to the `authenticated` role with the given user as JWT subject. Sessions are
-- MFA-verified (aal2) unless p_aal says otherwise. Undo with `reset role;`.
drop function if exists tests.authenticate_as(uuid);
create or replace function tests.authenticate_as(p_user uuid, p_aal text default 'aal2') returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

-- Builds two institutions (alpha, beta) with users, courses, invitations and
-- GitHub installations. Must be called as postgres inside the test transaction.
create or replace function tests.seed_two_institutions() returns void
language plpgsql set search_path = '' as $$
begin
  insert into tests.ids (name, id) values
    ('super',     tests.create_user('super@test.local')),
    ('admin_a',   tests.create_user('admin.a@test.local')),
    ('teacher_a', tests.create_user('teacher.a@test.local')),
    ('student_a', tests.create_user('student.a@test.local', 1001, 'student-a')),
    ('admin_b',   tests.create_user('admin.b@test.local')),
    ('student_b', tests.create_user('student.b@test.local', 2001, 'student-b')),
    ('inst_a',    'aaaaaaaa-0000-4000-8000-000000000001'),
    ('inst_b',    'bbbbbbbb-0000-4000-8000-000000000001'),
    ('course_a1', 'aaaaaaaa-0000-4000-8000-0000000000c1'),
    ('course_a2', 'aaaaaaaa-0000-4000-8000-0000000000c2'),
    ('course_b1', 'bbbbbbbb-0000-4000-8000-0000000000c1'),
    ('gh_a',      'aaaaaaaa-0000-4000-8000-0000000000f1'),
    ('gh_b',      'bbbbbbbb-0000-4000-8000-0000000000f1');

  insert into public.user_roles (user_id, role) values (tests.id('super'), 'super_admin');

  insert into public.institutions (id, name, slug) values
    (tests.id('inst_a'), 'Alpha University', 'alpha'),
    (tests.id('inst_b'), 'Beta College', 'beta');

  insert into public.institution_memberships (institution_id, user_id, role) values
    (tests.id('inst_a'), tests.id('admin_a'), 'admin'),
    (tests.id('inst_a'), tests.id('teacher_a'), 'teacher'),
    (tests.id('inst_a'), tests.id('student_a'), 'student'),
    (tests.id('inst_b'), tests.id('admin_b'), 'admin'),
    (tests.id('inst_b'), tests.id('student_b'), 'student');

  insert into public.github_installations (id, institution_id, installation_id, account_id, account_login, account_type) values
    (tests.id('gh_a'), tests.id('inst_a'), 501, 9001, 'alpha-cs', 'Organization'),
    (tests.id('gh_b'), tests.id('inst_b'), 502, 9002, 'beta-cs', 'Organization');
  insert into public.github_installations (institution_id, installation_id, account_id, account_login, account_type)
    values (null, 503, 9003, 'unlinked-org', 'Organization');

  insert into public.courses (id, institution_id, code, name, term, github_installation_id) values
    (tests.id('course_a1'), tests.id('inst_a'), 'CS101', 'Web Development', '2026-T1', tests.id('gh_a')),
    (tests.id('course_a2'), tests.id('inst_a'), 'CS201', 'Databases', '2026-T1', null),
    (tests.id('course_b1'), tests.id('inst_b'), 'FS100', 'Full-Stack Basics', '2026-T1', tests.id('gh_b'));

  insert into public.course_memberships (institution_id, course_id, user_id, role) values
    (tests.id('inst_a'), tests.id('course_a1'), tests.id('teacher_a'), 'instructor'),
    (tests.id('inst_a'), tests.id('course_a1'), tests.id('student_a'), 'student'),
    (tests.id('inst_b'), tests.id('course_b1'), tests.id('student_b'), 'student');

  insert into public.invitations (institution_id, email, role) values
    (tests.id('inst_a'), 'pending.a@test.local', 'student'),
    (tests.id('inst_b'), 'pending.b@test.local', 'student');

  insert into tests.ids (name, id) values
    ('assign_a1', 'aaaaaaaa-0000-4000-8000-0000000000a1'),
    ('assign_b1', 'bbbbbbbb-0000-4000-8000-0000000000a1'),
    ('profile_b', 'bbbbbbbb-0000-4000-8000-0000000000e1');
  insert into public.stack_profiles (id, institution_id, key, version, display_name, definition)
    values (tests.id('profile_b'), tests.id('inst_b'), 'beta-java', 1, 'Beta Java', '{}');
  insert into public.assignments (id, institution_id, course_id, slug, title, stack_profile_id, due_at, status, published_at)
    values
    (tests.id('assign_a1'), tests.id('inst_a'), tests.id('course_a1'), 'todo-api', 'Todo API',
     (select id from public.stack_profiles where key = 'mern-node20' and institution_id is null), now() + interval '14 days', 'published', now()),
    (tests.id('assign_b1'), tests.id('inst_b'), tests.id('course_b1'), 'shop', 'Shop',
     tests.id('profile_b'), now() + interval '14 days', 'published', now());
  perform private.ensure_submissions(tests.id('assign_a1'));
  perform private.ensure_submissions(tests.id('assign_b1'));
  insert into public.assignment_criteria (institution_id, assignment_id, title, max_points) values
    (tests.id('inst_a'), tests.id('assign_a1'), 'Code quality', 10),
    (tests.id('inst_b'), tests.id('assign_b1'), 'Code quality', 10);
  insert into public.repositories (institution_id, github_installation_id, owner, name) values
    (tests.id('inst_a'), tests.id('gh_a'), 'alpha-cs', 'todo-api-student-a'),
    (tests.id('inst_b'), tests.id('gh_b'), 'beta-cs', 'shop-student-b');
  update public.submissions s set repository_id = r.id, status = 'active'
    from public.repositories r where r.name in ('todo-api-student-a', 'shop-student-b')
     and s.institution_id = r.institution_id;
  insert into public.assignment_extensions (institution_id, assignment_id, user_id, due_at) values
    (tests.id('inst_a'), tests.id('assign_a1'), tests.id('student_a'), now() + interval '20 days'),
    (tests.id('inst_b'), tests.id('assign_b1'), tests.id('student_b'), now() + interval '20 days');

  -- Activity in each student repository
  insert into public.commits (institution_id, repository_id, sha, authored_at, author_profile_id)
    select r.institution_id, r.id, repeat(substr(md5(r.name), 1, 1), 40), now(), s.user_id
    from public.repositories r join public.submissions s on s.repository_id = r.id;
  insert into public.pull_requests (institution_id, repository_id, number, github_id, state, opened_at)
    select r.institution_id, r.id, 1, (random() * 1e9)::bigint, 'open', now() from public.repositories r;
  insert into public.pr_reviews (institution_id, repository_id, pr_number, github_review_id, state, submitted_at)
    select r.institution_id, r.id, 1, (random() * 1e9)::bigint, 'approved', now() from public.repositories r;
  insert into public.issues (institution_id, repository_id, number, github_id, state, opened_at)
    select r.institution_id, r.id, 2, (random() * 1e9)::bigint, 'open', now() from public.repositories r;
  insert into public.process_snapshots (institution_id, submission_id, score, breakdown, policy)
    select s.institution_id, s.id, 50, '{}', '{}' from public.submissions s where s.repository_id is not null;
  insert into public.evaluation_runs (institution_id, submission_id, sha, trigger, status, callback_token_hash)
    select s.institution_id, s.id, repeat('a', 40), 'manual', 'completed', 'secret-hash'
    from public.submissions s where s.repository_id is not null;
  insert into public.test_results (institution_id, run_id, stage, test_key, title, status, staff_notes)
    select r.institution_id, r.id, 'api', 'todos.create', 'Creates a todo', 'failed', 'Common cause: missing await'
    from public.evaluation_runs r;
  insert into public.run_artifacts (institution_id, run_id, name, path, content_type, size)
    select r.institution_id, r.id, 'logs/build.log', r.institution_id || '/' || r.id || '/logs/build.log', 'text/plain', 10
    from public.evaluation_runs r;
  insert into public.grader_suites (institution_id, key, version, title, path)
    values (tests.id('inst_b'), 'beta-suite', 1, 'Beta suite', 'suites/beta');
  insert into public.branch_pushes (institution_id, repository_id, sha, pushed_at)
    select r.institution_id, r.id, repeat('b', 40), now() - interval '1 day' from public.repositories r;

  -- Grading (unreleased): a rubric score, feedback and an overridden grade per student repository.
  insert into public.rubric_scores (institution_id, submission_id, criterion_id, points, comment)
    select s.institution_id, s.id, c.id, 5, 'Readable code'
    from public.submissions s join public.assignment_criteria c on c.assignment_id = s.assignment_id
    where s.repository_id is not null;
  insert into public.feedback (institution_id, submission_id, body_md)
    select s.institution_id, s.id, 'Good work' from public.submissions s where s.repository_id is not null;
  insert into public.grades (institution_id, submission_id, user_id, version, components, computed_score,
                             override_score, override_reason, final_score, complete)
    select s.institution_id, s.id, s.user_id, 1, '{}', 70, 75, 'Bonus for documentation', 75, true
    from public.submissions s where s.repository_id is not null;

  -- Records: a report of each (unreleased) grade, and a snapshot of each graded commit.
  insert into public.grade_reports (institution_id, submission_id, grade_id, user_id, version, grade_version,
                                    json_path, pdf_path, sha256, pdf_sha256)
    select g.institution_id, g.submission_id, g.id, g.user_id, 1, 1,
           g.institution_id || '/' || g.submission_id || '/v1.json', g.institution_id || '/' || g.submission_id || '/v1.pdf',
           repeat('a', 64), repeat('b', 64)
    from public.grades g;
  insert into public.submission_snapshots (institution_id, submission_id, sha, bundle_path, bundle_sha256, bundle_size,
                                           tarball_path, tarball_sha256, tarball_size)
    select s.institution_id, s.id, repeat('b', 40), s.id || '.bundle', repeat('c', 64), 10, s.id || '.tar.gz', repeat('d', 64), 10
    from public.submissions s where s.repository_id is not null;
  insert into public.review_comments (institution_id, submission_id, sha, path, line, body)
    select s.institution_id, s.id, repeat('b', 40), 'src/server.js', 3, 'Validate the title here'
    from public.submissions s where s.repository_id is not null;
  insert into public.regrade_requests (institution_id, submission_id, requested_by, message)
    select s.institution_id, s.id, s.user_id, 'Please look at the search tests again'
    from public.submissions s where s.repository_id is not null;
  insert into public.notifications (institution_id, user_id, type, title, link, dedupe_key) values
    (tests.id('inst_a'), tests.id('student_a'), 'grade_released', 'Your grade for Todo API is out', '/i/alpha', 'seed-a'),
    (tests.id('inst_b'), tests.id('student_b'), 'grade_released', 'Your grade for Shop is out', '/i/beta', 'seed-b');
  insert into storage.objects (bucket_id, name)
    select 'grade-reports', json_path from public.grade_reports
    union all select 'submission-archive', bundle_path from public.submission_snapshots
    union all select 'run-artifacts', path from public.run_artifacts;

  insert into public.github_link_requests (institution_id, requested_by, github_user_id) values
    (tests.id('inst_a'), tests.id('admin_a'), 7001),
    (tests.id('inst_b'), tests.id('admin_b'), 7002);
end;
$$;

-- Rows in every tenant-owned table that the *current* role can see for an institution.
-- SECURITY INVOKER, so RLS applies. Add every new tenant-owned table here.
create or replace function tests.visible_rows(p_institution uuid) returns table (tbl text, n bigint)
language sql security invoker set search_path = '' as $$
  select 'institutions', count(*) from public.institutions where id = p_institution
  union all select 'institution_memberships', count(*) from public.institution_memberships where institution_id = p_institution
  union all select 'courses', count(*) from public.courses where institution_id = p_institution
  union all select 'course_memberships', count(*) from public.course_memberships where institution_id = p_institution
  union all select 'invitations', count(*) from public.invitations where institution_id = p_institution
  union all select 'audit_logs', count(*) from public.audit_logs where institution_id = p_institution
  union all select 'github_installations', count(*) from public.github_installations where institution_id = p_institution
  union all select 'github_link_requests', count(*) from public.github_link_requests where institution_id = p_institution
  union all select 'github_events', count(*) from public.github_events where institution_id = p_institution
  union all select 'email_outbox', count(*) from public.email_outbox where institution_id = p_institution
  union all select 'stack_profiles', count(*) from public.stack_profiles where institution_id = p_institution
  union all select 'assignments', count(*) from public.assignments where institution_id = p_institution
  union all select 'assignment_criteria', count(*) from public.assignment_criteria where institution_id = p_institution
  union all select 'assignment_extensions', count(*) from public.assignment_extensions where institution_id = p_institution
  union all select 'repositories', count(*) from public.repositories where institution_id = p_institution
  union all select 'submissions', count(*) from public.submissions where institution_id = p_institution
  union all select 'commits', count(*) from public.commits where institution_id = p_institution
  union all select 'pull_requests', count(*) from public.pull_requests where institution_id = p_institution
  union all select 'pr_reviews', count(*) from public.pr_reviews where institution_id = p_institution
  union all select 'issues', count(*) from public.issues where institution_id = p_institution
  union all select 'process_snapshots', count(*) from public.process_snapshots where institution_id = p_institution
  union all select 'grader_suites', count(*) from public.grader_suites where institution_id = p_institution
  union all select 'evaluation_runs', count(*) from public.evaluation_runs where institution_id = p_institution
  union all select 'test_results', count(*) from public.test_results where institution_id = p_institution
  union all select 'branch_pushes', count(*) from public.branch_pushes where institution_id = p_institution
  union all select 'rubric_scores', count(*) from public.rubric_scores where institution_id = p_institution
  union all select 'feedback', count(*) from public.feedback where institution_id = p_institution
  union all select 'grades', count(*) from public.grades where institution_id = p_institution
  union all select 'submission_overview', count(*) from public.submission_overview where institution_id = p_institution
  union all select 'grade_reports', count(*) from public.grade_reports where institution_id = p_institution
  union all select 'submission_snapshots', count(*) from public.submission_snapshots where institution_id = p_institution
  union all select 'notifications', count(*) from public.notifications where institution_id = p_institution
  union all select 'review_comments', count(*) from public.review_comments where institution_id = p_institution
  union all select 'regrade_requests', count(*) from public.regrade_requests where institution_id = p_institution
  union all select 'run_artifacts', count(*) from public.run_artifacts where institution_id = p_institution
$$;

grant execute on all functions in schema tests to authenticated;

begin;
select plan(1);
select ok(true, 'test helpers installed');
select * from finish();
commit;
