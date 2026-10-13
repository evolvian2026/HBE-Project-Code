-- ============================================================================
-- Stack profiles and test suites, administered (docs/ARCHITECTURE.md §7): institution admins
-- add their own stack profiles (the api validates the definition the grader runs) and choose
-- which global ones teachers may pick (institutions.settings.hidden_stack_profiles); the
-- platform operator registers test suite versions. Retired ones stay for the assignments and
-- runs that used them. The api writes both; every change is audited.
-- ============================================================================

drop policy stack_profiles_insert on public.stack_profiles;
drop policy stack_profiles_update on public.stack_profiles;
revoke insert, update, delete on public.stack_profiles from authenticated;

create trigger audit after insert or update or delete on public.stack_profiles
  for each row execute function private.audit_row();
create trigger audit after insert or update or delete on public.grader_suites
  for each row execute function private.audit_row();
