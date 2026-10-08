-- Assignments, stack profiles, submissions and repositories.
begin;
select plan(21);

select tests.seed_two_institutions();

-- Stack profiles ---------------------------------------------------------------
select tests.authenticate_as(tests.id('student_a'));
select is((select count(*)::int from public.stack_profiles where institution_id is null), 2, 'global stack profiles are visible to members');
select is((select count(*)::int from public.stack_profiles where id = tests.id('profile_b')), 0, 'another institution''s profile is not');
reset role;

select throws_ok($$ update public.stack_profiles set definition = '{"x":1}' where key = 'mern-node20' $$, 'P0001', null,
  'stack profiles are immutable');

-- Visibility of assignments ----------------------------------------------------------
insert into public.assignments (id, institution_id, course_id, slug, title, stack_profile_id, due_at) values
  ('aaaaaaaa-0000-4000-8000-0000000000a2', tests.id('inst_a'), tests.id('course_a1'), 'draft-one', 'Draft',
   (select id from public.stack_profiles where key = 'mern-node20'), now() + interval '7 days');
insert into public.assignments (id, institution_id, course_id, slug, title, stack_profile_id, due_at, release_at, status) values
  ('aaaaaaaa-0000-4000-8000-0000000000a3', tests.id('inst_a'), tests.id('course_a1'), 'later', 'Later',
   (select id from public.stack_profiles where key = 'mern-node20'), now() + interval '30 days', now() + interval '7 days', 'published');

select tests.authenticate_as(tests.id('student_a'));
select results_eq($$ select id from public.assignments $$, $$ values (tests.id('assign_a1')) $$,
  'students see published, released assignments only (not drafts or unreleased ones)');
select is((select count(*)::int from public.assignment_criteria), 1, 'students see the rubric of visible assignments');
select is((select count(*)::int from public.submissions), 1, 'students see only their own submission');
select is((select count(*)::int from public.repositories), 1, 'students see only their own repository');
with u as (update public.assignments set title = 'Hacked' returning 1)
select is(count(*)::int, 0, 'students cannot edit assignments') from u;
reset role;

select tests.authenticate_as(tests.id('teacher_a'));
select is((select count(*)::int from public.assignments), 3, 'the instructor sees all assignments of the course, drafts included');
select is((select count(*)::int from public.submissions), 1, 'the instructor sees the course''s submissions');
select lives_ok($$ update public.assignments set title = 'Todo API v2' where id = tests.id('assign_a1') $$,
  'the instructor can edit an assignment');
select lives_ok(
  $$ insert into public.assignments (institution_id, course_id, slug, title, stack_profile_id, due_at)
     values (tests.id('inst_a'), tests.id('course_a1'), 'new-one', 'New', (select id from public.stack_profiles where key = 'mern-node20'),
             now() + interval '7 days')
     returning id $$,
  'the instructor can create an assignment and read it back (INSERT ... RETURNING, as the Data API does)');
select throws_ok($$ update public.assignments set status = 'closed' where id = tests.id('assign_a1') $$, '42501', null,
  'status changes go through the API, not the Data API');
select throws_ok(
  $$ update public.assignments set stack_profile_id = (select id from public.stack_profiles where key = 'django-react')
     where id = tests.id('assign_a1') $$,
  'P0001', 'The stack profile is locked once an assignment is published', 'the stack profile is locked after publishing');
select throws_ok(
  $$ insert into public.assignments (institution_id, course_id, slug, title, stack_profile_id, due_at)
     values (tests.id('inst_a'), tests.id('course_a1'), 'x-1', 'Cross', tests.id('profile_b'), now() + interval '7 days') $$,
  '23503', null, 'another institution''s stack profile cannot be used');
select throws_ok(
  $$ insert into public.assignments (institution_id, course_id, slug, title, stack_profile_id, due_at, weights)
     values (tests.id('inst_a'), tests.id('course_a1'), 'x-2', 'Weights', (select id from public.stack_profiles where key = 'mern-node20'),
             now() + interval '7 days', '{"automated": 50, "rubric": 25, "process": 15}') $$,
  '23514', null, 'grade weights must add up to 100');
reset role;

-- Submissions follow enrolment and GitHub linking ----------------------------------
insert into tests.ids (name, id) values
  ('late_gh', tests.create_user('late.gh@test.local', 4001, 'late-gh')),
  ('late_nogh', tests.create_user('late.nogh@test.local'));
insert into public.institution_memberships (institution_id, user_id, role) values
  (tests.id('inst_a'), tests.id('late_gh'), 'student'),
  (tests.id('inst_a'), tests.id('late_nogh'), 'student');
insert into public.course_memberships (institution_id, course_id, user_id, role) values
  (tests.id('inst_a'), tests.id('course_a1'), tests.id('late_gh'), 'student'),
  (tests.id('inst_a'), tests.id('course_a1'), tests.id('late_nogh'), 'student');

select is(
  (select status::text from public.submissions where user_id = tests.id('late_gh') and assignment_id = tests.id('assign_a1')),
  'provisioning', 'a student joining later gets a submission ready to provision');
select is(
  (select count(*)::int from public.submissions where user_id = tests.id('late_gh')),
  2, 'one submission per published assignment, including unreleased ones');
select is(
  (select status::text from public.submissions where user_id = tests.id('late_nogh') and assignment_id = tests.id('assign_a1')),
  'waiting_for_github', 'without a linked GitHub account the submission waits');

insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at, last_sign_in_at)
values ('4002', tests.id('late_nogh'), '{"sub":"4002","user_name":"late-nogh"}', 'github', now(), now(), now());
select is(
  (select status::text from public.submissions where user_id = tests.id('late_nogh') and assignment_id = tests.id('assign_a1')),
  'provisioning', 'linking GitHub releases the waiting submission');

select tests.authenticate_as(tests.id('student_a'));
select throws_ok($$ update public.submissions set status = 'graded' $$, '42501', null, 'students cannot change submissions');
reset role;

select * from finish();
rollback;
