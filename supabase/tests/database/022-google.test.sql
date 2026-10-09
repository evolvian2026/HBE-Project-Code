-- Google Classroom: teachers see their own Google connection and admins their institution's,
-- but nobody reads a stored refresh token (encrypted or not) and only the api writes.
begin;
select plan(8);

select tests.seed_two_institutions();

select tests.authenticate_as(tests.id('teacher_a'));
select results_eq($$ select email from public.google_accounts $$, $$ values ('teacher.a@test.local') $$,
  'teachers see their own Google connection');
select throws_ok($$ select refresh_token_encrypted from public.google_accounts $$, '42501', null,
  'but not its token');
select throws_ok($$ update public.google_accounts set revoked_at = now() $$, '42501', null,
  'and can''t change it');
select is((select count(*)::int from public.google_oauth_states), 0, 'OAuth states are for nobody');
reset role;

select tests.authenticate_as(tests.id('student_a'));
select is((select count(*)::int from public.google_accounts), 0, 'students see no Google connections');
reset role;

select tests.authenticate_as(tests.id('admin_a'));
select is((select count(*)::int from public.google_accounts), 1, 'admins see their institution''s connections');
reset role;

-- One Google Classroom connection per institution.
select throws_ok(
  $$ insert into public.lms_connections (institution_id, type, name)
     values (tests.id('inst_a'), 'google_classroom', 'Again') $$,
  '23505', null, 'an institution has one Google Classroom connection');

-- A Google connection belongs to a member of the institution.
select throws_ok(
  $$ insert into public.google_accounts (institution_id, profile_id, google_user_id, refresh_token_encrypted)
     values (tests.id('inst_a'), tests.id('student_b'), 'g-x', 'v1:x') $$,
  '23503', null, 'only members connect Google in an institution');

select * from finish();
rollback;
