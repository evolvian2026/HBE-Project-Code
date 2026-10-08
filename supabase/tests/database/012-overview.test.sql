-- The submission overview follows the underlying tables' row-level security.
begin;
select plan(5);

select tests.seed_two_institutions();

select tests.authenticate_as(tests.id('student_a'));
select is((select count(*)::int from public.submission_overview), 1, 'a student sees their own submission');
select is((select final_score from public.submission_overview), null, 'without the grade before release');
select is((select latest_run_score::int from public.submission_overview), null,
          'and runs without a score yet');
reset role;

update public.submissions set grade_released_at = now() where user_id = tests.id('student_a');
update public.grades set released_at = now() where user_id = tests.id('student_a');
select tests.authenticate_as(tests.id('student_a'));
select is((select final_score::int from public.submission_overview), 75, 'and with it once released');
reset role;

select tests.authenticate_as(tests.id('teacher_a'));
select is((select count(*)::int from public.submission_overview where final_score is not null), 1,
          'staff see their course''s grades');
reset role;

select * from finish();
rollback;
