-- Who sees a submission's runs and results (the set-based policies of 20261108000001): the
-- student, their teammates, the course's instructors and TAs, and the institution's admins
-- with two-factor authentication. Not classmates outside the team, other teachers, or
-- anyone in another institution.
begin;
select plan(13);

select tests.seed_two_institutions();

-- Red team (student_a and mate_a) works on a team assignment; other_a is in the course, not
-- the team; teacher2_a teaches at the institution but not this course.
insert into tests.ids (name, id) values
  ('mate_a', tests.create_user('mate.a@test.local', 1002, 'mate-a')),
  ('other_a', tests.create_user('other.a@test.local', 1003, 'other-a')),
  ('teacher2_a', tests.create_user('teacher2.a@test.local'));
insert into public.institution_memberships (institution_id, user_id, role) values
  (tests.id('inst_a'), tests.id('mate_a'), 'student'),
  (tests.id('inst_a'), tests.id('teacher2_a'), 'teacher');
insert into public.course_memberships (institution_id, course_id, user_id, role)
  values (tests.id('inst_a'), tests.id('course_a1'), tests.id('mate_a'), 'student');
insert into public.team_members (institution_id, course_id, team_id, user_id)
  select institution_id, course_id, id, tests.id('mate_a') from public.teams where slug = 'red';
insert into public.assignments (institution_id, course_id, slug, title, mode, stack_profile_id, due_at, status, published_at)
  values (tests.id('inst_a'), tests.id('course_a1'), 'team-shop', 'Team shop', 'team',
          (select id from public.stack_profiles where key = 'mern-node20' and institution_id is null),
          now() + interval '7 days', 'published', now());
select private.ensure_submissions((select id from public.assignments where slug = 'team-shop'));
insert into tests.ids (name, id)
  select 'sub_student', id from public.submissions
  where assignment_id = (select id from public.assignments where slug = 'team-shop') and user_id = tests.id('student_a');
insert into public.evaluation_runs (id, institution_id, submission_id, sha, trigger, status, callback_token_hash)
  values ('aaaaaaaa-0000-4000-8000-00000000e028', tests.id('inst_a'), tests.id('sub_student'), repeat('e', 40), 'push',
          'completed', 'h');
insert into public.test_results (institution_id, run_id, stage, test_key, title, status)
  values (tests.id('inst_a'), 'aaaaaaaa-0000-4000-8000-00000000e028', 'api', 'shop.cart', 'Adds to the cart', 'passed');
-- Joins the course after the team assignment's submissions were made.
insert into public.institution_memberships (institution_id, user_id, role)
  values (tests.id('inst_a'), tests.id('other_a'), 'student');
insert into public.course_memberships (institution_id, course_id, user_id, role)
  values (tests.id('inst_a'), tests.id('course_a1'), tests.id('other_a'), 'student');

create function pg_temp.sees() returns text language sql as $$
  select (select count(*) from public.submissions where id = tests.id('sub_student')) || ' submission, '
      || (select count(*) from public.evaluation_runs where submission_id = tests.id('sub_student')) || ' run, '
      || (select count(*) from public.test_results where run_id = 'aaaaaaaa-0000-4000-8000-00000000e028') || ' result';
$$;

create temp table all_team_shop as
  select count(*)::int as n from public.submissions where assignment_id = (select id from public.assignments where slug = 'team-shop');
grant select on all_team_shop to authenticated;

select tests.authenticate_as(tests.id('student_a'));
select is(pg_temp.sees(), '1 submission, 1 run, 1 result', 'the student sees their run and its results');
reset role;
select tests.authenticate_as(tests.id('mate_a'));
select is(pg_temp.sees(), '1 submission, 1 run, 1 result', 'so does their teammate');
reset role;
select tests.authenticate_as(tests.id('other_a'));
select is(pg_temp.sees(), '0 submission, 0 run, 0 result', 'but not a classmate outside the team');
reset role;
select tests.authenticate_as(tests.id('teacher_a'));
select is(pg_temp.sees(), '1 submission, 1 run, 1 result', 'the course''s instructor does');
select is((select count(*)::int from public.submissions
           where assignment_id = (select id from public.assignments where slug = 'team-shop')),
          (select n from all_team_shop), 'with every submission of the assignment');
reset role;
select tests.authenticate_as(tests.id('teacher2_a'));
select is(pg_temp.sees(), '0 submission, 0 run, 0 result', 'another teacher at the institution doesn''t');
reset role;
select tests.authenticate_as(tests.id('admin_a'));
select is(pg_temp.sees(), '1 submission, 1 run, 1 result', 'the institution''s admin does');
reset role;
select tests.authenticate_as(tests.id('admin_a'), 'aal1');
select is(pg_temp.sees(), '0 submission, 0 run, 0 result', 'but not without two-factor authentication');
reset role;
select tests.authenticate_as(tests.id('admin_b'));
select is(pg_temp.sees(), '0 submission, 0 run, 0 result', 'nor another institution''s admin');
reset role;
select tests.authenticate_as(tests.id('student_b'));
select is(pg_temp.sees(), '0 submission, 0 run, 0 result', 'nor another institution''s student');
reset role;

-- A TA is staff too; a deactivated member isn't, whatever their course role.
update public.course_memberships set role = 'ta' where user_id = tests.id('teacher_a') and course_id = tests.id('course_a1');
select tests.authenticate_as(tests.id('teacher_a'));
select is(pg_temp.sees(), '1 submission, 1 run, 1 result', 'a TA sees them');
reset role;
update public.institution_memberships set status = 'deactivated'
  where user_id = tests.id('teacher_a') and institution_id = tests.id('inst_a');
select tests.authenticate_as(tests.id('teacher_a'));
select is(pg_temp.sees(), '0 submission, 0 run, 0 result', 'a deactivated member doesn''t');
reset role;
update public.institution_memberships set status = 'deactivated'
  where user_id = tests.id('mate_a') and institution_id = tests.id('inst_a');
select tests.authenticate_as(tests.id('mate_a'));
select is(pg_temp.sees(), '0 submission, 0 run, 0 result', 'nor does a deactivated teammate');
reset role;

select * from finish();
rollback;
