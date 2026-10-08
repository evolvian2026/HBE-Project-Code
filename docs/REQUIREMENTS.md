# Technical Requirements

Requirement IDs (`FR-x.y`, `NFR-x`) are meant to be referenced from issues and PRs.
Priority: **M** = MVP, **S** = should-have in v1, **C** = could-have / later.

---

## 1. Actors

| Actor | Description |
|-------|-------------|
| Student | Works on assigned projects in GitHub; sees their own results and feedback. |
| Teacher (Instructor) | Owns courses and assignments; reviews, grades and gives feedback. |
| TA | Course-scoped helper with review/grading rights but no course configuration rights. |
| Admin | Manages users, roles, courses, integrations and platform settings. |
| System | GitHub App, worker, cron jobs, grader runners. |

---

## 2. Functional requirements

### FR-1 Authentication & accounts
| ID | Requirement | P |
|----|-------------|---|
| FR-1.1 | Students sign in with GitHub; the platform stores their immutable GitHub user id. | M |
| FR-1.2 | Staff sign in with email/password or Google/Microsoft SSO. | M |
| FR-1.3 | Admin accounts must use MFA (TOTP). | M |
| FR-1.4 | Admins invite users individually or by CSV (name, email, role, course, GitHub login). | M |
| FR-1.5 | A user who arrives by invite is matched to their invite on first login (email or GitHub login). | M |
| FR-1.6 | Users can be deactivated (they can't sign in, and their history is kept). | M |
| FR-1.7 | Profile page: name, avatar, linked GitHub account, notification preferences. | S |

### FR-2 Courses & membership
| ID | Requirement | P |
|----|-------------|---|
| FR-2.1 | Admins and teachers create courses (name, code, term, GitHub org, timezone). | M |
| FR-2.2 | Course roles: instructor, TA, student; one user can hold different roles in different courses. | M |
| FR-2.3 | Students can be grouped into teams/sections within a course. | S |
| FR-2.4 | Courses can be archived (read-only, excluded from active dashboards). | S |

### FR-3 Assignments
| ID | Requirement | P |
|----|-------------|---|
| FR-3.1 | Teachers create assignments with spec (Markdown), template repo, runtime contract, release date, due date, late policy. | M |
| FR-3.2 | Assignments are individual or team-based. | S |
| FR-3.3 | Publishing provisions a private repo per student/team from the template and grants access. | M |
| FR-3.4 | Bring-your-own-repo mode: a student links a repo where the App is installed. | S |
| FR-3.5 | Per-student deadline extensions. | M |
| FR-3.6 | Configurable evaluation triggers (push, PR, manual with quota, deadline) and grading weights. | M |
| FR-3.7 | Pin a grader suite version; re-grading with a new version is an explicit action. | M |
| FR-3.8 | Rubric builder: criteria, max points, level descriptors; reusable rubric templates. | M |
| FR-3.9 | Clone an assignment into another course or term. | S |

### FR-4 GitHub monitoring
| ID | Requirement | P |
|----|-------------|---|
| FR-4.1 | Receive and verify webhooks for push, PR, review, issue and comment events. | M |
| FR-4.2 | Store commits, PRs, reviews, issues and comments linked to submission and student. | M |
| FR-4.3 | Attribute commits by GitHub user id; flag unmatched authors (e.g. wrong git email). | M |
| FR-4.4 | Per-student activity timeline and metrics (see ARCHITECTURE §5.4). | M |
| FR-4.5 | Reconcile missed events (redeliver failed deliveries, periodic sync). | M |
| FR-4.6 | Detect suspicious patterns: force-push to main, commits after the deadline, large single "dump" commits. These are flags only, not penalties. | S |
| FR-4.7 | Similarity/plagiarism check across submissions (e.g. MOSS/JPlag integration). | C |

### FR-5 Automated evaluation
| ID | Requirement | P |
|----|-------------|---|
| FR-5.1 | Run a submission's full stack (frontend, backend, database) in an isolated environment from a declared contract. | M |
| FR-5.2 | Stages: build, lint, student tests, hidden API tests, hidden E2E browser tests; each stage can be toggled per assignment. | M |
| FR-5.3 | Optional stages: Lighthouse performance/accessibility, dependency audit, static analysis (Semgrep), test coverage. | C |
| FR-5.4 | Each run records the SHA, suite version, per-test results, logs, screenshots and traces. | M |
| FR-5.5 | Results appear in the platform and as a GitHub Check Run on the commit/PR. | M |
| FR-5.6 | Infra failures are distinguished from student failures, auto-retried, and never graded. | M |
| FR-5.7 | Students see which visible tests failed and why; hidden tests show only a name/category, at a level of detail the teacher configures. | M |
| FR-5.8 | Teachers can re-run any submission at any SHA, individually or in bulk. | M |
| FR-5.9 | Per-student daily run quota and global concurrency limits. | M |
| FR-5.10 | Final graded run on the last commit before the effective deadline (deadline plus any extension). | M |

### FR-6 Review, feedback & grading
| ID | Requirement | P |
|----|-------------|---|
| FR-6.1 | Submission review screen: file tree, diff from template or between SHAs, run results, activity. | M |
| FR-6.2 | Inline line comments; optionally mirrored to a GitHub PR review. | S |
| FR-6.3 | General feedback with Markdown and reusable comment snippets. | M |
| FR-6.4 | Rubric scoring per criterion with comments. | M |
| FR-6.5 | Final grade computed from components, with manual override (reason required, audited). | M |
| FR-6.6 | Grades and feedback stay hidden until staff release them (per assignment or per student). | M |
| FR-6.7 | Students can request a regrade with a message; staff resolve it. | S |
| FR-6.8 | Grade export (CSV); LMS integration (LTI 1.3 / Canvas / Moodle). | M (CSV) / C (LTI) |

### FR-7 Dashboards & notifications
| ID | Requirement | P |
|----|-------------|---|
| FR-7.1 | Student dashboard: assignments, deadlines, latest run, grades, feedback. | M |
| FR-7.2 | Teacher dashboard: students × assignments matrix, at-risk students (no activity in N days, failing tests near the deadline). | M |
| FR-7.3 | Live updates of run status without page refresh. | S |
| FR-7.4 | In-app and email notifications: run finished, feedback released, deadline approaching, regrade answered. | M (in-app) / S (email) |
| FR-7.5 | Course analytics: pass rate per test, which tests fail most, score distribution. | S |

### FR-8 Administration
| ID | Requirement | P |
|----|-------------|---|
| FR-8.1 | User management: search, filter, invite, change platform role, deactivate, reset MFA. | M |
| FR-8.2 | Course management and staff assignment. | M |
| FR-8.3 | GitHub installations: list orgs, permissions health, reinstall prompts. | M |
| FR-8.4 | Grader suite registry: versions, linked assignments. | S |
| FR-8.5 | Platform settings: quotas, concurrency, retention, email sender, feature flags, maintenance banner. | M |
| FR-8.6 | Audit log viewer with filters and export. | M |
| FR-8.7 | System health: queue depths, failed jobs (retry/discard), webhook lag, Actions minutes used. | S |
| FR-8.8 | Read-only impersonation ("view as") for support, always audited. | C |

---

## 3. Non-functional requirements

| ID | Category | Requirement |
|----|----------|-------------|
| NFR-1 | Scale (v1 target) | 2,000 active students, 100 staff, 50 concurrent courses; 20k webhook events/day; 200 concurrent evaluation runs at deadline peaks (queue, don't drop). |
| NFR-2 | Latency | p95 page load under 2 s; p95 API under 300 ms (excluding GitHub calls); webhook ack under 500 ms; webhook to visible in UI under 30 s. |
| NFR-3 | Evaluation time | Typical run under 10 minutes end to end; hard job timeout 20 minutes. |
| NFR-4 | Availability | 99.5% monthly for web/api; no lost webhooks (persist first, reconcile later). |
| NFR-5 | Durability | Supabase daily backups plus PITR in production; RPO ≤ 1 h, RTO ≤ 4 h; quarterly restore drill. |
| NFR-6 | Security | OWASP ASVS L2 as the baseline; RLS on all user-data tables; secrets only in Render env groups / GitHub secrets; webhook HMAC; OIDC for grader callbacks; CSP, HSTS, secure cookies; dependency scanning (Dependabot/Renovate); least-privilege GitHub App. |
| NFR-7 | Isolation | Untrusted student code never runs on platform infrastructure (ARCHITECTURE §6.4). |
| NFR-8 | Privacy | FERPA/GDPR-aligned: data minimisation, retention policy, export and delete on request, DPAs with vendors, no PII in logs. |
| NFR-9 | Auditability | All grade-affecting and permission-affecting actions recorded with actor, time, before/after. |
| NFR-10 | Accessibility | WCAG 2.1 AA. |
| NFR-11 | Observability | Structured logs, error tracking, tracing, alerting (ARCHITECTURE §11). |
| NFR-12 | Maintainability | TypeScript strict; at least 80% line coverage on `packages/core`; pgTAP tests for every RLS policy; ADRs for significant decisions in `docs/adr/`. |
| NFR-13 | Portability | Grader runtime contract is stack-agnostic (any language that runs under Docker Compose). |
| NFR-14 | Browser support | Latest 2 versions of Chrome, Edge, Firefox, Safari; responsive down to tablet; read-only views usable on mobile. |

---

## 4. Technology stack summary

| Layer | Choice | Alternatives considered |
|-------|--------|-------------------------|
| Language | TypeScript (strict) | — |
| Monorepo | pnpm workspaces + Turborepo | Nx |
| Frontend | Next.js (App Router), React, Tailwind CSS, shadcn/ui, TanStack Query/Table, Monaco diff viewer, Recharts | Remix, SvelteKit |
| API | Fastify + Zod + OpenAPI generation | NestJS (heavier), Next.js route handlers (fine for MVP) |
| Jobs | BullMQ on Render Key Value | Supabase Queues (pgmq) / pg-boss: fewer services, less tooling |
| DB access | supabase-js (RLS, from web); Kysely with generated types (api/worker) | Drizzle, Prisma |
| Database / Auth / Storage / Realtime | Supabase | — |
| GitHub | GitHub App, Octokit (`@octokit/app`, `@octokit/webhooks`), GraphQL for bulk reads | — |
| Test execution | GitHub Actions (hosted → self-hosted ephemeral runners), Docker Compose, Playwright, Supertest/Hurl for API tests | Self-managed Firecracker/gVisor sandbox (later, if needed) |
| Email | Resend or Postmark (also used as Supabase SMTP) | SES |
| Observability | pino, Sentry, OpenTelemetry → Grafana Cloud/Honeycomb | Datadog |
| Hosting | Render (web, api, worker, cron, Key Value) | — |
| DNS / domain | Any registrar; Cloudflare DNS recommended (proxy **off** for Render records) | — |
| Platform testing | Vitest, Playwright, pgTAP, MSW for GitHub API mocks | Jest |

---

## 5. External accounts & configuration checklist

- [ ] Domain registered; DNS provider chosen
- [ ] GitHub organisation(s) for classroom repos and the private grader repo; GitHub Education benefits applied for
- [ ] GitHub Apps: dev, staging, prod (private key, webhook secret, client ID/secret)
- [ ] Supabase projects: staging, prod (Pro plan for prod); auth providers; custom SMTP; Custom Access Token Hook; storage buckets
- [ ] Render workspace; Blueprint connected to this repo; env groups per environment; custom domains verified
- [ ] Email provider with SPF/DKIM/DMARC configured for the domain
- [ ] Sentry project(s); uptime monitor on `/healthz`
- [ ] Data protection: privacy policy, terms, DPAs, retention schedule

---

## 6. Open questions to settle before building

1. **Tenancy**: one institution, or multiple institutions (each with its own admins and GitHub
   orgs)? The data model includes `institutions` so both work, but multi-tenant changes the
   admin UX and RLS.
2. **Stacks**: will every assignment use one stack (e.g. React + Node + Postgres), or should
   any Docker-runnable stack be supported? This decides how generic the harness must be.
3. **Volume and budget for evaluation minutes**: numbers of students and runs per week, so we
   can choose hosted or self-hosted runners.
4. **LMS**: is there an LMS (Canvas, Moodle, Google Classroom) that grades must flow into?
5. **Hidden-test policy**: how much failure detail students see for hidden tests.
6. **Activity in grades**: whether process metrics may count towards a grade, and how.
7. **Data residency** requirements, which determine the Supabase and Render regions.
