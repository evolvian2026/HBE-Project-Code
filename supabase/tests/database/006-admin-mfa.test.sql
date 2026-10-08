-- Admin powers require a session that passed MFA (aal2).
begin;
select plan(9);

select tests.seed_two_institutions();

-- Institution admin with a password-only session
select tests.authenticate_as(tests.id('admin_a'), 'aal1');
select is(count(*)::int, 1, 'without MFA an admin sees only their own membership') from public.institution_memberships;
select is(count(*)::int, 0, 'without MFA an admin cannot read invitations') from public.invitations;
select throws_ok(
  $$ insert into public.invitations (institution_id, email, role) values (tests.id('inst_a'), 'x@test.local', 'student') $$,
  '42501', null, 'without MFA an admin cannot invite');
with u as (update public.institution_memberships set role = 'admin' where user_id = tests.id('student_a') returning 1)
select is(count(*)::int, 0, 'without MFA an admin cannot change roles') from u;
reset role;

select tests.authenticate_as(tests.id('admin_a'), 'aal2');
select is(count(*)::int, 3, 'with MFA the admin sees all memberships') from public.institution_memberships;
reset role;

-- Teachers and students are not affected
select tests.authenticate_as(tests.id('teacher_a'), 'aal1');
select is(count(*)::int, 2, 'a teacher does not need MFA') from public.courses;
reset role;

-- Super admin
select tests.authenticate_as(tests.id('super'), 'aal1');
select throws_ok($$ insert into public.institutions (name, slug) values ('No MFA', 'no-mfa') $$, '42501', null,
  'without MFA a super admin cannot create institutions');
reset role;

-- The setting can be relaxed (local development), by super admins only
update public.platform_settings set value = 'false' where key = 'require_admin_mfa';
select tests.authenticate_as(tests.id('admin_a'), 'aal1');
select is(count(*)::int, 3, 'with require_admin_mfa = false, aal1 admins have their powers') from public.institution_memberships;
with u as (update public.platform_settings set value = 'true' where key = 'require_admin_mfa' returning 1)
select is(count(*)::int, 0, 'only super admins can change platform settings') from u;
reset role;

select * from finish();
rollback;
