-- Inline code review comments: staff write them; students read them once grades are released.
begin;
select plan(8);

select tests.seed_two_institutions();
insert into tests.ids values ('sub_a', (select id from public.submissions where user_id = tests.id('student_a')));

select tests.authenticate_as(tests.id('student_a'));
select is((select count(*)::int from public.review_comments), 0, 'students see no review comments before release');
select throws_ok(
  $$ insert into public.review_comments (institution_id, submission_id, sha, path, line, body)
     values (tests.id('inst_a'), tests.id('sub_a'), repeat('c', 40), 'a.js', 1, 'Self review') $$,
  '42501', null, 'and cannot write them');
reset role;

update public.submissions set grade_released_at = now() where id = tests.id('sub_a');
select tests.authenticate_as(tests.id('student_a'));
select is((select body from public.review_comments), 'Validate the title here', 'after release they do');
reset role;

select tests.authenticate_as(tests.id('teacher_a'));
insert into public.review_comments (institution_id, submission_id, sha, path, line, body)
  values (tests.id('inst_a'), tests.id('sub_a'), repeat('c', 40), 'src/app.js', 7, 'Nice error handling');
select is((select author_id from public.review_comments where line = 7), tests.id('teacher_a'),
          'staff comment, with themselves as the author');
select throws_ok(
  $$ insert into public.review_comments (institution_id, submission_id, sha, path, line, body)
     values (tests.id('inst_b'), tests.id('sub_a'), repeat('c', 40), 'a.js', 1, 'Wrong tenant') $$,
  null, null, 'never under another institution');
update public.review_comments set body = 'Edited by someone else' where line = 3;
select is((select body from public.review_comments where line = 3), 'Validate the title here',
          'and only edit their own comments');
update public.review_comments set body = 'Really nice error handling' where line = 7;
select is((select body from public.review_comments where line = 7), 'Really nice error handling', 'which they can edit');
reset role;

select tests.authenticate_as(tests.id('admin_b'));
select is((select count(*)::int from public.review_comments where submission_id = tests.id('sub_a')), 0,
          'other institutions see nothing');
reset role;

select * from finish();
rollback;
