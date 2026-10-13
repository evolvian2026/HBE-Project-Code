-- Institution limits: inviting students stops at the operator's student limit (pending
-- invitations count; people already in the institution don't). Only super admins change
-- limits and the notice shown on every page.
begin;
select plan(9);

select tests.seed_two_institutions();

-- Institution A has 1 active student and 1 pending student invitation.
update public.institutions set limits = '{"max_active_students": 3}' where id = tests.id('inst_a');

select tests.authenticate_as(tests.id('admin_a'));
select lives_ok($$ insert into public.invitations (institution_id, email, role) values (tests.id('inst_a'), 'third@test.local', 'student') $$,
  'students can be invited up to the limit');
select throws_ok($$ insert into public.invitations (institution_id, email, role) values (tests.id('inst_a'), 'fourth@test.local', 'student') $$,
  'P0001', 'This institution has reached its limit of 3 students. Ask the platform operator to raise it.',
  'not beyond it');
select lives_ok($$ insert into public.invitations (institution_id, email, role) values (tests.id('inst_a'), 'teacher2@test.local', 'teacher') $$,
  'staff don''t count');
select lives_ok($$ insert into public.invitations (institution_id, email, role, course_id, course_role)
                   values (tests.id('inst_a'), 'student.a@test.local', 'student', tests.id('course_a2'), 'student') $$,
  'inviting a student already in the institution (to another course) takes no new place');
reset role;

update public.institutions set limits = '{"max_active_students": 5}' where id = tests.id('inst_a');
select tests.authenticate_as(tests.id('admin_a'));
select throws_ok($$ insert into public.invitations (institution_id, email, role) values
                     (tests.id('inst_a'), 'five@test.local', 'student'), (tests.id('inst_a'), 'six@test.local', 'student'),
                     (tests.id('inst_a'), 'seven@test.local', 'student') $$,
  'P0001', null, 'a bulk import past the limit is refused');
select is((select count(*)::int from public.invitations where institution_id = tests.id('inst_a') and email in ('five@test.local', 'six@test.local')),
          0, 'all of it');
-- Admins can't change their own limits (only the platform operator can; via the api).
update public.institutions set limits = '{}' where id = tests.id('inst_a');
reset role;
select is((select limits ->> 'max_active_students' from public.institutions where id = tests.id('inst_a')), '5',
          'institution admins can''t lift their limits');

select tests.authenticate_as(tests.id('student_a'));
select is((select value from public.platform_settings where key = 'maintenance_banner'), '""'::jsonb,
          'everyone reads the notice');
update public.platform_settings set value = '"Hacked"' where key = 'maintenance_banner';
reset role;
select is((select value from public.platform_settings where key = 'maintenance_banner'), '""'::jsonb,
          'only super admins change it');

select * from finish();
rollback;
