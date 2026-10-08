-- Regrade requests: written by the API; students read theirs (after release), staff read their courses'.
begin;
select plan(7);

select tests.seed_two_institutions();
insert into tests.ids values ('sub_a', (select id from public.submissions where user_id = tests.id('student_a')));

select tests.authenticate_as(tests.id('student_a'));
select is((select count(*)::int from public.regrade_requests), 0, 'students see no requests before release');
reset role;

update public.submissions set grade_released_at = now() where id = tests.id('sub_a');
select tests.authenticate_as(tests.id('student_a'));
select is((select message from public.regrade_requests), 'Please look at the search tests again',
          'after release they see their own');
select throws_ok(
  $$ insert into public.regrade_requests (institution_id, submission_id, message)
     values (tests.id('inst_a'), tests.id('sub_a'), 'Another request, directly') $$,
  '42501', null, 'but write them only through the API');
select throws_ok(
  $$ update public.regrade_requests set status = 'accepted', response = 'Accepted by myself', resolved_at = now() $$,
  '42501', null, 'and cannot resolve them');
reset role;

select tests.authenticate_as(tests.id('teacher_a'));
select is((select count(*)::int from public.regrade_requests where submission_id = tests.id('sub_a')), 1,
          'course staff see them');
reset role;

select throws_ok(
  $$ insert into public.regrade_requests (institution_id, submission_id, requested_by, message)
     values (tests.id('inst_a'), tests.id('sub_a'), tests.id('student_a'), 'A second open request') $$,
  '23505', null, 'one open request per submission');
select throws_ok(
  $$ update public.regrade_requests set status = 'declined', resolved_at = now(), response = ''
     where submission_id = tests.id('sub_a') $$,
  '23514', null, 'a decision needs a response');

select * from finish();
rollback;
