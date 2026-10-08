-- Custom Access Token Hook claims, and invitation acceptance.
begin;
select plan(14);

select tests.seed_two_institutions();

-- Access token hook -----------------------------------------------------------
select is(
  public.custom_access_token_hook(jsonb_build_object('user_id', tests.id('admin_a'), 'claims', '{"role":"authenticated"}'::jsonb))
    -> 'claims' -> 'institutions',
  jsonb_build_array(jsonb_build_object('id', tests.id('inst_a'), 'slug', 'alpha', 'role', 'admin')),
  'claims list the user''s institutions with role'
);
select is(
  public.custom_access_token_hook(jsonb_build_object('user_id', tests.id('admin_a'), 'claims', '{}'::jsonb))
    -> 'claims' -> 'platform_role',
  'null'::jsonb, 'a regular user has no platform role'
);
select is(
  public.custom_access_token_hook(jsonb_build_object('user_id', tests.id('super'), 'claims', '{}'::jsonb))
    -> 'claims' ->> 'platform_role',
  'super_admin', 'super admins get platform_role = super_admin'
);
select is(
  public.custom_access_token_hook(jsonb_build_object('user_id', tests.id('admin_a'), 'claims', '{"role":"authenticated"}'::jsonb))
    -> 'claims' ->> 'role',
  'authenticated', 'existing claims are preserved'
);

update public.institution_memberships set status = 'deactivated' where user_id = tests.id('student_a');
select is(
  jsonb_array_length(public.custom_access_token_hook(jsonb_build_object('user_id', tests.id('student_a'), 'claims', '{}'::jsonb))
    -> 'claims' -> 'institutions'),
  0, 'deactivated memberships are not in the token'
);
update public.institution_memberships set status = 'active' where user_id = tests.id('student_a');

select tests.authenticate_as(tests.id('admin_a'));
select throws_ok(
  $$ select public.custom_access_token_hook('{}'::jsonb) $$,
  '42501', null, 'users cannot call the token hook directly');
reset role;

-- Invitations -----------------------------------------------------------------
insert into tests.ids (name, id) values
  ('invitee',     tests.create_user('invitee@test.local')),
  ('unconfirmed', tests.create_user('unconfirmed@test.local', p_confirmed => false)),
  ('gh_invitee',  tests.create_user('gh.invitee@test.local', 3001, 'octo-student'));

insert into public.invitations (institution_id, email, role, course_id, course_role) values
  (tests.id('inst_a'), 'Invitee@Test.Local', 'teacher', tests.id('course_a1'), 'ta'),
  (tests.id('inst_a'), 'unconfirmed@test.local', 'student', null, null);
insert into public.invitations (institution_id, github_login, role) values
  (tests.id('inst_b'), 'Octo-Student', 'student');
insert into public.invitations (institution_id, email, role, expires_at) values
  (tests.id('inst_b'), 'invitee@test.local', 'student', now() - interval '1 day');
insert into public.invitations (institution_id, email, role) values
  (tests.id('inst_a'), 'admin.a@test.local', 'student');

select tests.authenticate_as(tests.id('invitee'));
select is(public.accept_my_invitations(), 1, 'a confirmed email accepts its invitation (case-insensitive), not the expired one');
select is((select role::text from public.institution_memberships where user_id = tests.id('invitee')), 'teacher',
  'the institution membership has the invited role');
select is((select role::text from public.course_memberships where user_id = tests.id('invitee')), 'ta',
  'the course membership has the invited course role');
select is(public.accept_my_invitations(), 0, 'accepting again is a no-op');
reset role;

select tests.authenticate_as(tests.id('unconfirmed'));
select is(public.accept_my_invitations(), 0, 'an unconfirmed email cannot accept an invitation');
reset role;

select tests.authenticate_as(tests.id('gh_invitee'));
select is(public.accept_my_invitations(), 1, 'a linked GitHub login accepts its invitation');
reset role;

select tests.authenticate_as(tests.id('admin_a'));
select is(public.accept_my_invitations(), 1, 'an existing member can accept a further invitation');
select is((select role::text from public.institution_memberships
            where user_id = tests.id('admin_a') and institution_id = tests.id('inst_a')),
  'admin', 'an invitation never downgrades an existing role');
reset role;

select * from finish();
rollback;
