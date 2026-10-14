-- Similar code reports (20261111000001) are for the assignment's course staff only: never the
-- students compared, other teachers, or anyone in another institution; and only the server
-- writes them.
begin;
select plan(8);

select tests.seed_two_institutions();

insert into tests.ids (name, id) values
  ('other_a', tests.create_user('other.a@test.local', 1003, 'other-a')),
  ('teacher2_a', tests.create_user('teacher2.a@test.local'));
insert into public.institution_memberships (institution_id, user_id, role) values
  (tests.id('inst_a'), tests.id('other_a'), 'student'),
  (tests.id('inst_a'), tests.id('teacher2_a'), 'teacher');
insert into public.assignments (institution_id, course_id, slug, title, stack_profile_id, due_at, status, published_at)
  values (tests.id('inst_a'), tests.id('course_a1'), 'shop', 'Shop',
          (select id from public.stack_profiles where key = 'mern-node20' and institution_id is null),
          now() - interval '1 day', 'published', now() - interval '7 days');
-- Joining the course makes other_a's submission (student_a has one already).
insert into public.course_memberships (institution_id, course_id, user_id, role)
  values (tests.id('inst_a'), tests.id('course_a1'), tests.id('other_a'), 'student');
select private.ensure_submissions((select id from public.assignments where slug = 'shop' and institution_id = tests.id('inst_a')));
insert into public.similarity_reports (id, institution_id, assignment_id, status, compared)
  select 'aaaaaaaa-0000-4000-8000-00000000c030', tests.id('inst_a'), id, 'completed', 2
  from public.assignments where slug = 'shop' and institution_id = tests.id('inst_a');
insert into public.similarity_pairs (institution_id, report_id, submission_a, submission_b, score, shared)
  select tests.id('inst_a'), 'aaaaaaaa-0000-4000-8000-00000000c030',
         (select id from public.submissions where user_id = tests.id('student_a') and assignment_id = a.id),
         (select id from public.submissions where user_id = tests.id('other_a') and assignment_id = a.id),
         0.9, 40
  from public.assignments a where a.slug = 'shop' and a.institution_id = tests.id('inst_a');

create function pg_temp.sees() returns text language sql as $$
  select (select count(*) from public.similarity_reports where id = 'aaaaaaaa-0000-4000-8000-00000000c030') || ' report, '
      || (select count(*) from public.similarity_pairs where report_id = 'aaaaaaaa-0000-4000-8000-00000000c030') || ' pair';
$$;

select tests.authenticate_as(tests.id('teacher_a'));
select is(pg_temp.sees(), '1 report, 1 pair', 'the course''s instructor sees the report and its pairs');
select throws_ok(
  $$update public.similarity_pairs set score = 0 where report_id = 'aaaaaaaa-0000-4000-8000-00000000c030'$$,
  '42501', null, 'but can''t change them (only the server writes)');
reset role;
select tests.authenticate_as(tests.id('admin_a'));
select is(pg_temp.sees(), '1 report, 1 pair', 'so does the institution''s admin');
reset role;
select tests.authenticate_as(tests.id('student_a'));
select is(pg_temp.sees(), '0 report, 0 pair', 'not a student in the pair');
reset role;
select tests.authenticate_as(tests.id('other_a'));
select is(pg_temp.sees(), '0 report, 0 pair', 'nor the other');
reset role;
select tests.authenticate_as(tests.id('teacher2_a'));
select is(pg_temp.sees(), '0 report, 0 pair', 'nor a teacher of another course');
reset role;
select tests.authenticate_as(tests.id('admin_b'));
select is(pg_temp.sees(), '0 report, 0 pair', 'nor another institution''s admin');
reset role;
set local role anon;
select throws_ok($$select count(*) from public.similarity_pairs$$, '42501', null, 'and nothing for anonymous visitors');
reset role;

select * from finish();
rollback;
