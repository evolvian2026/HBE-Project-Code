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
| Institution admin | Manages users, roles, courses, stack profiles, GitHub orgs, LMS connections and settings for one institution. |
| Super admin | Platform operator: creates and manages institutions, global stack profiles, platform health. |
| System | GitHub App, worker role (jobs + schedules), grader runners. |

---

## 2. Functional requirements

### FR-0 Institutions (multi-tenancy)
| ID | Requirement | P |
|----|-------------|---|
| FR-0.1 | Super admins create, suspend and configure institutions (name, slug, limits, data region label). | M |
| FR-0.2 | All data is isolated per institution; no user can read another institution's data unless they are a member of it. | M |
| FR-0.3 | A user may belong to several institutions with different roles, and can switch between them. | M |
| FR-0.4 | Each institution connects its own GitHub org(s), LMS connections, SSO, branding, quotas and retention policy. | M |
| FR-0.5 | Per-institution usage reporting: active users, evaluation runs, runner minutes, storage. The platform pays for compute, so usage reports drive plan limits. | M |
| FR-0.7 | Contract lifecycle: set the contract end date, which makes the institution read-only and schedules the purge 2 years later. | S |
| FR-0.6 | Per-institution subdomain or vanity domain. | C |

### FR-1 Authentication & accounts
| ID | Requirement | P |
|----|-------------|---|
| FR-1.1 | Students sign in with GitHub; the platform stores their immutable GitHub user id. | M |
| FR-1.2 | Staff sign in with email/password, Google/Microsoft OAuth, or the institution's SAML SSO. | M (email/OAuth) / S (SAML) |
| FR-1.3 | Institution admin and super admin accounts must use MFA (TOTP). | M |
| FR-1.4 | Institution admins invite users individually or by CSV (name, email, role, course, GitHub login). | M |
| FR-1.5 | A user who arrives by invite is matched to their invite on first login (email or GitHub login). | M |
| FR-1.6 | Users can be deactivated (they can't sign in, and their history is kept). | M |
| FR-1.7 | Profile page: name, avatar, linked GitHub account, notification preferences. | S |
| FR-1.8 | Users launched from an LMS (LTI 1.3) are signed in and linked to their platform profile; they're asked to link GitHub on first launch. | S |

### FR-2 Courses & membership
| ID | Requirement | P |
|----|-------------|---|
| FR-2.1 | Institution admins and teachers create courses (name, code, term, GitHub org, timezone). | M |
| FR-2.2 | Course roles: instructor, TA, student; one user can hold different roles in different courses. | M |
| FR-2.3 | Students can be grouped into teams/sections within a course. | S |
| FR-2.4 | Courses can be archived (read-only, excluded from active dashboards). | S |

### FR-3 Assignments
| ID | Requirement | P |
|----|-------------|---|
| FR-3.1 | Teachers create assignments with spec (Markdown), **stack profile**, template repo, release date, due date, late policy. | M |
| FR-3.1a | Any tech stack can be used. The teacher or admin picks one stack profile per project, and it is locked once published (ARCHITECTURE §6.1). | M |
| FR-3.1b | Super admins maintain global stack profiles; institution admins enable them and can add their own. | M |
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
| FR-4.4a | **Process score** computed from activity using a configurable, capped policy, and included as a grade component. | M |
| FR-4.4b | Students see their live process score with per-criterion reasons and can claim unattributed commits (staff confirm). | M |
| FR-4.4c | Team contribution share is computed and flagged for staff review (never automatically penalised). | S |
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
| FR-5.7 | Students see enough detail to fix every failure: test title, what was checked, expected vs actual, request/response or E2E step evidence, screenshot or trace, their app's logs, and a hint. Test source code stays hidden. | M |
| FR-5.7a | Grader suites must include titles, hints and descriptive assertion messages for every test (enforced by suite linting), and use randomised data per run. | M |
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
| FR-6.8 | Grade export (CSV). | M |

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
| FR-8.1 | User management (within the admin's institution): search, filter, invite, change role, deactivate, reset MFA. | M |
| FR-8.2 | Course management and staff assignment. | M |
| FR-8.3 | GitHub installations: list orgs, permissions health, reinstall prompts. | M |
| FR-8.4 | Grader suite registry: versions, linked assignments. | S |
| FR-8.5 | Platform settings: quotas, concurrency, retention, email sender, feature flags, maintenance banner. | M |
| FR-8.6 | Audit log viewer with filters and export. | M |
| FR-8.7 | System health: queue depths, failed jobs (retry/discard), webhook lag, Actions minutes used. | S |
| FR-8.8 | Read-only impersonation ("view as") for support, always audited. | C |
| FR-8.9 | Super admin console: institutions, global stack profiles, cross-tenant health; tenant data only through an audited support-access grant. | M |

### FR-9 Records & performance history
| ID | Requirement | P |
|----|-------------|---|
| FR-9.1 | Every graded submission's source is archived (git bundle and tarball, with hash) independently of GitHub. | M |
| FR-9.2 | Every grade release generates an immutable, versioned grade report (JSON + PDF); changes create new versions and old versions are kept. | M |
| FR-9.3 | Teachers and admins can view any student's full performance history (all courses, terms, submissions, reports), including archived courses. | M |
| FR-9.4 | Students can view and download their own released grade reports at any time. | M |
| FR-9.5 | Archived records are replicated to an external write-once bucket. | S |
| FR-9.7 | Records are kept for the contract plus 2 years. Institution admins get export notices 90 and 30 days before the purge, plus a full export (ZIP of reports, snapshots and CSVs). | S |
| FR-9.6 | Institution admins handle erasure requests by anonymising or deleting, according to policy, with an audit record. | S |

### FR-10 LMS integration
| ID | Requirement | P |
|----|-------------|---|
| FR-10.1 | Institution admins configure LMS connections: Canvas (LTI 1.3), Moodle (LTI 1.3), Google Classroom (API). | M |
| FR-10.2 | Teachers link a platform course and its assignments to an LMS course (Deep Linking / courseWork creation). | M |
| FR-10.3 | Released grades are pushed to the LMS automatically, with a link to the grade report; overrides and regrades re-sync. | M |
| FR-10.4 | Sync status per student is visible to teachers, with retry; failures are alerted. | M |
| FR-10.5 | Roster sync from the LMS (NRPS / Classroom API) to course memberships. | S |
| FR-10.6 | Launch from the LMS into the platform (LTI resource link) with single sign-on. | S |
| FR-10.7 | Nightly reconciliation report of platform vs LMS grades. | S |

---

## 3. Non-functional requirements

| ID | Category | Requirement |
|----|----------|-------------|
| NFR-1 | Scale (v1 target) | About 100 concurrently active students across all institutions (design headroom to 1,000 without re-architecture); 5k webhook events/day; 50 queued evaluation runs at deadline peaks (queue, don't drop). Records grow without limit, so queries must stay fast with years of history. |
| NFR-2 | Latency | p95 page load under 2 s; p95 API under 300 ms (excluding GitHub calls); webhook ack under 500 ms; webhook to visible in UI under 30 s. |
| NFR-3 | Evaluation time | Typical run under 10 minutes end to end; hard job timeout 20 minutes. |
| NFR-4 | Availability | 99.5% monthly for web/api; no lost webhooks (persist first, reconcile later). |
| NFR-5 | Durability & retention | Production: Supabase daily backups plus PITR, Storage records replicated to S3 with Object Lock, RPO ≤ 1 h (DB) / 24 h (objects), RTO ≤ 4 h, quarterly restore drill. Demo: nightly `pg_dump` to R2. Records are kept for the contract plus **2 years**, then purged after export notices (ARCHITECTURE §12.5). |
| NFR-15 | Cost / free-tier demo | The full flow must run on free tiers (Render, Supabase, GitHub, R2, Resend) for demos, within their limits (DEPLOYMENT.md §1.2). Moving to EC2 must need no code changes and no change of hostnames. |
| NFR-6 | Security | OWASP ASVS L2 as the baseline; RLS on all user-data tables with tenant isolation tests for every table; LTI launches validated (nonce, state, issuer, deployment); LMS OAuth tokens encrypted at rest; secrets only in Render env groups / GitHub secrets; webhook HMAC; OIDC for grader callbacks; CSP, HSTS, secure cookies; dependency scanning (Dependabot/Renovate); least-privilege GitHub App. |
| NFR-7 | Isolation | Untrusted student code never runs on platform infrastructure (ARCHITECTURE §6.4). |
| NFR-8 | Privacy & residency | All platform data is hosted in **Singapore** (Supabase ap-southeast-1, Render singapore, AWS ap-southeast-1). Baseline is Singapore's PDPA plus institution-specific rules. Data minimisation, export and delete on request, DPAs with vendors, no PII in logs; the privacy notice discloses GitHub-hosted data. |
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
| Jobs & schedules | **pg-boss** (Postgres-backed) behind `packages/queue` | BullMQ + Redis (needs Redis, which the free tier lacks), Supabase Queues (pgmq, no built-in cron) |
| DB access | supabase-js (RLS, from web); Kysely with generated types (api/worker) | Drizzle, Prisma |
| Database / Auth / Storage / Realtime | Supabase | — |
| GitHub | GitHub App, Octokit (`@octokit/app`, `@octokit/webhooks`), GraphQL for bulk reads | — |
| Test execution | GitHub Actions (hosted → self-hosted ephemeral runners), Docker Compose, Playwright, Supertest/Hurl for API tests | Self-managed Firecracker/gVisor sandbox (later, if needed) |
| Email | Resend or Postmark (also used as Supabase SMTP) | SES |
| LMS | LTI 1.3 Advantage via `jose` (Canvas, Moodle); `googleapis` Classroom client | ltijs |
| Reports | PDFKit (PDF, ADR 0015), canonical JSON + SHA-256 | Headless Chromium |
| Archive backup | Cloudflare R2 free (demo) → S3 ap-southeast-1 with Object Lock (production) | Backblaze B2 |
| Observability | pino, Sentry, OpenTelemetry → Grafana Cloud/Honeycomb | Datadog |
| Hosting | **Demo:** Render free web service (Singapore), all roles in one container. **Production:** AWS EC2 ap-southeast-1 with Docker Compose + Caddy, later ALB + Auto Scaling group; Terraform; ECR; SSM | ECS Fargate, Render paid |
| Grader compute | GitHub-hosted runners (demo) → ephemeral self-hosted EC2 spot runners via `terraform-aws-github-runner` (production); **paid by the platform** | — |
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
- [ ] LTI 1.3 tool registration for each pilot institution's Canvas / Moodle; Google Cloud project with the Classroom API enabled and OAuth consent screen verified
- [ ] External archive bucket (R2/B2) with object lock
- [ ] Template agreement for institutions (DPA, retention defaults)
- [ ] Sentry project(s); uptime monitor on `/healthz`
- [ ] Data protection: privacy policy, terms, DPAs, retention schedule

---

## 6. Decisions log

| # | Question | Decision | Where it is reflected |
|---|----------|----------|-----------------------|
| Q1 | Tenancy | **Multiple institutions** on one deployment, isolated by `institution_id` + RLS | ARCHITECTURE §4.1, FR-0, DATA_MODEL |
| Q2 | Tech stacks | **Any stack**; the teacher/admin fixes one **stack profile** per project | ARCHITECTURE §6.1, FR-3.1a/b |
| Q3 | Volume and persistence | About **100 concurrent students**; all submissions and grade reports stored and viewable at any time | NFR-1, ARCHITECTURE §12, FR-9 |
| Q4 | LMS | Grades **flow to Canvas, Moodle and Google Classroom**; the platform stays the system of record | ARCHITECTURE §13, FR-10 |
| Q5 | Failure detail | Students see **enough detail to fix the problem**; test source stays hidden | ARCHITECTURE §6.5, FR-5.7 |
| Q6 | Activity in grades | **Yes**: a process score is a standard grade component | ARCHITECTURE §5.4, FR-4.4a–c |
| Q7 | Data residency | **Singapore** (Supabase, Render and AWS all in ap-southeast-1 / singapore) | NFR-8, DEPLOYMENT |
| Q8 | Retention | Contract **+ 2 years**, then purge after export notices | ARCHITECTURE §12, FR-9.7, NFR-5 |
| Q9 | Who pays for evaluation compute | **The platform**: shared, platform-owned runner pool with per-institution quotas | ARCHITECTURE §6.7, DEPLOYMENT §2.4 |
| Q10 | Hosting | **Free tiers for the demo**, then **AWS EC2** (Supabase stays managed, upgraded to Pro) | DEPLOYMENT, NFR-15 |
