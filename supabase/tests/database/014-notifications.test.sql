-- Notifications: each user reads their own and can only mark them read.
begin;
select plan(7);

select tests.seed_two_institutions();
-- The seed's extensions already notified the students; start from the seeded notification only.
delete from public.notifications where type = 'extension_granted';

select tests.authenticate_as(tests.id('student_a'));
select is((select count(*)::int from public.notifications), 1, 'a user sees their own notifications');
update public.notifications set read_at = now();
select is((select count(*)::int from public.notifications where read_at is not null), 1, 'and marks them read');
select throws_ok($$ update public.notifications set title = 'hacked' $$, '42501', null, 'but cannot change them');
select throws_ok(
  $$ insert into public.notifications (institution_id, user_id, type, title) values (tests.id('inst_a'), auth.uid(), 'grade_released', 'x') $$,
  '42501', null, 'or create them');
reset role;

select tests.authenticate_as(tests.id('teacher_a'));
select is((select count(*)::int from public.notifications), 0, 'staff do not see students'' notifications');
update public.assignment_extensions set due_at = now() + interval '30 days', reason = 'Medical certificate'
  where user_id = tests.id('student_a');
reset role;

select is((select title from public.notifications where user_id = tests.id('student_a') and type = 'extension_granted'),
          'Your deadline for Todo API was extended', 'granting an extension notifies the student');
select is((select body from public.notifications where user_id = tests.id('student_a') and type = 'extension_granted'),
          'Medical certificate', 'with the reason');

select * from finish();
rollback;
