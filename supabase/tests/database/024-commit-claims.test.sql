-- Commit claims: a student sees their own claims, course staff of the repository see the claims
-- to review, and only the api writes them. One claim per commit can be approved.
begin;
select plan(14);

select tests.seed_two_institutions();

-- A classmate, and a teacher of the institution's other course.
insert into tests.ids (name, id) values
  ('student_a2', tests.create_user('student.a2@test.local')),
  ('teacher_a2', tests.create_user('teacher.a2@test.local'));
insert into public.institution_memberships (institution_id, user_id, role) values
  (tests.id('inst_a'), tests.id('student_a2'), 'student'),
  (tests.id('inst_a'), tests.id('teacher_a2'), 'teacher');
insert into public.course_memberships (institution_id, course_id, user_id, role) values
  (tests.id('inst_a'), tests.id('course_a1'), tests.id('student_a2'), 'student'),
  (tests.id('inst_a'), tests.id('course_a2'), tests.id('teacher_a2'), 'instructor');
insert into tests.ids (name, id)
  select 'claim_a', k.id from public.commit_claims k where k.institution_id = tests.id('inst_a');

select tests.authenticate_as(tests.id('student_a'));
select is((select count(*)::int from public.commit_claims), 1, 'a student sees their claims');
select is((select count(*)::int from public.commit_author_aliases), 1, 'and the emails confirmed as theirs');
select throws_ok($$ insert into public.commit_claims (institution_id, commit_id, repository_id, claimed_by)
                   select institution_id, id, repository_id, tests.id('student_a') from public.commits
                   where author_profile_id is not null $$,
  '42501', null, 'students claim through the api only');
reset role;

select tests.authenticate_as(tests.id('student_a2'));
select is((select count(*)::int from public.commit_claims), 0, 'classmates don''t see each other''s claims');
select is((select count(*)::int from public.commit_author_aliases), 0, 'or emails');
reset role;

select tests.authenticate_as(tests.id('teacher_a'));
select is((select count(*)::int from public.commit_claims), 1, 'course staff see claims in their course''s repositories');
select is((select count(*)::int from public.commit_author_aliases), 1, 'and the institution''s confirmed emails');
select throws_ok($$ update public.commit_claims set status = 'approved' $$,
  '42501', null, 'claims are decided through the api only');
reset role;

select tests.authenticate_as(tests.id('teacher_a2'));
select is((select count(*)::int from public.commit_claims), 0, 'other courses'' staff don''t see the claims');
reset role;

-- Integrity.
update public.commit_claims set status = 'approved' where id = tests.id('claim_a');
select throws_ok($$ insert into public.commit_claims (institution_id, commit_id, repository_id, claimed_by, status)
                   select institution_id, commit_id, repository_id, tests.id('student_a2'), 'approved'
                   from public.commit_claims where id = tests.id('claim_a') $$,
  '23505', null, 'a commit is credited to one person');
select throws_ok($$ insert into public.commit_claims (institution_id, commit_id, repository_id, claimed_by)
                   select tests.id('inst_b'), commit_id, repository_id, tests.id('student_b')
                   from public.commit_claims where id = tests.id('claim_a') $$,
  '23503', null, 'a claim is to a commit of its institution');
select throws_ok($$ insert into public.commit_author_aliases (institution_id, email, profile_id)
                   values (tests.id('inst_a'), 'Ada@Home.test', tests.id('student_a2')) $$,
  '23514', null, 'confirmed emails are stored lower-case');
select throws_ok($$ update public.commits set attribution = 'guess' $$,
  '23514', null, 'a commit is attributed by GitHub, a claim or a confirmed email');
select lives_ok($$ insert into public.notifications (institution_id, user_id, type, title, dedupe_key)
                   values (tests.id('inst_a'), tests.id('teacher_a'), 'commit_claim', 'Ada claimed 1 commit', 'claim-1') $$,
  'staff are notified of claims');

select * from finish();
rollback;
