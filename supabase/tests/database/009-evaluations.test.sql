-- Evaluation runs and results: visibility, columns students must not read, and suite tenancy.
begin;
select plan(12);

select tests.seed_two_institutions();
insert into tests.ids values
  ('suite_b', (select id from public.grader_suites where key = 'beta-suite')),
  ('run_a', (select id from public.evaluation_runs where institution_id = tests.id('inst_a')));

select tests.authenticate_as(tests.id('student_a'));
select is((select count(*)::int from public.evaluation_runs), 1, 'a student sees runs of their own submission');
select is((select title from public.test_results), 'Creates a todo', 'and the failure details');
select throws_ok($$ select staff_notes from public.test_results $$, '42501', null, 'but not the staff notes');
select throws_ok($$ select callback_token_hash from public.evaluation_runs $$, '42501', null, 'or the grader callback token');
select is((select count(*)::int from public.run_staff_notes(tests.id('run_a'))), 0,
          'and the staff notes function returns nothing to them');
select is((select count(*)::int from public.grader_suites where institution_id is null), 1, 'global suites are visible');
reset role;

select tests.authenticate_as(tests.id('teacher_a'));
select is((select count(*)::int from public.test_results), 1, 'course staff see their course''s results');
select is((select staff_notes from public.run_staff_notes(tests.id('run_a'))),
          'Common cause: missing await', 'and read the staff notes through the function');
select throws_ok($$ update public.evaluation_runs set score = 100 $$, '42501', null, 'nobody edits run results through the Data API');
select lives_ok(
  $$ update public.assignments set grader_suite_id = (select id from public.grader_suites where key = 'todo-api')
     where id = tests.id('assign_a1') $$,
  'instructors choose a global grader suite');
select throws_ok(
  $$ update public.assignments set grader_suite_id = tests.id('suite_b') where id = tests.id('assign_a1') $$,
  '23503', 'That grader suite belongs to another institution', 'but not another institution''s hidden suite');
reset role;

select tests.authenticate_as(tests.id('admin_b'));
select is((select count(*)::int from public.run_staff_notes(tests.id('run_a'))), 0,
          'admins of another institution get no notes');
reset role;

select * from finish();
rollback;
