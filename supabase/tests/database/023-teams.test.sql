-- Teams: everyone in the course sees its teams, members see their teammates, and a team shares
-- its repository's runs and code comments, but each member's grade, rubric, feedback and
-- process score stay their own. Only the api writes teams.
begin;
select plan(14);

select tests.seed_two_institutions();

-- A second student in Red, and a team assignment both work on in one repository.
insert into tests.ids (name, id) values ('mate_a', tests.create_user('mate.a@test.local', 1002, 'mate-a'));
insert into public.institution_memberships (institution_id, user_id, role)
  values (tests.id('inst_a'), tests.id('mate_a'), 'student');
insert into public.course_memberships (institution_id, course_id, user_id, role)
  values (tests.id('inst_a'), tests.id('course_a1'), tests.id('mate_a'), 'student');
insert into public.team_members (institution_id, course_id, team_id, user_id)
  select institution_id, course_id, id, tests.id('mate_a') from public.teams where slug = 'red';
insert into public.assignments (institution_id, course_id, slug, title, mode, stack_profile_id, due_at, status, published_at)
  values (tests.id('inst_a'), tests.id('course_a1'), 'team-shop', 'Team shop', 'team',
          (select id from public.stack_profiles where key = 'mern-node20' and institution_id is null),
          now() + interval '7 days', 'published', now());
select private.ensure_submissions((select id from public.assignments where slug = 'team-shop'));
insert into tests.ids (name, id)
  select 'sub_' || (case when user_id = tests.id('student_a') then 'student' else 'mate' end), id
  from public.submissions where assignment_id = (select id from public.assignments where slug = 'team-shop');
update public.submissions set repository_id = (select id from public.repositories where name = 'todo-api-student-a'),
                              status = 'active'
  where id in (tests.id('sub_student'), tests.id('sub_mate'));
insert into public.evaluation_runs (institution_id, submission_id, sha, trigger, status, callback_token_hash)
  values (tests.id('inst_a'), tests.id('sub_student'), repeat('e', 40), 'push', 'completed', 'h');
insert into public.feedback (institution_id, submission_id, body_md) values (tests.id('inst_a'), tests.id('sub_student'), 'Mine');

select is((select team_id from public.submissions where id = tests.id('sub_mate')),
          (select id from public.teams where slug = 'red'), 'team assignments put members'' submissions in their team');

select tests.authenticate_as(tests.id('mate_a'));
select is((select count(*)::int from public.teams), 1, 'students see their course''s teams');
select is((select count(*)::int from public.team_members), 2, 'and their teammates');
select ok(exists (select 1 from public.profiles where id = tests.id('student_a')), 'and teammates'' names');
select ok(exists (select 1 from public.submissions where id = tests.id('sub_student')), 'and teammates'' submissions');
select is((select count(*)::int from public.evaluation_runs where submission_id = tests.id('sub_student')), 1,
          'and the team''s runs');
select is((select count(*)::int from public.feedback where submission_id = tests.id('sub_student')), 0,
          'but not a teammate''s feedback');
select is((select count(*)::int from public.process_snapshots where submission_id = tests.id('sub_student')), 0,
          'or process score');
select throws_ok($$ insert into public.teams (institution_id, course_id, name, slug)
                   values (tests.id('inst_a'), tests.id('course_a1'), 'Mine', 'mine') $$,
  '42501', null, 'students can''t make teams');
reset role;

select tests.authenticate_as(tests.id('teacher_a'));
select throws_ok($$ insert into public.team_members (institution_id, course_id, team_id, user_id)
                   select institution_id, course_id, id, tests.id('teacher_a') from public.teams where slug = 'red' $$,
  '42501', null, 'teams change through the api only');
reset role;

-- Integrity: a member must be in the course, and the team must be the course's.
select throws_ok($$ insert into public.team_members (institution_id, course_id, team_id, user_id)
                   select institution_id, course_id, id, tests.id('admin_a') from public.teams where slug = 'red' $$,
  '23503', null, 'team members are course members');
select throws_ok($$ insert into public.team_members (institution_id, course_id, team_id, user_id)
                   select t.institution_id, tests.id('course_a2'), t.id, tests.id('student_a') from public.teams t where slug = 'red' $$,
  '23503', null, 'a team belongs to one course');
select throws_ok($$ update public.assignments set mode = 'individual' where slug = 'team-shop' $$,
  'P0001', null, 'individual or team is locked once published');
select throws_ok($$ insert into public.team_members (institution_id, course_id, team_id, user_id)
                   select institution_id, course_id, id, tests.id('mate_a') from public.teams where slug = 'red' $$,
  '23505', null, 'a student is in one team per course');

select * from finish();
rollback;
