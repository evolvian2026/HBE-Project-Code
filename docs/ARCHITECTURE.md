# Architecture

This document describes the target architecture for the Full-Stack Project Evaluation &
Management Platform. Read it with [REQUIREMENTS.md](./REQUIREMENTS.md) (what it must do),
[DATA_MODEL.md](./DATA_MODEL.md) (the schema) and [ROADMAP.md](./ROADMAP.md) (build order).

---

## 1. Guiding decisions

| # | Decision | Why |
|---|----------|-----|
| D1 | **TypeScript end to end, in a pnpm + Turborepo monorepo** | One language for UI, API, worker and test harness; shared types and Zod schemas. |
| D2 | **Supabase is the system of record**: Postgres, Auth, Storage, Realtime | Requested; Row Level Security (RLS) gives defence in depth for multi-role access. |
| D3 | **The app host runs our code only.** That's Render's free tier for the demo, then AWS EC2 (Singapore) in production, with one Docker image for both | Student code is never run on the app host. Using the same container image keeps the move to EC2 to a configuration change. |
| D4 | **Student code runs on GitHub Actions runners, never on our servers** | Untrusted code needs throwaway isolated machines. Hosted runners give that at no ops cost; self-hosted ephemeral runners are the scale-up path. |
| D5 | **Integrate through a GitHub App, not an OAuth App or PATs** | Fine-grained per-repo permissions, installation tokens that expire, webhooks, Check Runs, higher rate limits. |
| D6 | **Webhook-first, async-by-default** | Webhooks are acknowledged in under a second and queued; all heavy work happens in the worker. Polling is only for reconciliation. |
| D7 | **SQL migrations (Supabase CLI) are the schema source of truth** | Reviewed, versioned, applied by CI; TS types are generated from the database. |
| D8 | **Multi-tenant, shared schema**: every tenant-owned row carries `institution_id`, and RLS isolates institutions | Several institutions on one deployment. One schema keeps operations simple, and RLS plus composite foreign keys prevent cross-tenant access (§4). |
| D9 | **The platform is the system of record** for submissions, runs, grades and reports. LMSs receive a copy. | Every submission and grade report must be viewable at any time, even if a GitHub repo or LMS course is later deleted (§12, §13). |
| D10 | **Stack profiles**: an admin-curated catalogue of tech stacks; each project is locked to one | Any stack is allowed, but each project's stack is fixed, so the grader always knows how to build, lint and test it (§6.1). |
| D11 | **Process (activity) is a standard grade component**, computed from capped, gaming-resistant metrics | Activity counts toward grades, so it has to be fair, transparent and explainable (§5.4). |

---

## 2. System context

```mermaid
flowchart LR
  subgraph Users
    S[Student]
    T[Teacher / TA]
    A[Admin]
  end

  subgraph Host["App host: Render free (demo) → AWS EC2 ap-southeast-1 (production)"]
    WEB["web role<br/>Next.js<br/>app.example.com"]
    API["api role<br/>Fastify<br/>api.example.com"]
    WRK["worker role<br/>pg-boss jobs + schedules"]
  end

  subgraph Supabase["Supabase (Singapore)"]
    AUTH[Auth]
    DB[("Postgres + RLS<br/>+ pg-boss queue")]
    STO[(Storage)]
    RT[Realtime]
  end

  subgraph GitHub
    APP[GitHub App]
    REPOS["Student repos<br/>(classroom org)"]
    GRADER["Private grader repo<br/>+ runners (hosted → EC2 ephemeral)"]
  end

  S & T & A --> WEB
  WEB -- supabase-js (user JWT, RLS) --> DB
  WEB -- REST (user JWT) --> API
  WEB <-- live updates --> RT
  WEB --> AUTH
  REPOS -- webhooks --> API
  API -- enqueue --> DB
  DB -- jobs --> WRK
  WRK -- installation tokens --> APP
  WRK -- create repos, Check Runs, PR comments --> REPOS
  WRK -- workflow_dispatch --> GRADER
  GRADER -- checkout @ SHA --> REPOS
  GRADER -- results (OIDC-authenticated) --> API
  GRADER -- artifacts + source snapshot (signed URL) --> STO
  WRK -- PDF reports --> STO

  subgraph LMSs["Institution LMSs"]
    LMS["Canvas / Moodle<br/>(LTI 1.3)"]
    GC["Google Classroom<br/>(Classroom API)"]
  end
  LMS -- LTI launch / deep link --> API
  WRK -- grade passback, roster sync --> LMS
  WRK -- grade passback, roster sync --> GC
```

### Components

The platform's own code ships as **one Docker image** with three **roles**, selected by the
`ROLES` environment variable. On the free tier, all three roles run in one process. On EC2
they run as separate containers that can be scaled independently. The code is identical in
both cases; see [DEPLOYMENT.md](./DEPLOYMENT.md).

| Role / component | Tech | Responsibility |
|------------------|------|----------------|
| **web** | Next.js (App Router), React, Tailwind, shadcn/ui, TanStack Query, `@supabase/ssr` | All UIs (student, teacher, admins); simple RLS-protected reads straight from Supabase; calls the `api` role for privileged operations. |
| **api** | Fastify, Zod, `@octokit/app`, `jose` | GitHub webhook receiver, privileged REST API, grader results callback, LTI endpoints, signed upload URLs. Stateless. |
| **worker** | Node + **pg-boss** | Webhook processing, repo provisioning, evaluation orchestration, scoring, Check Runs / PR comments, grade reports, LMS sync, notifications, email; also runs the **scheduled jobs** (pg-boss cron), so no separate cron service is needed. |
| **Supabase** | Postgres 15+, Auth, Storage, Realtime | Data, identity, job queue (pg-boss schema), artifacts, snapshots, reports, live dashboard updates. |
| **grader** | Private GitHub repo with reusable workflows, hidden tests, Docker Compose harness, Playwright | Builds and runs each submission in isolation, snapshots the graded source, and reports structured results. |

> **Why pg-boss instead of Redis/BullMQ?** At about 100 concurrent students the job volume is
> small. A Postgres-backed queue gives durable, transactional jobs (enqueue in the same
> transaction as the data change) plus cron-style schedules. It needs no Redis, which the free
> tier lacks and which would otherwise be one more thing to run on EC2. The queue sits behind a
> `packages/queue` interface, so switching to BullMQ/SQS later only touches one package.

---

## 3. Monorepo layout

```
hbe-project-code/
├── apps/
│   ├── web/                 # Next.js app (student / teacher / admin portals)
│   └── server/              # Single entry point: Fastify api + pg-boss worker/schedules,
│                            #   and (when ROLES includes web) serves the Next.js handler
├── packages/
│   ├── core/                # Domain logic: scoring, policies, permissions (pure TS, unit-tested)
│   ├── db/                  # Generated Supabase types, query helpers (Kysely), repositories
│   ├── github/              # GitHub App client, webhook schemas, token cache, rate-limit handling
│   ├── queue/               # Queue + schedule interface (pg-boss implementation)
│   ├── settings/            # Typed config loader: plan profile + env, validated at startup
│   ├── contracts/           # Zod schemas shared by api/web/worker/grader (API DTOs, result payloads)
│   ├── lms/                 # LMS adapters: LTI 1.3 (Canvas, Moodle), Google Classroom API
│   ├── reports/             # Grade report rendering (HTML → PDF)
│   ├── ui/                  # Shared React components
│   └── config/              # eslint, tsconfig, tailwind presets
├── config/
│   ├── profiles/            # free.yaml / paid.yaml plan profiles (limits, behaviour)
│   └── env/                 # *.env.example per environment (local, demo, production)
├── supabase/
│   ├── migrations/          # SQL migrations (source of truth)
│   ├── seed.sql             # Local/dev seed data
│   └── config.toml          # Local Supabase stack config
├── grader/                  # Mirrored/published to the private grader repo
│   ├── .github/workflows/evaluate.yml
│   ├── harness/             # compose overrides, wait-for-health, result collector
│   ├── stacks/<profile>/    # Stack adapters: build/lint/unit-test commands → JUnit (§6.1)
│   └── suites/<institution>/<assignment>/ # Hidden API + E2E tests, versioned
├── templates/               # Starter repos per assignment (runtime contract baked in)
├── docs/
├── Dockerfile               # One image for all roles (Render and EC2)
├── render.yaml              # Render Blueprint for the free-tier demo
├── deploy/aws/              # Terraform + docker-compose.prod.yml + Caddyfile for EC2
├── deploy/runners/          # Ephemeral self-hosted GitHub runner setup (EC2)
└── turbo.json / pnpm-workspace.yaml
```

---

## 4. Tenancy, identity, roles and authorisation

### 4.1 Multi-institution tenancy

Each **institution** (university, college, bootcamp) is a tenant with its own:

- institution admins, teachers and students (one person can belong to several institutions)
- GitHub organisation(s), each with its own installation of the single platform GitHub App
- stack profile catalogue (global profiles plus the institution's own), grader suites, quotas
  and concurrency caps
- LMS connections (§13), SSO configuration, branding, email sender name, retention policy and
  data region label

**Isolation model** (shared database, shared schema):

| Layer | Mechanism |
|-------|-----------|
| Data | `institution_id NOT NULL` on every tenant-owned table, including child tables (denormalised on purpose so RLS stays cheap). **Composite foreign keys** `(institution_id, parent_id)` make it impossible for a row to point at another tenant's parent. |
| Database | RLS policies always start with `institution_id = any(current_institution_ids())` and then apply course-level checks. pgTAP tests check that a user in tenant A sees zero rows from tenant B on every table. |
| API / worker | Every request resolves an **active institution** (from the URL or the institution switcher). Every job payload carries `institution_id`, and repository functions require it as a parameter. |
| Storage | Paths start with `inst/{institution_id}/…`, and Storage RLS checks that prefix. |
| GitHub | The webhook `installation.id` maps to exactly one institution. Events from unknown installations are stored but not processed. |
| Grader | Suites are namespaced by institution. Results callbacks are matched to the run's institution. Runners are platform-owned and shared, and every run is a fresh, throwaway machine, so nothing carries over between tenants. |
| Rate limits / quotas | Run quotas, concurrency caps and Actions-minute budgets are tracked per institution, so one tenant's deadline rush can't starve another. |

**URLs**: start with a single `app.example.com` and an institution switcher
(`/i/{slug}/…`). Per-institution subdomains (`{slug}.example.com`, served by a wildcard custom
domain on Render) or vanity domains can be added later without changing the data model.

### 4.2 Authentication (Supabase Auth)

| User type | Sign-in methods | Notes |
|-----------|-----------------|-------|
| Student | **GitHub OAuth** (required to link GitHub), plus the institution's SSO or an LTI launch from the LMS | The GitHub link is how commits and PRs are attributed. LMS-launched students are asked to link GitHub on first launch. |
| Teacher / TA | Institution SSO (SAML 2.0 through Supabase SSO, or Google/Microsoft OAuth), email + password, or LTI launch | |
| Institution admin / super admin | Same as teacher, **MFA (TOTP) required** | Enforced via an `aal2` check in RLS and the API. |

- Use the **GitHub App's own client ID/secret** as Supabase's GitHub provider, so one app
  handles both login and repository access.
- Store `github_user_id` (numeric, immutable) as the identity key, never the username (users
  can rename themselves).
- **LTI launch to platform session**: the API validates the LTI 1.3 `id_token`, maps
  `(issuer, deployment, sub)` to a profile through `lms_user_links` (matching on email for a
  first launch), then creates a Supabase session server-side (admin `generateLink`, then
  `verifyOtp` with the token hash) and redirects into the app.
- Configure custom SMTP (e.g. Resend, Postmark, SES). The built-in Supabase mailer is
  rate-limited and not meant for production.

### 4.3 Role model

Three layers:

1. **Platform role**: `super_admin` (the platform operator: creates institutions, manages
   global stack profiles, sees cross-tenant health). Stored in `user_roles`. Very few users.
2. **Institution role**: `admin | teacher | student`, in `institution_memberships`. Institution
   admins manage users, courses, stack profiles, GitHub orgs, LMS connections and settings
   **for their institution only**.
3. **Course role**: `instructor | ta | student`, in `course_memberships`. Controls what a user
   can see and do *within a course*. A teacher is only an instructor in the courses they're
   assigned to.

A **Custom Access Token Hook** (Postgres function) puts `platform_role` and the list of
`{institution_id, slug, role}` entries into the JWT, for UI routing only. Every authorisation
decision (RLS helpers and the API's permission checks) reads current memberships from the
database, so removing or demoting someone takes effect immediately
([ADR 0012](adr/0012-authorisation-reads-database.md)).

### 4.4 Enforcement layers

1. **UI**: hides what the user can't do (convenience only).
2. **API**: verifies the Supabase JWT (JWKS / asymmetric signing keys), resolves the active
   institution, then runs `packages/core/permissions` checks (`can(user, 'grade', submission)`).
3. **Database RLS**: every table that holds user data has RLS enabled. Helper functions such as
   `current_institution_ids()`, `is_institution_admin(iid)`, `is_course_staff(course_id)` and
   `is_course_member(course_id)` are `SECURITY DEFINER` and `STABLE`.
4. **Service role key**: used only by `api`/`worker`/`cron`, never shipped to the browser.
   These services must call the permission layer explicitly and always filter by
   `institution_id`, because the service role bypasses RLS.

---

## 5. GitHub integration

### 5.1 GitHub App configuration

| Setting | Value |
|---------|-------|
| Installed on | Each institution's classroom GitHub organisation(s), e.g. `acme-uni-cs-2026`. One App, many installations, each mapped to one institution in `github_installations`. |
| Repository permissions | Contents: **read**; Metadata: read; Pull requests: **read & write** (review comments); Issues: **read & write**; Checks: **read & write**; Actions: **read & write** (only needed on the grader repo); Administration: **write** (create repos from templates, add collaborators); Commit statuses: read |
| Organisation permissions | Members: read |
| Webhook events | `push`, `pull_request`, `pull_request_review`, `pull_request_review_comment`, `issues`, `issue_comment`, `create`, `delete`, `repository`, `installation`, `installation_repositories`, `workflow_run`, `check_suite` |
| Webhook URL | `https://api.example.com/webhooks/github` |
| Callback URL | Supabase Auth callback (`https://<project>.supabase.co/auth/v1/callback` or the custom auth domain) |

### 5.2 Repository provisioning (recommended mode)

When a teacher **publishes** an assignment:

1. The worker creates one repo per student (or per team) from the assignment's **template repo**
   (`POST /repos/{template_owner}/{template_repo}/generate`), named
   `{assignment-slug}-{github-login}`, and makes it private.
2. It adds the student(s) as collaborators with `push` access and the course staff team with
   `maintain` access.
3. It applies a **branch ruleset** on `main` (require PR, block force-push) if the assignment
   grades PR workflow.
4. It records the repo in `repositories` and links it to the `submission`.

**Team assignments** (as built, Phase 2D): an assignment is individual or team work, fixed at
publishing. Teams belong to the course (`teams`, one team per student), formed by instructors
by hand or at random. Each team gets one repository, `{assignment-slug}-{team-slug}-{6 hex}`,
and every member is a collaborator. Each member still has their own submission, so grades,
grade reports, LMS scores, regrades and dashboards stay per student; the team's submissions
share the repository and its work:

- one automatic run per push for the team (on its *lead* submission, the earliest one), one
  daily manual-run quota, and one deadline run that grades every member;
- extensions are granted to the whole team (one deadline per repository);
- staff score the rubric and write feedback once for the team, and comment on its code once;
- each member's process score counts only their own commits (teammates' commits are labelled,
  not "unattributed"), and their **contribution share** (meaningful changed lines) is shown
  to staff, flagged below `team_min_contribution_share` (default 15%), never deducted.

Moving a student to another team before the deadline moves their open submission to the new
team's repository and removes their access to the old one (`team-access` job); graded
submissions stay where they are.

*Bring-your-own-repo* mode is also supported: the student installs the App on their own repo
and the platform links it. Use this for capstones; provisioning is the default for consistency.

### 5.3 Webhook ingestion pipeline

```
GitHub ──POST──▶ api /webhooks/github
                 1. Verify X-Hub-Signature-256 (HMAC-SHA256, constant-time compare)
                 2. INSERT github_events (delivery_id UNIQUE) ── duplicate? → 200, stop
                 3. Enqueue job {event_id} on queue "github-events"
                 4. Return 202 (target: under 200 ms; GitHub times out after 10 s)
worker  ──────▶  5. Load raw payload, normalise by event type:
                    push          → upsert commits (author mapping, stats via API when needed)
                    pull_request  → upsert pull_requests; maybe trigger evaluation
                    issues/...    → upsert issues / comments
                    workflow_run  → reconcile evaluation_run status
                 6. Map github_user_id → profile; unmatched authors are kept and flagged
                 7. Apply the assignment's evaluation trigger policy (§6.2)
                 8. Emit Realtime update / notification
```

- **Idempotency**: `X-GitHub-Delivery` is the dedup key; every normaliser upserts on GitHub's
  node IDs.
- **Missed deliveries**: a cron job runs every 15 minutes. It lists failed deliveries via the App
  API and redelivers them, and every few hours it reconciles recent commits/PRs per active
  repo with conditional (`ETag`) requests.
- **Rate limits**: installation tokens are cached until about 5 minutes before they expire. Every
  response's `x-ratelimit-remaining` is tracked per installation, and the worker backs off when
  it falls below 10%. Use GraphQL to bulk-fetch PR/review data for dashboards.
- **Raw payload retention**: keep 90 days, then prune (normalised rows stay).

### 5.4 Activity metrics and the process score

Activity **counts toward grades**, so the metrics have to be fair, hard to game and
explainable to the student. The worker computes raw signals per student per day into
`activity_daily`. A scoring function in `packages/core/process` then turns them into a
0–100 **process score** using the assignment's `process_policy`.

**Raw signals collected**
- commits: count, *meaningful* commits, distinct active days, longest inactive gap, share of
  work done in the final 24 hours
- pull requests: opened, merged, with description, linked to an issue, reviewed, review
  comments addressed
- issues: opened, closed, linked to commits/PRs
- evaluation trend: number of runs, first-pass vs final pass rate
- team assignments: each member's share of meaningful changes and PR authorship

**What counts as a meaningful commit** (the anti-gaming filter)
- excludes merge commits, bot commits, commits after the effective deadline, and commits
  that only touch lockfiles, generated files, formatting/whitespace, or files in the stack
  profile's `ignore_paths` (e.g. `dist/`, `node_modules/`)
- excludes trivial changes below a minimum size (default 3 changed non-blank lines)
- caps credit per day (e.g. at most 3 meaningful commits count per day), so 50 tiny commits
  in one evening earn the same as a steady day's work
- attributes `Co-authored-by:` trailers for pair work when the policy allows it

**Example `process_policy`** (set by the teacher, with defaults from the institution):

```yaml
weight_in_grade: 15            # % of final grade
criteria:
  - key: active_days           # distinct days with ≥1 meaningful commit
    target: 6                  # full marks at 6+ days, linear below
    weight: 40
  - key: steady_progress       # ≤ 40% of meaningful changes in the final 24 h
    threshold: 0.40
    weight: 25
  - key: pr_workflow           # merged PRs that have a description and a linked issue
    target: 3
    weight: 20
  - key: issue_tracking        # issues opened and closed, linked to PRs
    target: 3
    weight: 15
team:
  min_contribution_share: 0.15 # a member below 15% gets a flag for staff review, never an automatic zero
```

**Fairness rules**
- Students see their live process score with a per-criterion breakdown and the reason for
  each point lost (e.g. "Only 3 active days so far; target 6").
- **Unattributed commits** (git email not linked to their GitHub account) are shown to the
  student with fix instructions and can be claimed. Staff confirm the claim.
- Team contribution metrics only ever *flag* for staff review. They never cut an individual's
  grade automatically.
- The process score is frozen at the effective deadline and stored with the grade, alongside
  the policy version used to compute it.
- Teachers can override any criterion with a reason, which is audited.

---

## 6. Automated evaluation pipeline

### 6.1 Stack profiles and the runtime contract

Any tech stack is supported, but **each project is fixed to one stack profile** that a teacher
or institution admin picks when creating the assignment. After publishing, the profile is
locked: changing it means creating a new suite version and re-grading explicitly.

A **stack profile** is a versioned, admin-curated definition stored in `stack_profiles`
(global profiles from the super admin, plus institution-specific ones):

```yaml
# grader/stacks/mern-node20/profile.yaml
key: mern-node20
version: 3
display_name: "MERN (Node 20, React, MongoDB)"
detect: [ "backend/package.json", "frontend/package.json" ]   # contract validator check
services:                                    # what the harness expects the app to expose
  frontend: { port: 3000, health: / }
  backend:  { port: 4000, health: /health }
datastores: [ mongodb:7 ]                    # provided by the harness, app reads env vars
env_required: [ MONGODB_URI, JWT_SECRET ]
stages:
  build:         { run: "docker compose build" }
  lint:          { run: "npm run lint --prefix frontend && npm run lint --prefix backend",
                   report: eslint-json }
  student_tests: { run: "npm test --prefix backend -- --reporter=junit", report: junit }
  coverage:      { run: "npm run coverage --prefix backend", report: lcov }
ignore_paths: [ "**/node_modules/**", "**/dist/**", "**/package-lock.json" ]
template_repo: hbe-templates/mern-starter
```

Example catalogue: MERN, PERN / Next.js + Postgres, Django + React, Spring Boot + Angular,
Laravel + Vue, .NET + React, Next.js + Supabase. Admins add more by contributing a profile
and adapter. No platform code changes are needed.

**How "any stack" stays gradeable**
- **Hidden tests are black-box**: HTTP API tests and Playwright browser tests talk to the
  running app through its declared ports, so one suite works whatever language the app is in.
- **Stack-specific stages** (lint, the student's own unit tests, coverage) are run by the
  profile's **adapter**, which converts the output to JUnit / a common JSON format.
- **Contract validator** is the first stage. It checks the repo matches the profile (expected
  files, `compose.yaml` present, required env vars used) and fails fast with a clear message.
- Each assignment's template repo is generated from the profile's template, so students start
  from a working skeleton. `.hbe/contract.yaml` is protected by CODEOWNERS and a ruleset.

As built:

- The global profiles are `node22-api`, `mern-node20` and `django-react`; their definitions are
  in `grader/stacks/<key>.json` (a test keeps the database seed identical). `lint` and
  `student_tests` name an `image`, a `setup` command (run once per image and command) and a `run`
  command; `report: junit` points at the JUnit file the run writes. The harness runs them in
  fresh containers on a copy of the repository (§6.4); assignments turn them on and give each a
  share of the automated score (`assignments.stage_settings`), and can turn off hidden API or
  browser stages.
- Starter templates for the three profiles are in `templates/` (published to GitHub as template
  repositories with `scripts/publish-template.sh`); CI grades each one with the real harness.
  The harness provides the profile's datastores, so templates keep their own database behind a
  `local` Compose profile for students' computers.

### 6.2 Trigger policies (per assignment)

- `on_push` to the default branch (debounced: newest SHA wins within a 5-minute window)
- `on_pull_request` (opened / synchronize): result posted as a Check Run on the PR
- `manual` (student "Run tests" button; quota per day, e.g. 10)
- `on_deadline`: final graded run on the **graded commit**: the head of the default branch as
  of the cutoff, by GitHub's push time (commit dates can be faked; pushes by bots don't count).
  The cutoff is the student's deadline (with any extension) plus the grace period, plus the
  late window when the assignment accepts late work. A push after the deadline and grace period
  is late by the number of started days, and the late penalty applies. After the cutoff,
  pending automatic runs are cancelled, students can no longer start runs, and the process
  score is frozen. A graded run that hits a platform error is retried up to three times.
- Extensions: an extension whose cutoff is still ahead reopens a finalized submission.
- teacher re-run (any SHA, any suite version)

Concurrency guard: at most one active run per (submission, trigger type); per-course and
global concurrency caps keep Actions minutes in check.

### 6.3 Run lifecycle

```mermaid
sequenceDiagram
  participant W as worker
  participant G as GitHub (grader repo)
  participant R as Actions runner
  participant A as api
  participant S as Supabase

  W->>S: insert evaluation_run (status=queued, sha, suite_version)
  W->>G: workflow_dispatch evaluate.yml {run_id, repo, sha, suite}
  G->>R: start job (fresh VM)
  R->>R: checkout student repo @ sha (read-only App token)
  R->>R: checkout hidden suite (grader repo)
  R->>A: POST /v1/runs/{id}/started (OIDC JWT)
  R->>R: docker compose build & up (internal network, no host mounts)
  R->>R: wait for health checks, seed DB
  R->>R: stages: build → lint → student tests → API tests → E2E (Playwright) → extras
  R->>A: POST /v1/runs/{id}/artifacts → signed upload URLs
  R->>S: upload logs, JUnit, screenshots, traces
  R->>A: POST /v1/runs/{id}/results (OIDC JWT, results.json)
  A->>W: enqueue score-run
  W->>S: test_results, scores, status=completed
  W->>G: Check Run on student commit/PR (summary + failed tests)
  W->>S: Realtime broadcast + notification
```

### 6.4 Grader security

| Threat | Mitigation |
|--------|-----------|
| Student code attacks platform servers | Student code only ever runs on throwaway Actions VMs; Render never executes it. |
| Student reads or exfiltrates hidden test source | Tests run from a separate container; the suite is **not** mounted into student containers. After the build step, student containers run on an `internal: true` Docker network with no internet access. Failure *details* are intentionally shown (§6.5), so tests rely on per-run randomised data rather than secrecy. |
| Student tampers with grading workflow | The workflow lives in the private grader repo, not the student's repo. Student-repo CI is informational only. |
| Forged results | The results endpoint accepts only a **GitHub Actions OIDC token**. The API checks `iss`, `aud=https://api.example.com`, `repository=<org>/hbe-grader`, and `workflow_ref` (`evaluate.yml` on `refs/heads/main`). The first callback binds the evaluation run to that workflow run (`run_id`); later callbacks must come from the same one. There are no long-lived shared secrets. |
| Student's `compose.yaml` reaches the host | The contract stage rejects privileged mode, host networking and namespaces, extra capabilities, devices, the Docker socket, and mounts, build contexts or secrets outside the repository (symlinks resolved). |
| Student config reads runner secrets | Docker commands run with a minimal environment, so Compose interpolation can't read the runner's OIDC request token; the harness also removes it from its own environment. Checkouts don't persist credentials in `.git/config`. |
| Resource abuse (fork bombs, infinite loops) | Per-stage `timeout-minutes`, a job-level timeout, Docker `--memory`/`--pids-limit`, and log size cap. |
| Secret leakage | The grader job has no platform secrets. Its App token is read-only and scoped to the single student repo (`actions/create-github-app-token` with `repositories:`). |

### 6.5 Results format and student-facing failure detail

Students should get **enough detail to fix the problem**. The test **source** stays hidden;
the failure itself is shown in full. Suite authors must give every test a human-readable
title, a `hint`, and assertion messages that state what was expected. A suite lint step in
the grader repo CI rejects tests that are missing these.

What a student sees for each failed test:

| Field | Example |
|-------|---------|
| Title and category | "Login rejects a wrong password" · API · Authentication |
| What was checked | `POST /api/auth/login` with a valid email and a wrong password |
| Expected vs actual | Expected status **401**; got **500** |
| Evidence | Request and response excerpt (headers and body, truncated to 4 KB); for E2E tests the failing step, a screenshot and a Playwright trace |
| Their app's logs | Backend/frontend container logs around the failure time (it's their own code, so these are shown in full, with secrets redacted) |
| Hint | "Catch invalid credentials and return 401 instead of letting the error bubble up." |
| Docs link | Optional link to the assignment spec section |

Never shown: test source code, the exact seed data, or internal-only `staff_notes`.

To stop students hard-coding answers once they can see detailed failures, tests use
**data randomised per run** (generated users, products, IDs). Assertions check behaviour,
not fixed values. Rubric review by staff remains part of the grade.

```jsonc
{
  "run_id": "uuid",
  "sha": "abc123",
  "stack_profile": "mern-node20@3",
  "suite_version": "a3-v4",
  "started_at": "...", "finished_at": "...",
  "stages": [
    { "key": "build", "status": "passed", "duration_ms": 81234 },
    { "key": "api",   "status": "failed", "duration_ms": 22011,
      "tests": [ {
        "id": "auth.login.rejects-bad-password",
        "title": "Login rejects a wrong password",
        "category": "Authentication",
        "status": "failed",
        "weight": 2,
        "expected": "HTTP 401", "actual": "HTTP 500",
        "message": "POST /api/auth/login returned 500 for wrong password",
        "hint": "Catch invalid credentials and return 401 ...",
        "evidence": { "request": "api/evidence/42-req.txt", "response": "api/evidence/42-res.txt",
                      "screenshot": null, "trace": null, "log_window": "logs/backend.log#L120-L188" },
        "staff_notes": "Common cause: bcrypt.compare not awaited"   // staff-only
      } ] }
  ],
  "infra_error": null      // set when the failure is ours, not the student's → auto-retry, never graded
}
```

### 6.6 Scoring

`final = Σ (component_weight × component_score) − late_penalty`. Components are configured per
assignment (weights must add up to 100):

- **automated**: weighted tests, normalised to 0–100 (test weights live in the suite manifest)
- **rubric**: manual criteria scored by staff (code quality, architecture, UX, docs)
- **process**: activity-based score from §5.4; included by default (e.g. 15%), and the
  teacher can change the weight
- **late penalty**: per-day %, cap, grace period, and per-student extensions

Scores are **recomputed, not mutated**: a `grade` row points to the evaluation run, rubric
review, process snapshot and policy versions it was derived from. Staff overrides are separate
rows with a reason, so the result can always be audited. Every released grade also produces an
immutable **grade report** (§12).

As built:

- The automated component is the graded commit's run (the deadline run or a staff re-grade;
  any completed run on that commit as a fallback). Missing work scores 0 there without a run.
- The late penalty is a percentage **of the grade earned**: `computed = raw × (1 − days × per_day%)`.
- A grade is **complete** when every weighted component is in (the graded run; a score for every
  rubric criterion). Only complete grades can be released.
- Every recomputation that changes anything appends a version (`grades.version`); exactly one
  is current. An override (instructors only, reason required, reason visible to staff only)
  carries over to later versions until it is changed or removed.
- Course staff (instructors and TAs) score the rubric and write feedback; instructors and
  institution admins override and release. Students see their grade, rubric scores and
  feedback only after release; versions created after release are released immediately.
- All grading writes go through the API (audited with the acting user); the Data API is
  read-only for these tables.

### 6.7 Capacity and cost: Actions minutes

Planning load is about **100 students active at once** across all institutions. Rough guide:
`students × runs/week × minutes/run`, e.g. 100 × 5 × 6 = 3,000 min/week, or about 12,000
min/month, with peaks before deadlines. Private-repo minutes on GitHub's free and Team plans
run out below that, so:

1. Apply for **GitHub Education / GitHub Campus** benefits for the grader organisation.
2. Run **self-hosted ephemeral runners** (autoscaled VMs with `--ephemeral`, or ARC on
   Kubernetes) labelled `hbe-grader`. At this scale, 4–8 concurrent runners clear a deadline
   rush in minutes. The workflow only changes its `runs-on`. **The platform pays for all
   evaluation compute**, so the runner pool is platform-owned and shared across institutions,
   with per-institution quotas (§4.1). See DEPLOYMENT.md §3 for the EC2 runner design.
3. Cap runs per student per day and debounce pushes (§6.2). Track minutes per institution.

---

## 7. Application surfaces

### Student portal
Dashboard (assignments, deadlines, latest scores, live process score) · assignment detail
(spec, stack profile, repo link, contract, run history) · run detail (stage timeline, failed
tests with expected/actual, evidence, hints, logs, screenshots, trace viewer) · feedback inbox ·
"Run tests" button with remaining quota · **my history** (all submissions and released grade
reports across courses and terms, with downloadable PDFs) · unattributed-commit claims.

### Teacher portal
Course overview heat-map (students × assignments) · assignment builder (stack profile,
template repo, suite version, rubric, process policy, triggers, weights, deadlines, late
policy, LMS link) · submission review (diff viewer, run results, inline comments synced to
PR review comments, rubric scoring, process breakdown) · **student performance profile**
(longitudinal view across all assignments and terms, with every archived submission and grade
report) · activity analytics · bulk actions (re-run, extend deadline, release grades, sync to
LMS) · CSV export.

### Institution admin panel
Users (invite, bulk CSV import, role changes, deactivate, read-only "view as" with audit) ·
courses and staff assignment · GitHub orgs and installation health · stack profiles
(enable global ones, add institution ones) · grader suites and versions · LMS connections and
sync status · SSO configuration · settings (quotas, concurrency, retention, process-policy
defaults, email templates, branding) · audit log · usage (Actions minutes, storage).
**Records search**: any student's full submission and grade history, including archived
courses.

### Super admin console (platform operator)
Institutions (create, suspend, plan/limits) · global stack profiles · cross-tenant system
health (queue depth, failed jobs, webhook lag, runner pool, storage growth) · feature flags ·
platform audit log. Super admins see tenant data only through an audited, time-boxed
"support access" grant from the institution admin.

---

## 8. API surface (`api`, versioned under `/v1`)

| Area | Endpoints (illustrative) | Auth |
|------|--------------------------|------|
| Webhooks | `POST /webhooks/github` | HMAC signature |
| Grader | `POST /v1/runs/:id/started`, `POST /v1/runs/:id/artifacts`, `POST /v1/runs/:id/results` | GitHub OIDC |
| Assignments | `POST /v1/assignments/:id/publish` (provisions repos), `POST /v1/assignments/:id/regrade` | Staff JWT |
| Runs | `POST /v1/submissions/:id/runs` (manual trigger, quota-checked) | Student/staff JWT |
| Feedback | `POST /v1/submissions/:id/feedback` (optionally mirrored to PR review) | Staff JWT |
| Grades | `POST /v1/courses/:id/grades/release`, `GET /v1/courses/:id/grades.csv` | Staff JWT |
| Records | `GET /v1/submissions/:id/snapshots/:sid/download`, `GET /v1/grade-reports/:id/versions/:v.pdf`, `GET /v1/students/:id/performance` | Staff/admin JWT; student JWT for own released reports |
| LMS | `/lti/login`, `/lti/launch`, `/lti/deep-link/:token`, `/lti/register`, `/.well-known/jwks.json`, `POST /v1/assignments/:id/lms-sync`, `POST /v1/lms-course-links/:id/roster-sync`, `GET /v1/oauth/google/callback` | LTI id_token, single-use picker token / staff JWT |
| Institution admin | `/v1/admin/users`, `/v1/admin/settings`, `/v1/admin/installations`, `/v1/admin/stack-profiles`, `/v1/admin/lms-connections` | Institution admin JWT + MFA |
| Super admin | `/v1/platform/institutions`, `/v1/platform/stack-profiles`, `/v1/platform/health` | Super admin JWT + MFA |
| Health | `GET /healthz` (liveness), `GET /readyz` (DB + queue) | none |

Plain CRUD reads (lists, dashboards) go straight from `web` to Supabase under RLS. The API
handles anything that needs the service role, GitHub, the queues, or multi-step transactions.
OpenAPI is generated from Zod schemas (`fastify-type-provider-zod`).

---

## 9. Background jobs (pg-boss queues and schedules)

| Queue | Jobs | Retries |
|-------|------|---------|
| `github-events` | normalise webhook payloads | 5, exponential backoff |
| `provisioning` | create repo from template, add collaborators, apply rulesets | 5; failures surface on the admin dashboard |
| `evaluations` | dispatch run, score run, publish Check Run | 3; infra errors are auto-retried once |
| `notifications` | in-app + email (Resend/Postmark) | 5 |
| `sync` | reconciliation, redelivery of failed webhooks | 3 |
| `records` | source snapshots, grade report rendering (JSON + PDF), course-close archival | 5; a failure blocks grade release until resolved |
| `lms-grade-sync`, `lms-roster-sync` | grade passback (one job per released grade version), roster sync | 6 (about an hour, exponential backoff); then shown on the assignment's sync panel and retried by the nightly reconciliation |

Schedules (pg-boss cron, run by the worker role; times in Asia/Singapore): `*/15` redeliver failed webhooks · `*/5` reap stale runs (queued for more than 30
minutes or running for more than 45) · `0 * * * *` deadline cut-off and final graded runs · `0 2 * * *` activity rollups ·
`0 3 * * 0` retention cleanup · `30 2 * * *` archive replication to the external bucket ·
`11 1 * * *` LMS roster sync · `29 3 * * *` LMS grade reconciliation.

---

## 10. Deployment

Full details, including free-tier limits, the Render demo setup, the AWS EC2 production design
and the migration runbook, are in **[DEPLOYMENT.md](./DEPLOYMENT.md)**. In summary:

| | Demo (now) | Production (later) |
|---|---|---|
| App host | Render **free** web service, Singapore region, one container with `ROLES=web,api,worker` | **AWS EC2, ap-southeast-1 (Singapore)**, the same image as separate `web`, `api` and `worker` containers behind Caddy (then an ALB) |
| Database / auth / storage | Supabase **Free**, Singapore | Supabase **Pro**, Singapore (backups, PITR, no pausing). Stays managed. |
| Queue / schedules | pg-boss in Supabase Postgres | Same |
| Grader runners | GitHub-hosted runners (free org minutes) | Ephemeral self-hosted runners on EC2 spot instances in a separate AWS account |
| Archive replica | Cloudflare R2 free tier | S3 ap-southeast-1 with Object Lock |
| Domain | `app.` / `api.` CNAME → Render | Same hostnames → EC2/ALB. Cutover is a DNS change. |

Rules that keep the migration cheap (enforced from day one):
1. Use **only your own hostnames** (`app.example.com`, `api.example.com`) in every external
   configuration: the GitHub App webhook, OIDC audience, Supabase redirect URLs, LTI
   registrations and Google OAuth. Never use `*.onrender.com`.
2. **One Dockerfile**; Render runs the Docker runtime, so production runs the same image.
3. All configuration comes from environment variables; nothing in the code is Render-specific.
4. Processes are stateless and handle `SIGTERM` gracefully; files go to Supabase Storage.
5. Queue and schedules live in Postgres, so there's no Redis to migrate.

### 10.1 CI/CD (GitHub Actions on this repo)

1. PR: lint, typecheck, unit tests (`packages/core` has high coverage), migration lint
   (`supabase db lint`), RLS policy tests (pgTAP), and API integration tests against a local Supabase stack.
2. Merge to `main`: apply migrations to staging, Render auto-deploys staging, run smoke E2E tests.
3. Promote: tag a release, apply migrations to production, then deploy production (a Render
   deploy hook in the demo; on EC2, push the image to ECR and roll it out via SSM).
4. Grader suites are published to the private grader repo by a workflow, with version tags
   (`suite/a3-v4`). Assignments pin a suite version, so a re-grade is reproducible.

---

## 11. Cross-cutting concerns

- **Observability**: structured JSON logs (pino) with `request_id`, `run_id`, `delivery_id`;
  Sentry for web/api/worker; OpenTelemetry traces exported to Grafana Cloud or Honeycomb;
  queue view in the super admin console (pg-boss tables); alerts on webhook lag, queue depth, failed-run
  rate, Actions minutes burn, and Supabase connection saturation.
- **Database connections**: services use Supavisor (transaction mode, port 6543) with small
  pools; the worker uses session mode only where it needs `LISTEN` or advisory locks.
- **Realtime**: subscribe with `postgres_changes` on narrow tables (`evaluation_runs`,
  `notifications`) with RLS; use broadcast channels for high-frequency progress events.
- **Storage**: private buckets `run-artifacts`, `submission-archive` and `grade-reports`
  (signed URLs only), plus public `avatars`. Paths are
  `inst/{institution_id}/course/{course_id}/...`, and storage RLS checks institution and course
  membership. Retention rules are in §12.
- **Audit log**: append-only `audit_logs` for role changes, grade overrides, releases,
  impersonation, settings changes, and deletions.
- **Privacy**: the platform is hosted in **Singapore**, so the baseline is Singapore's **PDPA**
  (Personal Data Protection Act), plus any stricter rules an institution's own country imposes.
  Student repos live on GitHub (outside Singapore), and GitHub-hosted runners also run outside
  Singapore; the privacy notice must disclose this. Moving grading to EC2 runners in Singapore
  keeps test execution in-region. The platform needs data-processing agreements with
  Supabase/Render/AWS/GitHub, export and deletion
  on request, minimal PII, retention limits, and no student data in logs or Sentry breadcrumbs.
- **Accessibility**: WCAG 2.1 AA; keyboard-navigable diff/review UI; colour-blind-safe status colours.

---

## 12. Records and persistence (submissions and grade reports)

Every submission and every grade report is kept so that teachers and admins can review a
student's performance at any time, even after the GitHub repo is deleted, the course is
archived or the LMS course is gone.

### 12.1 What is stored, and for how long

**Retention rule:** records are kept for as long as the institution's contract is active, and
for **2 years after the contract ends**. Then they are purged (§12.5).

| Record | Where | Retention |
|--------|-------|-----------|
| Submission metadata, runs, test results, rubric scores, feedback, grades, process snapshots | Postgres | Contract + 2 years |
| **Source snapshot** of each graded SHA: `git bundle` (history up to that SHA) and `.tar.gz` of the tree, with its SHA-256 | Storage `submission-archive` | Contract + 2 years |
| **Grade report**: canonical JSON and rendered PDF, versioned | Storage `grade-reports` + `grade_reports` table | Contract + 2 years; every version is kept |
| Artifacts of the final graded run (logs, screenshots, traces, evidence) | Storage `run-artifacts` | Contract + 2 years |
| Artifacts of non-final runs | Storage `run-artifacts` | 180 days (14 in demo); metadata and results follow the retention rule |
| Raw webhook payloads | Postgres `github_events` | 90 days |

Snapshots are created **inside the grader job**, which already has the checkout. The job
creates the bundle and tarball, hashes them, and uploads them through a signed URL. This costs
the app host no CPU, memory or disk, which matters on the 512 MB free instance. A snapshot is
kept whenever a run is used for a grade: the deadline run on `final_sha`, and any re-grade.
Re-grading an old submission can use the snapshot instead of GitHub.

### 12.2 Grade report contents

Each report is generated when grades are released and regenerated as a **new version**
whenever anything that affects the grade changes (override, regrade, late extension).
A report contains:

- institution, course, term, assignment, student/team, stack profile, suite version
- the graded SHA, snapshot hash and a link to the archived code
- automated results per stage and per test, with the same failure detail the student saw
- rubric scores with staff comments; general and inline feedback
- the process score breakdown and the policy version used
- late penalty, extensions, overrides with reasons, the final score, and the LMS sync status
- generation timestamp, report version and the SHA-256 of the JSON (tamper evidence)

PDFs are rendered in the worker with PDFKit ([ADR 0015](adr/0015-grade-report-pdfs-with-pdfkit.md)), which is pure JS, so the app host
needs no headless browser. Teachers, admins and the student (after release) can download any version.

As built (Phase 1):

- Reports and snapshots live in private Storage buckets (`grade-reports`, `submission-archive`),
  created by migration. Only the platform writes them; downloads are 60-second signed URLs made
  with the **user's own session**, so Storage's row-level policy (the record must be visible to
  that user) decides. Override reasons and staff notes are never written into reports.
- A report is generated for every released grade version, numbered per submission in release
  order. The snapshot of the graded commit is uploaded by the grader job (git bundle of the
  history plus a tarball of the tree, through signed upload URLs) and its hashes are recorded.
- Students have a **My grades** page; staff open a **student profile** with the same record
  across every course they may see. Course staff get a students × assignments matrix, at-risk
  signals and a CSV export.
- Replication (§12.4) and the end-of-contract workflow (§12.5) are built; see their "As built"
  notes.

### 12.3 Performance views

- **Student profile** (teacher/admin): every course, assignment, attempt, score trend,
  process-score trend, most-failed test categories, with links to snapshots and reports.
- **Course and institution analytics**: score distributions, per-test failure rates,
  at-risk students, cohort comparisons across terms.
- Built on SQL views and nightly materialised views (`mv_student_performance`,
  `mv_assignment_stats`) scoped by `institution_id`.

### 12.4 Durability

- Postgres: Supabase Pro daily backups plus **PITR** in production.
- Supabase database backups do **not** contain Storage objects. A nightly cron job therefore
  replicates `submission-archive`, `grade-reports` and final-run artifacts to an external
  bucket: Cloudflare R2 for the demo, then **S3 ap-southeast-1 with Object Lock in governance
  mode** in production. Governance mode protects objects from accidental or malicious deletion,
  but still lets the retention purge remove them once their retention ends.
- Quarterly restore drill: restore a database snapshot plus the objects for one course and
  check the report hashes.
- When a course is archived, its GitHub repos are archived (read-only) too, and the platform
  keeps working from the snapshots.

As built: a nightly worker job (`records-replication`) copies every grade report (JSON and PDF),
source snapshot (bundle and tarball) and graded-run artifact to the archive bucket
(`ARCHIVE_S3_*`), as `<bucket>/<path>`, streaming each object. With `ARCHIVE_OBJECT_LOCK` set,
objects are locked until the institution's purge date, or `contract_grace_years` from the copy
while the contract runs. `replicated_objects` records what was copied; files not in Storage yet
are tried again the next night. Without `ARCHIVE_S3_BUCKET` (local development) nothing is
replicated. The client is the AWS SDK, so S3, R2 and other S3-compatible stores work; CI tests it
against local Supabase Storage's S3 API.

### 12.5 End of contract, purging and erasure requests

- **Contract end**: an institution admin or super admin sets `contract_ended_at`. The
  institution becomes read-only, and `purge_after = contract_ended_at + 2 years`.
- **Before the purge**: 90 days and 30 days before `purge_after`, institution admins are
  emailed and offered a **full export**: a ZIP with all grade report PDFs and JSON, source
  snapshots, and CSVs of grades and activity.
- **Purge**: a scheduled job deletes the institution's Storage objects (primary and
  replica), then its database rows. It writes a purge certificate (counts and hashes) to the
  platform audit log, which keeps no student PII.
- As built: institution admins (or super admins) end the contract on the institution's
  **Records** page (`POST /v1/institutions/:id/contract`); only super admins can reopen it (a
  renewal). Admins can start a **full export** there at any time, also after the contract ends: a
  worker job streams a ZIP (every report version, every snapshot, `grades.csv`, and a README
  manifest listing every file) to the archive bucket (or to the `record-exports` Storage bucket
  locally), and the download is a 5-minute signed URL. Notices go to every institution admin 90
  and 30 days before `purge_after`, in the app and always by email. The purge runs daily for
  institutions past `purge_after`: it replicates first, deletes Storage objects and their
  replicas (bypassing governance locks), then deletes the institution in one transaction with
  row auditing switched off (so the audit log doesn't copy the data it removes), keeps the
  institution row marked `purged` (name and dates only), deletes accounts that belonged to no
  other institution, removes the institution's audit history and writes the certificate (row
  counts per table, object counts per bucket, the number of replicas and accounts deleted, and a
  SHA-256 of the deleted object list).
- **Erasure requests during the contract**: the institution is the data controller. An
  institution admin either **anonymises** the student (removing PII from the profile and
  reports, and replacing it with a pseudonymous ID in grade records) or deletes the records
  outright, following the institution's policy. Either way, the action is audited.

---

## 13. LMS integration (Canvas, Moodle, Google Classroom)

The platform stays the system of record. LMSs receive **released grades** and can be used to
**launch** students and teachers into the platform and to **sync rosters**. Each institution
configures its own connections in the admin panel (`lms_connections`).

| Capability | Canvas | Moodle (4.x) | Google Classroom |
|------------|--------|--------------|------------------|
| Protocol | LTI 1.3 Advantage | LTI 1.3 Advantage | Google Classroom REST API (OAuth 2.0) |
| Registration | Canvas admin creates an LTI Developer Key (or Dynamic Registration) | Site admin adds an external tool (Dynamic Registration supported) | Institution's Google Workspace admin allows the platform's OAuth client; teacher grants consent |
| Launch / SSO | LTI resource-link launch → platform session (§4.2) | Same | "Open in platform" link on the coursework; Google sign-in |
| Link an assignment | Deep Linking creates the LMS assignment that points at the platform assignment | Same | Platform creates the `courseWork` through the API (required: Classroom only accepts grade writes from the project that created the coursework) |
| Roster sync | NRPS (Names and Role Provisioning) | NRPS | `courses.students.list` / `teachers.list` |
| Grade passback | AGS: a line item per assignment, then a score (`scoreGiven`, `scoreMaximum`, `gradingProgress=FullyGraded`, comment with a link to the report) | AGS | `studentSubmissions.patch` (`draftGrade`/`assignedGrade`), then `return` |

### 13.1 Grade sync flow

As built for LTI 1.3 (AGS) and Google Classroom (where step 1 is "Post to Google Classroom",
which creates the coursework).

1. **Columns.** An instructor adds platform assignments in the LMS with Deep Linking (§13.2);
   each link asks the LMS for a gradebook column (`lineItem`, `resourceId` = the assignment).
   Launches from the link tell the platform the column's URL (`lms_assignment_links`). If an
   assignment has no column yet (released before it was added in the LMS), the worker finds the
   one it made earlier by `resourceId` or creates it.
2. **Release.** Every released grade version queues an `lms-grade-sync` job (the same hook that
   queues its grade report). The worker sends it to every LMS gradebook linked to the course:
   `scoreGiven` on the column's scale, `FullyGraded`, a comment linking to the assignment, as the
   student's LMS user (from their launches or the roster).
3. **Idempotent.** `lms_grade_syncs` has one row per (grade version, column): a version is sent
   once; an override or regrade is a new version and is sent again. Failures are recorded on
   the row and retried with backoff for about an hour; students the LMS doesn't know yet are
   `skipped` and sent after the next roster sync.
4. **Sync panel.** Staff see each student's status on the assignment page (sent, failed with the
   LMS's answer, not sent and why, changed in the LMS) and can send everything, or one student,
   again.
5. **Reconciliation** (nightly): compares each gradebook's results with what was sent and marks
   grades changed in the LMS as `conflict`; they are never overwritten automatically. A
   teacher changes the grade on the platform (a new version) or sends it again. It also queues
   released grades that never reached a linked gradebook and retries failed ones.
6. **Rosters** (nightly, or "Read the roster now" on the course page): NRPS members are matched
   by email like launches; learners who are members join the course; people the platform
   can't match wait in the admin's review queue. Nobody is removed automatically.

### 13.2 Implementation notes

As built (Phases 2A–2C: LTI 1.3 with deep linking, AGS and NRPS, and Google Classroom):

- `packages/lms` implements LTI 1.3 with `jose`: launch verification (platform signature from
  its JWKS, `iss`, `aud` and `azp`, expiry, `nonce`, LTI version, deployment, message type),
  the claims the platform sends (roles mapped to course roles, context, resource link, custom
  parameters, NRPS and AGS endpoints), the tool's keys and JWKS, and Dynamic Registration. It
  also ships a stand-in platform (`@hbe/lms/testing`) that the integration and browser tests
  launch from.
- The tool endpoints are on `api`: `GET /.well-known/jwks.json`, `GET/POST /lti/login` (OIDC
  initiation), `POST /lti/launch`, and `GET /lti/register` (Dynamic Registration). They are
  browser navigations, so failures are short pages, not JSON.
- **Login and launch.** The login finds the connection by issuer and `client_id` (Canvas Cloud
  shares one issuer, so the client ID identifies the school), stores a single-use `state` and
  `nonce` (`lti_launch_states`, ten minutes) and redirects to the platform. The launch consumes
  the state, checks the issuer, and verifies the id_token. A connection that lists no
  deployment IDs accepts any deployment of its client ID (Canvas only tells the tool its
  deployment at launch); listing them restricts launches to those.
- **Who is it?** `lms_user_links (lms_connection_id, lms_user_id)`: an earlier match, else the
  email among the institution's active members, else a pending invitation for that email (the
  account is created and the invitation accepted at once), else the person waits for an admin
  (`/lti/pending`). Admins link waiting people to a member or refuse them on the LMS page; the
  platform never links to someone by guesswork.
- **Signing in.** The api makes a one-time Supabase sign-in token (admin `generateLink`) and
  sends the browser to `/auth/lti`, where the web app exchanges it for a session (`verifyOtp`)
  and continues to the course or assignment. Inside the LMS's iframe the session cookie would be
  third-party, so a launch from an iframe (`Sec-Fetch-Dest: iframe`) opens the platform in its
  own tab instead.
- **Which course?** Each LMS course (LTI context) gets an `lms_course_links` row with its NRPS and
  AGS endpoints. The first instructor (or LMS administrator) to launch from an unlinked one
  chooses which of their courses it is; learners launching from a linked course join it as
  students (`course_memberships.source = 'lms'`) and land on the assignment named by the
  `assignment_id` custom parameter, or on the course.
- **Registering.** Admins either create a one-time Dynamic Registration URL (seven days; only its
  hash is stored) and paste it into Canvas or Moodle, or enter the platform's details by hand.
  Dynamic registration checks that the platform's configuration is served by its issuer, except
  for Canvas, whose schools serve it from their own domains under `https://canvas.instructure.com`.
- **Deep linking.** An LtiDeepLinkingRequest from an instructor (or LMS administrator) opens a
  picker of the published assignments of the courses they teach. It runs inside the LMS's
  frame, where the platform's session cookie isn't available, so a single-use, one-hour URL
  token (`lti_deep_link_requests`, only its hash stored) is its credential. The answer is a
  signed LtiDeepLinkingResponse auto-posted to the LMS: one `ltiResourceLink` per assignment,
  with `custom.assignment_id` and a `lineItem`. Choosing assignments for an unlinked LMS course
  links it to their course.
- **Services.** AGS and NRPS calls use OAuth 2 client-credentials tokens obtained with a client
  assertion signed by the tool key (`private_key_jwt`), cached per connection and scope set.
- **Keys.** `LTI_PRIVATE_KEY_BASE64` / `LTI_KEY_ID` sign the tool's messages (deep linking
  responses and service token requests). During a yearly rollover the previous key stays
  published in the JWKS (`LTI_PREVIOUS_PRIVATE_KEY_BASE64`, `LTI_PREVIOUS_KEY_ID`). Locally a
  temporary key is generated at startup.
- **Google Classroom** (Phase 2C). An admin turns it on for the institution (one
  `google_classroom` connection). Each teacher connects their own Google account from a course
  page: OAuth 2.0 with PKCE and offline access, consent for their classes, rosters (with
  emails) and coursework; the refresh token is stored AES-256-GCM-encrypted under
  `TOKEN_ENCRYPTION_KEY` (`google_accounts`, never readable through the API or by users, and
  not copied into the audit log). They link one of their classes to the course (its students
  who are members join it, others wait for an admin, as with NRPS) and post assignments there:
  the platform creates the coursework, because Classroom only accepts grades on coursework made
  by the same OAuth client. Released grades are written with `studentSubmissions.patch`
  (`assignedGrade`, `draftGrade`) and the submission is returned so the student sees it.
  Everything runs as the teacher who linked the class; when Google reports their consent
  revoked, the account is marked and the course page asks them to connect again.
- **One gradebook model.** `apps/server/src/lti/gradebook.ts` gives LTI (AGS + NRPS) and
  Classroom the same shape (column, post score, results, roster), so passback, the sync panel,
  roster sync and reconciliation work the same for both.
