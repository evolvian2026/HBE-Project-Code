-- The records lifecycle: exports are for institution admins; replication bookkeeping is for no
-- user; the purge can switch off row auditing; records notices are always emailed.
begin;
select plan(8);

select tests.seed_two_institutions();

select tests.authenticate_as(tests.id('admin_a'));
select is((select count(*)::int from public.record_exports), 1, 'admins see their institution''s exports');
select is((select count(*)::int from public.replicated_objects), 0, 'but not the replication bookkeeping');
select throws_ok(
  $$ insert into public.record_exports (institution_id) values (tests.id('inst_a')) $$,
  '42501', null, 'exports are started through the API');
reset role;

select tests.authenticate_as(tests.id('teacher_a'));
select is((select count(*)::int from public.record_exports), 0, 'teachers don''t see exports');
reset role;

-- The purge's transaction skips row auditing.
select set_config('hbe.skip_audit', 'on', true);
delete from public.feedback where institution_id = tests.id('inst_a');
select set_config('hbe.skip_audit', 'off', true);
select is((select count(*)::int from public.audit_logs
           where entity = 'feedback' and action = 'delete' and institution_id = tests.id('inst_a')), 0,
          'deletes during the purge are not audited');
delete from public.feedback where institution_id = tests.id('inst_b');
select isnt((select count(*)::int from public.audit_logs
             where entity = 'feedback' and action = 'delete' and institution_id = tests.id('inst_b')), 0,
            'other deletes are');

-- Records notices are emailed even to people who turned emails off, and after the contract ends.
update public.profiles set email_notification_types = '{}' where id = tests.id('admin_a');
update public.institutions set status = 'read_only' where id = tests.id('inst_a');
insert into public.notifications (institution_id, user_id, type, title, dedupe_key)
  values (tests.id('inst_a'), tests.id('admin_a'), 'records_notice', 'Records will be deleted in 90 days', 'n-90');
insert into public.notifications (institution_id, user_id, type, title, dedupe_key)
  values (tests.id('inst_a'), tests.id('admin_a'), 'grade_released', 'Not emailed', 'n-grade');
select is((select count(*)::int from public.email_outbox where payload->>'title' = 'Records will be deleted in 90 days'), 1,
          'records notices are always emailed');
select is((select count(*)::int from public.email_outbox where payload->>'title' = 'Not emailed'), 0,
          'other types follow the user''s choice');

select * from finish();
rollback;
