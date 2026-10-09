-- Run artifacts: whoever can see the run can see (and download) its files; nobody writes them.
begin;
select plan(5);

select tests.seed_two_institutions();

select tests.authenticate_as(tests.id('student_a'));
select is((select count(*)::int from public.run_artifacts), 1, 'students see the files of their runs');
select is((select count(*)::int from storage.objects where bucket_id = 'run-artifacts'), 1, 'and can download them');
select throws_ok(
  $$ insert into public.run_artifacts (institution_id, run_id, name, path, content_type, size)
     select institution_id, run_id, 'logs/fake.log', 'x/fake.log', 'text/plain', 1 from public.run_artifacts $$,
  '42501', null, 'but cannot add any');
reset role;

select tests.authenticate_as(tests.id('teacher_a'));
select is((select count(*)::int from public.run_artifacts), 1, 'course staff see them too');
reset role;

select tests.authenticate_as(tests.id('admin_b'));
select is((select count(*)::int from storage.objects where bucket_id = 'run-artifacts'), 1,
          'other institutions only see their own');
reset role;

select * from finish();
rollback;
