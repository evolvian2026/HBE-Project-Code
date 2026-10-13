-- Single sign-on: someone signed in through an institution's identity provider accepts only that
-- institution's invitations (the IdP could assert anyone's address), and joins it as a student
-- when it allows that (within its student limit). Admins see their institution's connection;
-- the api writes it.
begin;
select plan(10);

select tests.seed_two_institutions();

-- Institution A's IdP is on (the provider id stands for Supabase Auth's).
insert into tests.ids (name, id) values ('provider_a', 'aaaaaaaa-0000-4000-8000-00000000550a');
update public.sso_connections set domains = '{alpha.test}', status = 'active', supabase_provider_id = tests.id('provider_a')
  where institution_id = tests.id('inst_a');

-- Someone the IdP signed in, invited by both institutions.
insert into tests.ids (name, id) values ('sso_user', tests.create_user('grace@alpha.test'));
update auth.users set is_sso_user = true where id = tests.id('sso_user');
insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at, last_sign_in_at)
  values ('grace@alpha.test', tests.id('sso_user'), '{"email": "grace@alpha.test"}', 'sso:' || tests.id('provider_a'), now(), now(), now());
insert into public.invitations (institution_id, email, role) values
  (tests.id('inst_a'), 'grace@alpha.test', 'teacher'),
  (tests.id('inst_b'), 'grace@alpha.test', 'student');

select tests.authenticate_as(tests.id('sso_user'), 'aal1');
select is(public.accept_my_invitations(), 1, 'someone signed in through an IdP accepts its institution''s invitations');
reset role;
select is((select array_agg(institution_id) from public.institution_memberships where user_id = tests.id('sso_user')),
          array[tests.id('inst_a')], 'and no other institution''s');
select ok((select accepted_at is null from public.invitations where institution_id = tests.id('inst_b') and email = 'grace@alpha.test'),
          'the other invitation waits for a non-SSO sign-in');

-- Joining as a student without an invitation, when the institution allows it.
insert into tests.ids (name, id) values ('sso_new', tests.create_user('linus@alpha.test'));
update auth.users set is_sso_user = true where id = tests.id('sso_new');
insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at, last_sign_in_at)
  values ('linus@alpha.test', tests.id('sso_new'), '{"email": "linus@alpha.test"}', 'sso:' || tests.id('provider_a'), now(), now(), now());
select tests.authenticate_as(tests.id('sso_new'), 'aal1');
select is(public.accept_my_invitations(), 0, 'without an invitation, nobody joins by default');
reset role;
update public.sso_connections set join_as_student = true where institution_id = tests.id('inst_a');
update public.institutions set limits = '{"max_active_students": 1}' where id = tests.id('inst_a');
select tests.authenticate_as(tests.id('sso_new'), 'aal1');
select is(public.accept_my_invitations(), 0, 'nor past the student limit');
reset role;
update public.institutions set limits = '{}' where id = tests.id('inst_a');
select tests.authenticate_as(tests.id('sso_new'), 'aal1');
select is(public.accept_my_invitations(), 1, 'but they join as students when it allows that');
reset role;
select is((select role::text from public.institution_memberships where user_id = tests.id('sso_new')), 'student', 'as students');

-- Who sees the connection.
select tests.authenticate_as(tests.id('admin_a'));
select is((select count(*)::int from public.sso_connections), 1, 'the institution''s admins see its connection (only)');
select throws_ok($$ update public.sso_connections set status = 'disabled' $$, '42501', null, 'the api changes it');
reset role;
select tests.authenticate_as(tests.id('admin_b'));
select is((select count(*)::int from public.sso_connections where institution_id = tests.id('inst_a')), 0,
          'other institutions'' admins don''t');
reset role;

select * from finish();
rollback;
