-- ============================================================================
-- Automated stages per assignment (FR-5.2): lint and the student's own tests (off by default,
-- each worth a share of the automated score when on), and the hidden API and browser test
-- stages (on by default). Shape: packages/core/src/stages.ts.
-- ============================================================================

alter table public.assignments
  add column stage_settings jsonb not null default '{}'::jsonb check (jsonb_typeof(stage_settings) = 'object');
grant insert (stage_settings), update (stage_settings) on public.assignments to authenticated;

-- The global profiles' lint and test stages, runnable by the harness: each runs in a fresh
-- container of `image` with a copy of the repository; `setup` installs what `run` needs
-- (stages with the same image and setup share one install). `report: junit` reads the JUnit
-- file at `junit` (relative to the repository) for the details students see.
--
-- These profiles have not been used by any published assignment yet, so their v1 definitions
-- are completed in place; once one has, a profile changes only by publishing a new version.
do $$
begin
  if exists (
    select 1 from public.assignments a join public.stack_profiles p on p.id = a.stack_profile_id
    where p.institution_id is null and p.version = 1 and p.key in ('node22-api', 'mern-node20', 'django-react')
      and a.status <> 'draft'
  ) then
    raise exception 'A published assignment uses these profiles: publish new profile versions instead';
  end if;
end;
$$;

alter table public.stack_profiles disable trigger stack_profile_immutable;

update public.stack_profiles set definition = jsonb_set(definition, '{stages}', '{
  "build": {"run": "docker compose build"},
  "lint": {"image": "node:22-bookworm-slim", "setup": "npm ci --no-audit --no-fund", "run": "npm run lint",
           "report": "text"},
  "student_tests": {"image": "node:22-bookworm-slim", "setup": "npm ci --no-audit --no-fund", "run": "npm test",
                    "report": "junit", "junit": "junit.xml"}
}'::jsonb)
where key = 'node22-api' and version = 1 and institution_id is null;

update public.stack_profiles set definition = jsonb_set(definition, '{stages}', '{
  "build": {"run": "docker compose build"},
  "lint": {"image": "node:20-bookworm-slim",
           "setup": "npm ci --prefix backend --no-audit --no-fund && npm ci --prefix frontend --no-audit --no-fund",
           "run": "npm run lint --prefix backend && npm run lint --prefix frontend", "report": "text"},
  "student_tests": {"image": "node:20-bookworm-slim",
                    "setup": "npm ci --prefix backend --no-audit --no-fund && npm ci --prefix frontend --no-audit --no-fund",
                    "run": "npm test --prefix backend", "report": "junit", "junit": "backend/junit.xml"}
}'::jsonb)
where key = 'mern-node20' and version = 1 and institution_id is null;

update public.stack_profiles set definition = jsonb_set(definition, '{stages}', '{
  "build": {"run": "docker compose build"},
  "lint": {"image": "python:3.12-slim", "setup": "pip install --quiet --disable-pip-version-check ruff==0.13.0",
           "run": "ruff check backend", "report": "text"},
  "student_tests": {"image": "python:3.12-slim",
                    "setup": "pip install --quiet --disable-pip-version-check -r backend/requirements.txt",
                    "run": "cd backend && python manage.py test", "report": "text"}
}'::jsonb)
where key = 'django-react' and version = 1 and institution_id is null;

alter table public.stack_profiles enable trigger stack_profile_immutable;
