-- Tenant isolation: no user can read another institution's rows, in any table.
begin;
select plan(24);

select tests.seed_two_institutions();

-- ---------------------------------------------------------------------------
-- Guard rails on the schema itself
-- ---------------------------------------------------------------------------
select is_empty(
  $$ select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity $$,
  'every table in public has RLS enabled'
);

select is_empty(
  $$ select table_name from information_schema.role_table_grants
     where table_schema = 'public' and grantee = 'anon' $$,
  'anon has no privileges on any public table'
);

select is_empty(
  $$ select table_name::text from information_schema.columns
     where table_schema = 'public' and column_name = 'institution_id'
     except
     select tbl from tests.visible_rows(null) $$,
  'every tenant-owned table is covered by tests.visible_rows (add new tables there)'
);

-- ---------------------------------------------------------------------------
-- Users of institution A see nothing of institution B
-- ---------------------------------------------------------------------------
select tests.authenticate_as(tests.id('admin_a'));
select is_empty($$ select tbl from tests.visible_rows(tests.id('inst_b')) where n > 0 $$,
  'admin of A sees no rows of B');
reset role;

select tests.authenticate_as(tests.id('teacher_a'));
select is_empty($$ select tbl from tests.visible_rows(tests.id('inst_b')) where n > 0 $$,
  'teacher of A sees no rows of B');
reset role;

select tests.authenticate_as(tests.id('student_a'));
select is_empty($$ select tbl from tests.visible_rows(tests.id('inst_b')) where n > 0 $$,
  'student of A sees no rows of B');
reset role;

select tests.authenticate_as(tests.id('admin_b'));
select is_empty($$ select tbl from tests.visible_rows(tests.id('inst_a')) where n > 0 $$,
  'admin of B sees no rows of A');
reset role;

-- A user with no membership sees nothing anywhere
select tests.authenticate_as(tests.create_user('outsider@test.local'));
select is_empty($$ select tbl from tests.visible_rows(tests.id('inst_a')) where n > 0
                   union all select tbl from tests.visible_rows(tests.id('inst_b')) where n > 0 $$,
  'a user without memberships sees no tenant rows');
select is(count(*)::int, 1, 'outsider sees only their own profile') from public.profiles;
reset role;

-- ---------------------------------------------------------------------------
-- Within an institution, visibility follows role
-- ---------------------------------------------------------------------------
select tests.authenticate_as(tests.id('admin_a'));
select is(count(*)::int, 3, 'admin sees all memberships of their institution') from public.institution_memberships;
select is(count(*)::int, 2, 'admin sees all courses of their institution') from public.courses;
select is(count(*)::int, 1, 'admin sees their institution''s GitHub installation only') from public.github_installations;
reset role;

select tests.authenticate_as(tests.id('teacher_a'));
select is(count(*)::int, 3, 'teacher sees the profiles of their institution') from public.profiles;
select is(count(*)::int, 0, 'teacher cannot read invitations') from public.invitations;
select is(count(*)::int, 0, 'teacher cannot read the audit log') from public.audit_logs;
reset role;

select tests.authenticate_as(tests.id('student_a'));
select is(count(*)::int, 1, 'student sees only their own membership') from public.institution_memberships;
select results_eq($$ select id from public.courses $$, $$ values (tests.id('course_a1')) $$,
  'student sees only the courses they are enrolled in');
select is(count(*)::int, 1, 'student sees only their own profile') from public.profiles;
select is(count(*)::int, 0, 'student sees no GitHub installations') from public.github_installations;
reset role;

-- ---------------------------------------------------------------------------
-- Super admin: platform data yes, tenant data no (needs a support-access grant)
-- ---------------------------------------------------------------------------
select tests.authenticate_as(tests.id('super'));
select is(count(*)::int, 2, 'super admin sees all institutions') from public.institutions;
select is(count(*)::int, 0, 'super admin cannot read tenant memberships') from public.institution_memberships;
select is(count(*)::int, 0, 'super admin cannot read tenant courses') from public.courses;
select is(count(*)::int, 3, 'super admin sees every GitHub installation, linked or not') from public.github_installations;
reset role;

-- ---------------------------------------------------------------------------
-- Anonymous callers
-- ---------------------------------------------------------------------------
set local role anon;
select throws_ok($$ select count(*) from public.institutions $$, '42501', null,
  'anon is denied outright');
reset role;

select * from finish();
rollback;
