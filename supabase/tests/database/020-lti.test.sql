-- LMS connections (LTI 1.3): staff see the connections, admins review LMS users, people see
-- their own link, teachers see LMS courses waiting to be linked, and only the API writes.
begin;
select plan(13);

select tests.seed_two_institutions();

select tests.authenticate_as(tests.id('admin_a'));
select is((select count(*)::int from public.lms_connections where type <> 'google_classroom'), 1,
  'admins see their LMS connection');
select is((select count(*)::int from public.lms_user_links), 2, 'and every LMS user, the review queue included');
select is((select count(*)::int from public.lms_course_links), 2, 'and every LMS course');
select is((select count(*)::int from public.lti_registration_invites), 0, 'but not registration invites (hashes)');
select throws_ok(
  $$ insert into public.lms_connections (institution_id, type, name, issuer, client_id, auth_login_url, auth_token_url, jwks_url)
     values (tests.id('inst_a'), 'lti', 'x', 'https://x.test', 'c', 'https://x.test/a', 'https://x.test/t', 'https://x.test/j') $$,
  '42501', null, 'connections are added through the API');
select throws_ok(
  $$ update public.lms_user_links set status = 'rejected' $$,
  '42501', null, 'the review queue is resolved through the API');
reset role;

select tests.authenticate_as(tests.id('teacher_a'));
select is((select count(*)::int from public.lms_connections where type <> 'google_classroom'), 1,
  'teachers see the connection');
select is((select count(*)::int from public.lms_user_links), 0, 'but not LMS users');
select results_eq(
  $$ select context_id from public.lms_course_links order by context_id $$,
  $$ values ('ctx-new'), ('ctx-web') $$,
  'teachers see their linked LMS course and the ones waiting to be linked');
reset role;

select tests.authenticate_as(tests.id('student_a'));
select is((select count(*)::int from public.lms_connections), 0, 'students don''t see connections');
select results_eq($$ select lms_user_id from public.lms_user_links $$, $$ values ('canvas-student-a') $$,
  'students see their own LMS link');
select is((select count(*)::int from public.lms_course_links), 0, 'and no LMS courses');
reset role;

-- A linked LMS user must have a profile, and a pending one must not.
select throws_ok(
  $$ insert into public.lms_user_links (institution_id, lms_connection_id, lms_user_id, status)
     values (tests.id('inst_a'), tests.id('lms_a'), 'no-profile', 'linked') $$,
  '23514', null, 'a linked LMS user has a profile');

select * from finish();
rollback;
