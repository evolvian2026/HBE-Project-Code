-- ============================================================================
-- A sample suite with a browser (Playwright) stage: grader/suites/sample/todo-web. Its tests
-- open the app's page and use the "New todo" form; failures come with a screenshot and a trace.
-- ============================================================================

insert into public.grader_suites (key, version, title, path, stack_profile_id, manifest) values (
  'todo-web', 1, 'Todo web app (sample browser suite)', 'suites/sample/todo-web',
  (select id from public.stack_profiles where key = 'node22-api' and version = 1 and institution_id is null),
  '{"stages": ["contract", "build", "health", "ui"], "kinds": {"ui": "browser"}, "tests": 2}'::jsonb
);
