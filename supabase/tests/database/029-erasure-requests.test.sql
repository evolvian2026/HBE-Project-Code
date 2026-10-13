-- Erasure requests: the institution's admins see them, the person sees their own; everything
-- else (asking, deciding, carrying out) goes through the api. The helpers that carry it out
-- can't be called by users.
begin;
select plan(7);

select tests.seed_two_institutions();

select tests.authenticate_as(tests.id('admin_a'));
select is((select count(*)::int from public.erasure_requests), 1, 'admins see their institution''s requests');
reset role;
select tests.authenticate_as(tests.id('admin_a'), 'aal1');
select is((select count(*)::int from public.erasure_requests), 0, 'but not without two-factor authentication');
reset role;
select tests.authenticate_as(tests.id('student_a'));
select is((select count(*)::int from public.erasure_requests where subject_id = tests.id('student_a')), 1,
          'the person sees their own');
select throws_ok($$ update public.erasure_requests set status = 'approved', mode = 'delete' $$,
  '42501', null, 'and can''t approve it');
select throws_ok($$ select private.rekey_person(tests.id('inst_a'), tests.id('student_a'), tests.id('admin_a')) $$,
  '42501', null, 'nor call the erasure helpers');
reset role;
select tests.authenticate_as(tests.id('teacher_a'));
select is((select count(*)::int from public.erasure_requests), 0, 'teachers don''t see them');
select throws_ok($$ insert into public.erasure_requests (institution_id, subject_id, subject_role, requested_via)
                   values (tests.id('inst_a'), tests.id('student_a'), 'student', 'admin') $$,
  '42501', null, 'requests are made through the api');
reset role;

select * from finish();
rollback;
