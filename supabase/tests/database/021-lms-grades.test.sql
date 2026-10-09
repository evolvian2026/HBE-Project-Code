-- LMS gradebooks: course staff see their assignments' gradebook columns and what was sent
-- there; students see neither; only the api and worker write; deep linking requests are
-- for nobody.
begin;
select plan(9);

select tests.seed_two_institutions();

select tests.authenticate_as(tests.id('teacher_a'));
select is((select count(*)::int from public.lms_assignment_links), 1, 'instructors see their assignment''s gradebook column');
select is((select count(*)::int from public.lms_grade_syncs), 1, 'and the grades sent there');
select throws_ok(
  $$ update public.lms_grade_syncs set status = 'failed' $$,
  '42501', null, 'grade syncs are written by the worker');
reset role;

select tests.authenticate_as(tests.id('admin_a'));
select is((select count(*)::int from public.lms_grade_syncs), 1, 'admins see their institution''s grade syncs');
reset role;

select tests.authenticate_as(tests.id('student_a'));
select is((select count(*)::int from public.lms_assignment_links), 0, 'students don''t see gradebook columns');
select is((select count(*)::int from public.lms_grade_syncs), 0, 'or grade syncs');
reset role;

-- One sync per grade version and column.
select throws_ok(
  $$ insert into public.lms_grade_syncs (institution_id, grade_id, submission_id, lms_assignment_link_id)
     select institution_id, grade_id, submission_id, lms_assignment_link_id from public.lms_grade_syncs limit 1 $$,
  '23505', null, 'a grade version is sent to a column once');

-- A gradebook column can't point at another institution's assignment.
select throws_ok(
  $$ insert into public.lms_assignment_links (institution_id, assignment_id, lms_course_link_id)
     select tests.id('inst_a'), tests.id('assign_b1'), l.id from public.lms_course_links l
     where l.institution_id = tests.id('inst_a') limit 1 $$,
  '23503', null, 'gradebook columns stay within the institution');

insert into public.lti_deep_link_requests (token_hash, lms_connection_id, profile_id, deployment_id, return_url, expires_at)
  values (repeat('d', 64), tests.id('lms_a'), tests.id('teacher_a'), 'dep-a', 'https://canvas.test/return', now() + interval '1 hour');
select tests.authenticate_as(tests.id('teacher_a'));
select is((select count(*)::int from public.lti_deep_link_requests), 0, 'deep linking requests are not readable by users');
reset role;

select * from finish();
rollback;
