-- Activity data is visible to the repository's student and course staff only.
begin;
select plan(6);

select tests.seed_two_institutions();

-- A second student in course A without access to student_a's repository
insert into tests.ids (name, id) values ('student_a2', tests.create_user('student.a2@test.local'));
insert into public.institution_memberships (institution_id, user_id, role) values (tests.id('inst_a'), tests.id('student_a2'), 'student');
insert into public.course_memberships (institution_id, course_id, user_id, role) values (tests.id('inst_a'), tests.id('course_a1'), tests.id('student_a2'), 'student');

select tests.authenticate_as(tests.id('student_a'));
select is((select count(*)::int from public.commits), 1, 'a student sees the commits of their own repository');
select is((select count(*)::int from public.process_snapshots), 1, 'and their own process score');
reset role;

select tests.authenticate_as(tests.id('student_a2'));
select is((select count(*)::int from public.commits), 0, 'classmates cannot see each other''s activity');
select is((select count(*)::int from public.process_snapshots), 0, 'or process scores');
reset role;

select tests.authenticate_as(tests.id('teacher_a'));
select is((select count(*)::int from public.issues), 1, 'course staff see activity in their course''s repositories');
select throws_ok($$ delete from public.commits $$, '42501', null, 'activity is written by the worker only');
reset role;

select * from finish();
rollback;
