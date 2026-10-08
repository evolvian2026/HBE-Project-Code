-- Grading: hidden from students until released; overrides' reasons stay with staff.
begin;
select plan(14);

select tests.seed_two_institutions();
insert into tests.ids values
  ('sub_a', (select id from public.submissions where user_id = tests.id('student_a'))),
  ('criterion_b', (select id from public.assignment_criteria where institution_id = tests.id('inst_b')));

select tests.authenticate_as(tests.id('student_a'));
select is((select count(*)::int from public.grades), 0, 'students see no grade before release');
select is((select count(*)::int from public.rubric_scores), 0, 'nor rubric scores');
select is((select count(*)::int from public.feedback), 0, 'nor feedback');
reset role;

-- Released; then staff change the grade again (version 2) without releasing that version.
update public.submissions set grade_released_at = now() where id = tests.id('sub_a');
update public.grades set released_at = now() where submission_id = tests.id('sub_a');
update public.grades set is_current = false where submission_id = tests.id('sub_a');
insert into public.grades (institution_id, submission_id, user_id, version, components, computed_score, final_score, complete)
  values (tests.id('inst_a'), tests.id('sub_a'), tests.id('student_a'), 2, '{}', 60, 60, true);

select tests.authenticate_as(tests.id('student_a'));
select is((select final_score::int from public.grades), 75, 'after release the student sees the released version only');
select is((select comment from public.rubric_scores), 'Readable code', 'and the rubric comments');
select is((select body_md from public.feedback), 'Good work', 'and the feedback');
select throws_ok($$ select override_reason from public.grades $$, '42501', null, 'but not why a grade was overridden');
select is((select count(*)::int from public.grade_override_reasons(tests.id('sub_a'))), 0,
          'not even through the staff function');
select throws_ok($$ update public.grades set final_score = 100 $$, '42501', null, 'and cannot change grades');
reset role;

select tests.authenticate_as(tests.id('teacher_a'));
select is((select count(*)::int from public.grades), 2, 'course staff see every version');
select is((select override_reason from public.grade_override_reasons(tests.id('sub_a')) where version = 1),
          'Bonus for documentation', 'and the override reasons');
select throws_ok(
  $$ insert into public.rubric_scores (institution_id, submission_id, criterion_id, points)
     values (tests.id('inst_a'), tests.id('sub_a'), (select id from public.assignment_criteria limit 1), 1) $$,
  '42501', null, 'staff grade through the API, not the Data API');
reset role;

select throws_ok(
  $$ update public.rubric_scores set points = 11 where submission_id = tests.id('sub_a') $$,
  '23514', 'At most 10.00 points for this criterion', 'points never exceed the criterion''s maximum');
select throws_ok(
  $$ insert into public.rubric_scores (institution_id, submission_id, criterion_id, points)
     values (tests.id('inst_a'), tests.id('sub_a'), tests.id('criterion_b'), 1) $$,
  '23503', null, 'and scores only use the assignment''s own criteria');

select * from finish();
rollback;
