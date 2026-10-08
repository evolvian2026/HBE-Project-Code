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

**Phase 0 (foundations) is built.** Working today:

- Multi-institution database with row-level security on every table, composite foreign keys that
  block cross-institution links, an audit log, and 66 database tests proving the isolation.
- Sign-in with GitHub or an emailed magic link; invitations accepted automatically on first sign-in.
- Super admin console: create institutions and invite their first admin.
- Institution pages per role, with an institution switcher.
- GitHub webhooks: verified, stored, queued and processed; GitHub organisations linked to an
  institution securely (see [ADR 0013](docs/adr/0013-installation-linking-by-webhook.md)).
- One Docker image running the web, api and worker roles, validated by end-to-end browser tests.

Next is Phase 1 (assignments, repository provisioning, grading). See [docs/ROADMAP.md](docs/ROADMAP.md).

## Repository layout

```
apps/web          Next.js app (student / teacher / admin / platform UI)
apps/server       One entry point for every role: Fastify api, pg-boss worker, and the web app
packages/settings Typed config loader: plan profile + environment (docs/CONFIGURATION.md)
packages/db       Kysely database access and table types
packages/queue    Typed job queue and schedules on pg-boss
packages/github   Webhook signature verification and payload parsing
packages/core     Permission rules and shared domain helpers
supabase/         Config, SQL migrations and pgTAP database tests
e2e/              Playwright end-to-end tests
config/           Plan profiles (free/paid) and env templates per environment
docs/             Architecture, requirements, data model, deployment, configuration, ADRs
```

## Local development

Prerequisites: Node 22 (`.nvmrc`), Docker, and pnpm (`corepack enable`).

```bash
pnpm install
pnpm db:start                                  # local Supabase: Postgres, Auth, REST, Mailpit
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

GitHub sign-in and webhooks need a development GitHub App: put its credentials in `.env.local`,
enable `[auth.external.github]` in `supabase/config.toml`, and forward webhooks to
`http://localhost:4000/webhooks/github` (for example with smee.io).

> If Docker Hub is reachable but AWS ECR is not, start Supabase with
> `SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io pnpm db:start`.

## Tests

| Command | What it runs | Needs |
|---------|--------------|-------|
| `pnpm lint` · `pnpm format:check` · `pnpm typecheck` | ESLint, Prettier, TypeScript | — |
| `pnpm test` | Unit tests (settings, github, core) | — |
| `pnpm db:test` | pgTAP: tenant isolation, permissions, integrity, auth hook, invitations | `pnpm db:start` |
| `pnpm test:integration` | db schema, queue, and the server against the real database | `pnpm db:start` |
| `pnpm test:e2e` | Playwright: real sign-in emails, onboarding, access control | `pnpm db:start` and the app running on :3000 |

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
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Free-tier demo setup, AWS EC2 production design, runners, migration runbook |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phased delivery plan and key risks |
| [docs/adr/](docs/adr/README.md) | Architecture decision records |
