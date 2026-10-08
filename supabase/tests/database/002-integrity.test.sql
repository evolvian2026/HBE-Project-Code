-- Database-enforced integrity: composite FKs, last-admin protection, identity sync, audit.
begin;
select plan(11);

select tests.seed_two_institutions();

-- Composite foreign keys make cross-tenant links impossible, even for the service role.
select throws_ok(
  $$ insert into public.course_memberships (institution_id, course_id, user_id, role)
     values (tests.id('inst_a'), tests.id('course_a1'), tests.id('student_b'), 'student') $$,
  '23503', null,
  'a course in A cannot enrol a person who is not a member of A'
);

select throws_ok(
  $$ insert into public.course_memberships (institution_id, course_id, user_id, role)
     values (tests.id('inst_b'), tests.id('course_a1'), tests.id('student_b'), 'student') $$,
  '23503', null,
  'a membership row cannot claim institution B for a course of A'
);

select throws_ok(
  $$ update public.courses set github_installation_id = tests.id('gh_b') where id = tests.id('course_a1') $$,
  '23503', null,
  'a course in A cannot use institution B''s GitHub installation'
);

-- The last active admin can't be removed or demoted.
select throws_ok(
  $$ update public.institution_memberships set role = 'teacher'
     where institution_id = tests.id('inst_a') and user_id = tests.id('admin_a') $$,
  'P0001', 'An institution must keep at least one active admin',
  'the last admin cannot be demoted'
);

select throws_ok(
  $$ delete from public.institution_memberships
     where institution_id = tests.id('inst_a') and user_id = tests.id('admin_a') $$,
  'P0001', 'An institution must keep at least one active admin',
  'the last admin cannot be removed'
);

update public.institution_memberships set role = 'admin'
  where institution_id = tests.id('inst_a') and user_id = tests.id('teacher_a');
select lives_ok(
  $$ update public.institution_memberships set role = 'teacher'
     where institution_id = tests.id('inst_a') and user_id = tests.id('admin_a') $$,
  'an admin can be demoted once another admin exists'
);

-- Deleting an institution removes its data without tripping the last-admin rule.
select lives_ok($$ delete from public.institutions where id = tests.id('inst_b') $$,
  'deleting an institution cascades cleanly');
select is((select count(*)::int from public.course_memberships where institution_id = tests.id('inst_b')), 0,
  'the deleted institution''s course memberships are gone');

-- GitHub identity linking records the immutable numeric id on the profile.
select is((select github_user_id from public.profiles where id = tests.id('student_a')), 1001::bigint,
  'profile gets the GitHub user id from the linked identity');

-- Audit log captures membership changes with the acting user.
select set_config('hbe.actor_id', tests.id('admin_a')::text, true);
insert into public.institution_memberships (institution_id, user_id, role)
  values (tests.id('inst_a'), tests.create_user('new.member@test.local'), 'student');
select is(
  (select actor_id from public.audit_logs
    where entity = 'institution_memberships' and action = 'insert'
    order by id desc limit 1),
  tests.id('admin_a'),
  'audit row records the actor set by server code'
);

-- The audit log is append-only for API users.
select tests.authenticate_as(tests.id('admin_a'));
select throws_ok($$ delete from public.audit_logs $$, '42501', null, 'audit log rows cannot be deleted by users');
reset role;

select * from finish();
rollback;
