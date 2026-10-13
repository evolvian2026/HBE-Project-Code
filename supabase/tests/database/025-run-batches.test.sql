-- Bulk re-runs: the course's staff see an assignment's re-runs; students don't, and only the
-- api starts them. An institution can be deleted with the suites its runs used. Runs are
-- published to Realtime.
begin;
select plan(7);

select tests.seed_two_institutions();

select tests.authenticate_as(tests.id('teacher_a'));
select is((select count(*)::int from public.run_batches), 1, 'course staff see the assignment''s re-runs');
select is((select count(*)::int from public.evaluation_runs where batch_id is not null), 1, 'and which runs they made');
select throws_ok($$ insert into public.run_batches (institution_id, assignment_id, grader_suite_id, scope)
                   select institution_id, assignment_id, grader_suite_id, 'all' from public.run_batches $$,
  '42501', null, 're-runs start through the api only');
reset role;

select tests.authenticate_as(tests.id('student_a'));
select is((select count(*)::int from public.run_batches), 0, 'students don''t see re-runs');
reset role;

-- Institution B's own suite, used by its runs and re-runs.
update public.evaluation_runs set grader_suite_id = (select id from public.grader_suites where key = 'beta-suite')
  where institution_id = tests.id('inst_b');
update public.run_batches set grader_suite_id = (select id from public.grader_suites where key = 'beta-suite')
  where institution_id = tests.id('inst_b');
select lives_ok($$ delete from public.institutions where id = tests.id('inst_b') $$,
  'an institution is deleted with the suites its runs used');
select is((select count(*)::int from public.grader_suites where key = 'beta-suite'), 0, 'and they''re gone');

-- Live run status: runs are published to Realtime (which applies the same RLS and grants).
select ok(exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'evaluation_runs'),
          'run changes are sent live to those who may read them');

select * from finish();
rollback;
