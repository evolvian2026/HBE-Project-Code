-- Email notifications: a notification is queued for email when its user wants that type.
begin;
select plan(6);

select tests.seed_two_institutions();

select is((select count(*)::int from public.email_outbox where template = 'notification'
           and to_email = 'student.a@test.local' and payload->>'type' = 'grade_released'), 1,
          'seeded grade notifications were queued for email');

insert into public.notifications (institution_id, user_id, type, title, dedupe_key)
  values (tests.id('inst_a'), tests.id('student_a'), 'run_finished', 'Test results: 3/4 passed', 'run:email-test');
select is((select count(*)::int from public.email_outbox where payload->>'title' = 'Test results: 3/4 passed'), 0,
          'test results are in-app only by default');

select tests.authenticate_as(tests.id('student_a'));
update public.profiles set email_notification_types = '{run_finished}' where id = tests.id('student_a');
select is((select email_notification_types from public.profiles where id = tests.id('student_a')), '{run_finished}',
          'users choose their email types');
select throws_ok(
  $$ update public.profiles set email_notification_types = '{everything}' where id = tests.id('student_a') $$,
  '23514', null, 'only known types');
update public.profiles set email_notification_types = '{}' where id = tests.id('student_b');
reset role;
select isnt((select email_notification_types from public.profiles where id = tests.id('student_b')), '{}',
            'and only their own');

insert into public.notifications (institution_id, user_id, type, title, dedupe_key)
  values (tests.id('inst_a'), tests.id('student_a'), 'run_finished', 'Test results: 4/4 passed', 'run:email-test-2');
select is((select count(*)::int from public.email_outbox where payload->>'title' = 'Test results: 4/4 passed'), 1,
          'which then are emailed');

select * from finish();
rollback;
