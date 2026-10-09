# HBE Project Platform

An automated full-stack project evaluation and management platform for students and educators,
serving **multiple institutions** from one deployment.

- **Students** work in GitHub repositories provisioned per assignment, in the tech stack the
  teacher chose for that project. Every push or pull request can trigger an automated build and
  test pipeline, with detailed, actionable failure feedback.
- **Educators** track commit, PR and issue activity (which counts toward the grade as a
  process score), review code, score rubrics, and release targeted feedback and grades.
  Grades are pushed to **Canvas, Moodle or Google Classroom**.
- **Every submission and grade report is archived** (for the contract plus 2 years), so a
  student's performance history can be reviewed at any time.
- **Institution admins** manage users (students, teachers, admins), courses, stack profiles,
  GitHub and LMS connections, and settings. A **super admin** manages institutions.

**Stack:** Next.js · Fastify · pg-boss · Supabase (Postgres, Auth, Storage, Realtime) · GitHub App +
GitHub Actions (isolated grading) · LTI 1.3 / Google Classroom API.

**Hosting (Singapore):** free tiers for the demo (Render + Supabase), then AWS EC2 ap-southeast-1
with Supabase Pro. The same Docker image and hostnames are used in both.

## Status

**Phases 0 and 1 (foundations and the MVP vertical slice) are built, and Phase 2 (LMS) is under
way**; deploying the demo environment and a pilot course follow the runbook in
[docs/DEPLOYMENT.md §1.3](docs/DEPLOYMENT.md#13-demo-runbook).
Working today:

- Multi-institution database with row-level security on every table, composite foreign keys that
  block cross-institution links, an audit log, and about 200 database tests proving the isolation.
- Sign-in with GitHub or an emailed magic link; invitations accepted automatically on first sign-in.
- Super admin console; institution admins manage members (single or CSV invitations), courses,
  staff and their GitHub organisation. Admin powers require two-factor authentication.
- Teachers create assignments locked to a stack profile, with grade weights, late policy, rubric
  and a hidden test suite. Publishing creates each student's private repository from a template.
- Commits, pull requests, reviews and issues are tracked from webhooks into a **process score**
  that explains every point lost.
- **Automated grading**: tests run on push, on pull requests or on request (with a daily quota) in
  a private grader repository on GitHub Actions. The student's app runs with Docker Compose on an
  offline network and is tested by black-box hidden API and Playwright browser tests with random
  data; assignments can add the stack's linter and the student's own tests, each worth a share of
  the score. Students see each failure with what was expected, a hint, the request and response
  (or the failing step, a screenshot and a trace) and their app's logs, also as a check on their
  commit. Logs, reports, screenshots and traces are kept with the run.
- **Starter templates** for the three stack profiles (`templates/`), graded in CI by the real
  harness, so a student's first push builds, starts and passes.
- **Deadlines and grades**: the graded commit is fixed at the cutoff by GitHub's push time (late
  windows and extensions included) and graded by a deadline run. Staff score the rubric, write
  feedback, override with a reason and release; every change is a new grade version. Staff review
  the code in the platform (file tree, file view, changes since the template) and comment on
  lines; students can ask for a regrade within a set window.
- **Records**: every released grade version gets a report (JSON with its SHA-256, and a PDF), and
  the graded commit's source is archived (git bundle and tarball), all in private Storage.
  Students have "My grades"; staff have student profiles, a course progress matrix with at-risk
  signals, and a CSV grade export. Notifications (in the app, and by email as each person chooses)
  cover test results, grades, extensions, deadlines and regrades.
- **Records lifecycle**: record files are copied nightly to an external archive bucket; admins can
  export everything as one ZIP; ending a contract makes the institution read-only, warns admins 90
  and 30 days before the purge two years later, and the purge leaves only a certificate.
- One Docker image running the web, api and worker roles, validated by end-to-end browser tests.

- **LMS integration (LTI 1.3)**: admins connect Canvas, Moodle or another LTI 1.3 platform
  (one-time Dynamic Registration URL, or by hand); opening the platform from the LMS signs people
  in and takes them to their course or assignment, and people the platform can't match by email
  wait for an admin. Instructors add assignments in the LMS (Deep Linking); released grades go to
  the LMS gradebook, with a sync panel per assignment and a nightly check for grades changed in
  the LMS; rosters are read from the LMS.

Phase 2 (LMS integration and v1 hardening) is under way; Google Classroom is next. The demo
deployment and pilot wait for the project's accounts. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Repository layout

```
apps/web          Next.js app (student / teacher / admin / platform UI)
apps/server       One entry point for every role: Fastify api, pg-boss worker, and the web app
packages/settings Typed config loader: plan profile + environment (docs/CONFIGURATION.md)
packages/db       Kysely database access and table types
packages/queue    Typed job queue and schedules on pg-boss
packages/github   GitHub App client, webhook verification and payload parsing, in-memory fake
packages/core     Permission rules and shared domain helpers
packages/lms      LTI 1.3: launch verification, tool keys, Dynamic Registration, a test platform
grader/           Grader harness, hidden test suites and the evaluate workflow (its own repo when deployed)
templates/        Starter repositories for the stack profiles (published as GitHub template repositories)
scripts/          Local env setup; publishing the grader and the templates to GitHub
supabase/         Config, SQL migrations and pgTAP database tests
e2e/              Playwright end-to-end tests
config/           Plan profiles (free/paid) and env templates per environment
docs/             Architecture, requirements, data model, deployment, configuration, ADRs
```

## Local development

Prerequisites: Node 22 (`.nvmrc`), Docker, and pnpm (`corepack enable`).

```bash
pnpm install
pnpm db:start                                  # local Supabase: Postgres, Auth, REST, Storage, Mailpit
pnpm env:local                                 # writes .env.local with the local stack's keys
pnpm dev                                       # web on :3000, api + worker on :4000
```

Open http://localhost:3000 and sign in with any email. The sign-in email arrives in Mailpit at
http://localhost:54324. A new account has no institutions; to make yourself the super admin:

```bash
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c \
  "insert into public.user_roles (user_id, role) select id, 'super_admin' from auth.users where email = 'you@example.com'"
```

Then open **Platform** to create an institution and invite its admin.

Admins (super admins and institution admins) must set up two-factor authentication with an
authenticator app; the database withholds admin powers until they do. For local experiments
only, you can relax this:

```bash
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c \
  "update public.platform_settings set value = 'false' where key = 'require_admin_mfa'"
```

GitHub sign-in and webhooks need a development GitHub App. The exact settings, where each
credential goes, and how to forward webhooks are in [docs/GITHUB_APP_SETUP.md](docs/GITHUB_APP_SETUP.md).

> If Docker Hub is reachable but AWS ECR is not, start Supabase with
> `SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io pnpm db:start`.

## Tests

| Command | What it runs | Needs |
|---------|--------------|-------|
| `pnpm lint` · `pnpm format:check` · `pnpm typecheck` | ESLint, Prettier, TypeScript | — |
| `pnpm test` | Unit tests (settings, github, core, lms, grader) | — |
| `pnpm db:test` | pgTAP: tenant isolation, permissions, integrity, auth hook, invitations | `pnpm db:start` |
| `pnpm test:integration` | db schema, queue, and the server against the real database | `pnpm db:start` |
| `pnpm --filter @hbe/grader test:docker` | The grader harness grading fixture apps | Docker |
| `pnpm test:e2e` | Playwright: real sign-in emails, onboarding, access control, grading, LMS launches | `pnpm db:start`, the app running on :3000, and Docker |

For the end-to-end tests, run the app the way the demo runs it (one process, all roles). Make a
copy of `.env.local` with `ROLES=web,api,worker`, `PORT=3000` and `API_URL=http://localhost:3000`, then:

```bash
pnpm build
cd apps/server && node --env-file=<that env file> dist/main.js
```

CI (`.github/workflows/ci.yml`) runs all of the above plus a Docker image build on every pull request.

## Design documents

| Doc | Contents |
|-----|----------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, components, GitHub integration, evaluation pipeline, security, deployment, custom domain |
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | Functional and non-functional requirements, tech stack, setup checklist, decisions log |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Database schema, RLS patterns, indexes |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Config layering, files, and exact changes for each migration (Supabase Pro, AWS EC2, runners) |
| [docs/GITHUB_APP_SETUP.md](docs/GITHUB_APP_SETUP.md) | Exact GitHub App settings (dev, demo, production) and how to test them |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Free-tier demo setup, AWS EC2 production design, runners, migration runbook |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phased delivery plan and key risks |
| [docs/adr/](docs/adr/README.md) | Architecture decision records |
