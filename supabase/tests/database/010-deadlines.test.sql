-- Deadlines: push history visibility, and extensions reopening finalized submissions.
begin;
select plan(6);

select tests.seed_two_institutions();
-- Student A's submission was finalized as missing work.
update public.submissions set status = 'missing', finalized_at = now(), final_sha = null
  where user_id = tests.id('student_a');
update public.process_snapshots set is_final = true
  where submission_id = (select id from public.submissions where user_id = tests.id('student_a'));

select tests.authenticate_as(tests.id('student_a'));
select is((select count(*)::int from public.branch_pushes), 1, 'students see the pushes to their own repository');
select throws_ok(
  $$ insert into public.branch_pushes (institution_id, repository_id, sha, pushed_at)
     select institution_id, repository_id, repeat('c', 40), now() from public.branch_pushes $$,
  '42501', null, 'but cannot add pushes (the graded commit depends on them)');
select throws_ok($$ update public.submissions set finalized_at = null $$, '42501', null,
  'nor reopen their own submission');
reset role;

select tests.authenticate_as(tests.id('teacher_a'));
update public.assignment_extensions set due_at = now() - interval '30 days'
  where user_id = tests.id('student_a');
select is((select status::text from public.submissions where user_id = tests.id('student_a')), 'missing',
          'an extension that has already run out leaves the submission finalized');
update public.assignment_extensions set due_at = now() + interval '2 days'
  where user_id = tests.id('student_a');
select is((select status::text from public.submissions where user_id = tests.id('student_a')), 'active',
          'an extension into the future reopens it');
reset role;
select is((select is_final from public.process_snapshots
           where submission_id = (select id from public.submissions where user_id = tests.id('student_a'))),
          false, 'and unfreezes the process score');

select * from finish();
rollback;
