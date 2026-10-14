-- ============================================================================
-- Optional grader stages (FR-5.2, Phase 3C): test coverage, static analysis (Semgrep) and
-- Lighthouse join lint and the student's own tests (settings in assignments.stage_settings,
-- shape in packages/core/src/stages.ts). Static analysis and Lighthouse are the harness's own;
-- coverage runs the stack profile's `coverage` command and reads its report.
-- ============================================================================

-- Lighthouse leaves its JSON report with the run.
alter table public.run_artifacts drop constraint run_artifacts_content_type_check;
alter table public.run_artifacts add constraint run_artifacts_content_type_check
  check (content_type in ('image/png', 'application/zip', 'text/plain', 'application/xml', 'application/json'));
update storage.buckets
set allowed_mime_types = array['image/png', 'application/zip', 'text/plain', 'application/xml', 'application/json']
where id = 'run-artifacts';

-- The global profiles' coverage commands. Profiles are otherwise immutable once used; adding
-- a stage is safe in place because it runs only for assignments that turn coverage on (none
-- can have yet), so no existing run or grade would have come out differently.
alter table public.stack_profiles disable trigger stack_profile_immutable;

update public.stack_profiles
set definition = jsonb_set(definition, '{stages,coverage}', '{"run": "node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=lcov.info", "image": "node:22-bookworm-slim", "setup": "npm ci --no-audit --no-fund", "format": "lcov", "file": "lcov.info", "exclude": ["test/**", "**/*.test.js", "eslint.config.js"]}'::jsonb)
where key = 'node22-api' and version = 1 and institution_id is null;

update public.stack_profiles
set definition = jsonb_set(definition, '{stages,coverage}', '{"run": "cd backend && node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=lcov.info", "image": "node:20-bookworm-slim", "setup": "npm ci --prefix backend --no-audit --no-fund && npm ci --prefix frontend --no-audit --no-fund", "format": "lcov", "file": "backend/lcov.info", "exclude": ["backend/test/**", "**/*.test.js", "**/eslint.config.js"]}'::jsonb)
where key = 'mern-node20' and version = 1 and institution_id is null;

update public.stack_profiles
set definition = jsonb_set(definition, '{stages,coverage}', '{"run": "cd backend && coverage run --source=. manage.py test; status=$?; coverage json --quiet -o coverage.json; exit $status", "image": "python:3.12-slim", "setup": "pip install --quiet --disable-pip-version-check -r backend/requirements.txt coverage==7.16.1", "format": "coverage-py", "file": "backend/coverage.json", "exclude": ["**/migrations/**", "**/tests/**", "**/tests.py", "**/test_*.py", "backend/manage.py", "backend/config/wsgi.py", "backend/config/asgi.py", "**/management/commands/wait_for_db.py"]}'::jsonb)
where key = 'django-react' and version = 1 and institution_id is null;

alter table public.stack_profiles enable trigger stack_profile_immutable;
