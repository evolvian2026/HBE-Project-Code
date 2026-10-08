-- Who may write what, through the Data API (RLS + column privileges).
begin;
select plan(16);

select tests.seed_two_institutions();

-- Courses ---------------------------------------------------------------------
select tests.authenticate_as(tests.id('student_a'));
select throws_ok(
  $$ insert into public.courses (institution_id, code, name, term) values (tests.id('inst_a'), 'X1', 'Nope', 'T1') $$,
  '42501', null, 'a student cannot create a course');
reset role;

select tests.authenticate_as(tests.id('teacher_a'));
select lives_ok(
  $$ insert into public.courses (id, institution_id, code, name, term)
     values ('aaaaaaaa-0000-4000-8000-0000000000c9', tests.id('inst_a'), 'CS301', 'APIs', '2026-T1') $$,
  'a teacher can create a course in their institution');
select is(
  (select role::text from public.course_memberships
    where course_id = 'aaaaaaaa-0000-4000-8000-0000000000c9' and user_id = tests.id('teacher_a')),
  'instructor', 'the course creator becomes its instructor');
select throws_ok(
  $$ insert into public.courses (institution_id, code, name, term) values (tests.id('inst_b'), 'X2', 'Nope', 'T1') $$,
  '42501', null, 'a teacher cannot create a course in another institution');
reset role;

-- Memberships -----------------------------------------------------------------
select tests.authenticate_as(tests.id('admin_a'));
select lives_ok(
  $$ update public.institution_memberships set role = 'teacher'
     where institution_id = tests.id('inst_a') and user_id = tests.id('student_a') $$,
  'an admin can change roles in their institution');
with u as (update public.institution_memberships set role = 'admin' where institution_id = tests.id('inst_b') returning 1)
select is(count(*)::int, 0, 'an admin cannot change memberships of another institution') from u;
reset role;

select tests.authenticate_as(tests.id('teacher_a'));
with u as (update public.institution_memberships set role = 'admin' where user_id = tests.id('teacher_a') returning 1)
select is(count(*)::int, 0, 'a teacher cannot promote themselves') from u;
reset role;

-- Profiles: only cosmetic fields are editable --------------------------------
select tests.authenticate_as(tests.id('student_a'));
select lives_ok($$ update public.profiles set full_name = 'Student A' where id = tests.id('student_a') $$,
  'a user can edit their display name');
select throws_ok($$ update public.profiles set github_user_id = 2001 where id = tests.id('student_a') $$,
  '42501', null, 'a user cannot change their GitHub id (commit attribution)');
select throws_ok($$ insert into public.user_roles (user_id, role) values (tests.id('student_a'), 'super_admin') $$,
  '42501', null, 'a user cannot grant themselves super admin');
reset role;

-- Institutions ----------------------------------------------------------------
select tests.authenticate_as(tests.id('admin_a'));
select throws_ok($$ insert into public.institutions (name, slug) values ('Rogue', 'rogue') $$,
  '42501', null, 'an institution admin cannot create institutions');
with u as (update public.institutions set status = 'active', name = 'Renamed' returning 1)
select is(count(*)::int, 0, 'an institution admin cannot edit institution records (limits, status)') from u;
reset role;

select tests.authenticate_as(tests.id('super'));
select lives_ok($$ insert into public.institutions (name, slug) values ('Gamma Institute', 'gamma') $$,
  'a super admin can create an institution');
reset role;

-- Read-only and suspended institutions -----------------------------------------
update public.institutions set status = 'read_only' where id = tests.id('inst_a');
select tests.authenticate_as(tests.id('admin_a'));
select throws_ok(
  $$ insert into public.courses (institution_id, code, name, term) values (tests.id('inst_a'), 'RO1', 'Read only', 'T1') $$,
  '42501', null, 'a read-only institution accepts no new courses');
reset role;

update public.institutions set status = 'suspended' where id = tests.id('inst_a');
select tests.authenticate_as(tests.id('admin_a'));
select is_empty($$ select tbl from tests.visible_rows(tests.id('inst_a')) where n > 0 $$,
  'admins of a suspended institution see none of its data');
reset role;
select tests.authenticate_as(tests.id('student_a'));
select is_empty($$ select tbl from tests.visible_rows(tests.id('inst_a')) where n > 0 $$,
  'students of a suspended institution see none of its data, not even their own memberships');
reset role;

select * from finish();
rollback;
