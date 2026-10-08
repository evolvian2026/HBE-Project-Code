-- Records: grade reports follow grade release; stored objects follow their records.
begin;
select plan(8);

select tests.seed_two_institutions();

select tests.authenticate_as(tests.id('student_a'));
select is((select count(*)::int from public.grade_reports), 0, 'students see no report before release');
select is((select count(*)::int from storage.objects where bucket_id = 'grade-reports'), 0,
          'nor its file in Storage');
select is((select count(*)::int from public.submission_snapshots), 1, 'but do see the snapshot of their own code');
select is((select count(*)::int from storage.objects where bucket_id = 'submission-archive'), 1,
          'and can download it');
reset role;

update public.submissions set grade_released_at = now() where user_id = tests.id('student_a');
update public.grades set released_at = now() where user_id = tests.id('student_a');
select tests.authenticate_as(tests.id('student_a'));
select is((select count(*)::int from public.grade_reports), 1, 'after release the student sees the report');
select is((select count(*)::int from storage.objects where bucket_id = 'grade-reports'), 1, 'and its file');
reset role;

select tests.authenticate_as(tests.id('teacher_a'));
select is((select count(*)::int from storage.objects where bucket_id = 'grade-reports'), 1,
          'staff see their course''s report files');
select throws_ok($$ delete from public.grade_reports $$, '42501', null, 'reports are immutable');
reset role;

select * from finish();
rollback;
