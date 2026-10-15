-- Institution domains (20261113000001): the institution's admins (with two-factor
-- authentication) and the platform operator see them; teachers and students don't; only the
-- server writes them. Sign-in handoff codes are the server's alone.
begin;
select plan(7);

select tests.seed_two_institutions();

create function pg_temp.sees() returns int language sql as $$
  select count(*)::int from public.institution_domains where institution_id = tests.id('inst_a');
$$;

select tests.authenticate_as(tests.id('admin_a'));
select is(pg_temp.sees(), 1, 'the institution''s admin sees its domain');
select throws_ok(
  $$update public.institution_domains set status = 'active' where institution_id = tests.id('inst_a')$$,
  '42501', null, 'but can''t change it (only the server writes)');
reset role;
select tests.authenticate_as(tests.id('admin_a'), 'aal1');
select is(pg_temp.sees(), 0, 'not without two-factor authentication');
reset role;
select tests.authenticate_as(tests.id('teacher_a'));
select is(pg_temp.sees(), 0, 'teachers don''t');
reset role;
select tests.authenticate_as(tests.id('student_a'));
select is(pg_temp.sees(), 0, 'nor students');
reset role;

insert into public.session_handoffs (code_hash, user_id, host, expires_at)
  values (repeat('a', 64), tests.id('student_a'), 'acme.example.test', now() + interval '1 minute');
select tests.authenticate_as(tests.id('student_a'));
select throws_ok($$select count(*) from public.session_handoffs$$, '42501', null,
  'sign-in handoff codes are hidden, even from their owner');
reset role;
set local role anon;
select throws_ok($$select count(*) from public.institution_domains$$, '42501', null, 'and nothing for anonymous visitors');
reset role;

select * from finish();
rollback;
