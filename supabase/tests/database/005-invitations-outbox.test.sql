-- Invitation de-duplication and the invitation email outbox.
begin;
select plan(7);

select tests.seed_two_institutions();

select is(
  (select count(*)::int from public.email_outbox where to_email = 'pending.a@test.local' and template = 'invitation'),
  1, 'creating an email invitation queues one email');

select is(
  (select payload ->> 'institution_name' from public.email_outbox where to_email = 'pending.a@test.local'),
  'Alpha University', 'the email payload names the institution');

insert into public.invitations (institution_id, github_login, role) values (tests.id('inst_a'), 'some-login', 'student');
select is((select count(*)::int from public.email_outbox where institution_id = tests.id('inst_a') and template = 'invitation'), 1,
  'a GitHub-login-only invitation queues no email');

select throws_ok(
  $$ insert into public.invitations (institution_id, email, role) values (tests.id('inst_a'), 'PENDING.A@test.local', 'teacher') $$,
  '23505', null, 'a second pending invitation for the same email (any case) is rejected');

select lives_ok(
  $$ insert into public.invitations (institution_id, email, role, course_id, course_role)
     values (tests.id('inst_a'), 'pending.a@test.local', 'student', tests.id('course_a1'), 'student') $$,
  'the same person can also be invited to a specific course');

select lives_ok(
  $$ insert into public.invitations (institution_id, email, role) values (tests.id('inst_b'), 'pending.a@test.local', 'student') $$,
  'other institutions can invite the same person');

select tests.authenticate_as(tests.id('admin_a'));
select is_empty($$ select id from public.email_outbox $$, 'users cannot read the email outbox');
reset role;

select * from finish();
rollback;
