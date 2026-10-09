-- ============================================================================
-- A sample suite for the starter templates' example notes app (templates/mern-node20 and
-- templates/django-react): grader/suites/sample/starter-notes, with API and browser stages.
-- It isn't tied to one stack profile: both templates expose the same API and page.
-- ============================================================================

insert into public.grader_suites (key, version, title, path, stack_profile_id, manifest) values (
  'starter-notes', 1, 'Starter notes app (sample suite for the MERN and Django + React templates)',
  'suites/sample/starter-notes', null,
  '{"stages": ["contract", "build", "health", "api", "ui"], "kinds": {"api": "api", "ui": "browser"}, "tests": 5}'::jsonb
);
