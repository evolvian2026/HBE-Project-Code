# Delivery Roadmap

The plan is built around getting one end-to-end vertical slice working early (a student pushes,
tests run, a teacher sees the result, the grade is archived and reaches the LMS), then widening
it. Multi-tenancy is in the schema from the first migration, because adding it later is very
expensive. Durations assume 2–3 developers and are indicative only.

## Phase 0: Foundations (2 weeks) — ✅ built

Done: monorepo and CI; tenancy migrations with RLS, composite FKs and audit log; 66 pgTAP checks;
Supabase Auth (GitHub + email) with access token hook and invitation acceptance; super admin
console; institution switcher; role-aware institution pages; GitHub webhook intake, worker and
secure organisation linking; single Docker image with `ROLES`; settings package; ADRs 0001–0014;
Playwright end-to-end tests.

Carried into Phase 1: MFA enrolment UI and enforcement for admins (FR-1.3), invitation
management UI for institution admins, and deploying the free-tier demo environment.

- Monorepo scaffold (pnpm, Turborepo, TS strict, ESLint/Prettier, Vitest), CI on PRs
- Local Supabase stack; first migrations: institutions, profiles, institution and course
  memberships, `institution_id` + composite FKs convention; pgTAP **tenant-isolation** harness
- Supabase Auth: GitHub (students) + email (staff); Custom Access Token Hook with institution claims
- Super admin can create an institution; institution switcher in the UI
- Single Dockerfile with `ROLES` switch; `packages/queue` on pg-boss
- **Free-tier demo environment** (DEPLOYMENT.md §1): Render free (Singapore) + Supabase free
  (Singapore); `app.`/`api.` custom domains; keep-awake pg_cron job; nightly `pg_dump` to R2
- Dev GitHub App + test org; webhook endpoint with signature verification, `github_events`
  inbox, installation-to-institution mapping
- ADRs recording decisions D1–D11 from ARCHITECTURE §1

**Exit:** two test institutions on the demo environment, with users in each who can't see
each other's data (proven by tests); webhooks land in the DB.

## Phase 1: MVP vertical slice (6–8 weeks) — in progress

Built (slices 1A–1G): institution administration (members, single and CSV invitations,
courses, staff, GitHub organisation); two-factor authentication for admins, enforced in the
database; stack profiles (MERN, Django + React, and an API-only Node profile for the sample
suite); assignments with weights, late policy, rubric and hidden test suite; repository
provisioning from templates; activity tracking and the process score with explanations;
automated test runs (push, pull request and on-request triggers, debounce, quotas, concurrency
caps, a monthly minutes budget, a sandboxed offline Compose harness, black-box API tests with
random data, OIDC-authenticated results, check runs, run pages with full failure detail);
deadlines (graded commit by push time, late window, extensions, deadline runs with retries);
rubric scoring, feedback, versioned grades with overrides and release; grade reports (JSON +
PDF) for every released version and source snapshots of graded commits in Storage; student
"My grades" and staff student profiles; the course matrix with at-risk signals; CSV export; and
in-app notifications.

Still to do in Phase 1: the submission review screen with file tree and diffs (FR-6.1) and
inline comments (FR-6.2); regrade requests (FR-6.7); email notifications; the profiles' lint
and student-test stages and Playwright browser-test stages in the grader; uploading run logs
and traces to Storage; template repositories for the global stack profiles; deploying the
demo environment and running a pilot course.

- Institution admin: invite users (single + CSV), create courses, assign staff, connect a GitHub org
- **Stack profiles v1**: two global profiles (e.g. MERN and Django + React), with adapters and
  template repos; contract validator stage
- Teacher: create and publish an assignment locked to a stack profile → repos provisioned
- Worker role (pg-boss): webhook normalisation, commit attribution, meaningful-commit filter
- Grader v1: private grader repo, `evaluate.yml`, Compose harness, API + Playwright stages,
  randomised test data, OIDC-authenticated results, full failure evidence for students
- Check Run on the student commit; run history and run detail pages
- **Process score v1** (active days, steady progress, PR workflow) with student-facing breakdown
- Teacher matrix dashboard; submission page with results, activity and process breakdown
- Rubric scoring, feedback, grade computation (automated + rubric + process − late), release
- **Records v1**: source snapshots at the deadline and for graded runs; versioned grade report
  (JSON + PDF); student "my history"; teacher student-performance profile
- In-app notifications; deadline cron with final graded run; CSV export

**Exit:** a pilot course at one institution runs end to end on production, with every grade
report archived and downloadable.

## Phase 2: LMS and v1 hardening (5–6 weeks)
- **LMS integration**: LTI 1.3 tool (login, launch, deep linking, JWKS, dynamic registration)
  tested against Canvas and Moodle; AGS grade passback; Google Classroom courseWork + grade
  passback; sync panel with retry; roster sync (NRPS / Classroom); nightly reconciliation
- Archive replication to R2; contract-end, export-notice and purge workflow (contract + 2 years)
- Inline code review UI and PR review mirroring; extensions; regrade requests; bulk re-run
- Team assignments with contribution-share flags; commit claims workflow
- Reconciliation schedules, stale-run reaper, per-institution quotas and concurrency caps
- Realtime run status; email notifications
- Institution admin: settings, stack-profile management, LMS connections, SSO (SAML), audit
  log, usage; super admin console
- Observability, load test at NFR-1 targets, accessibility audit, security review / pen-test
  of the tenant isolation, auth, LTI and grader paths

**Exit:** second and third institutions onboarded on the demo stack, with grades flowing to
their LMSs.

## Phase 2.5: Move to production on AWS (1–2 weeks)
- Terraform `deploy/aws/` (stage A single host: EC2 t4g.medium, ASG of 1, Caddy, SSM, ECR,
  CloudWatch); S3 archive bucket with Object Lock
- Upgrade Supabase to Pro (PITR) in Singapore; turn off `DEMO_MODE` retention overrides
- DNS cutover following DEPLOYMENT.md §3; Render kept as a 48-hour rollback
- Grader runner stack in a separate `hbe-grader` AWS account (ephemeral EC2 spot runners)

**Exit:** production on EC2 with no code changes from the demo; runners in Singapore, paid by
the platform.

## Phase 3: Scale & extend (ongoing)
- Stage B high availability (ALB + multi-AZ Auto Scaling group) when uptime needs require it
- More stack profiles (Spring Boot, .NET, Laravel, …) contributed by institutions
- Analytics: per-test failure heat-maps, cohort comparisons across terms, at-risk prediction
- Optional stages: Lighthouse, Semgrep, coverage, similarity detection
- Per-institution subdomains / vanity domains; regional deployments if residency requires them
- Erasure/anonymisation workflow UI; retention policy automation

## Key risks
| Risk | Mitigation |
|------|-----------|
| Cross-tenant data leak | `institution_id` everywhere, composite FKs, RLS with pgTAP isolation tests on every table, service-role code always filters by tenant, pen-test before the second institution |
| Process score seen as unfair or gamed | Meaningful-commit filter, daily caps, transparent per-criterion breakdown, commit claims, staff override, team flags never auto-penalise |
| Detailed feedback lets students code to the tests | Randomised data per run, behaviour-based assertions, rubric review stays in the grade |
| "Any stack" makes the harness brittle | Curated, versioned stack profiles with adapters; black-box hidden tests; contract validator fails fast |
| LMS differences and API limits (Classroom only accepts grades on coursework the platform created) | Adapter per LMS, platform creates Classroom courseWork itself, idempotent syncs, reconciliation report |
| Losing records if GitHub or the LMS deletes data | Snapshots and reports in Storage, replicated to a write-once external bucket |
| Free-tier limits during demos (sleep, 512 MB RAM, 500 MB DB, 2,000 Actions minutes) | Keep-awake job, single process with low concurrency, demo retention overrides, run quotas and a monthly minutes budget |
| Runner cost (the platform pays) at deadline peaks | Debounce + quotas, spot instances, max-instance cap, AWS Budgets alerts, per-institution usage reports |
| Flaky E2E tests causing unfair grades | Deterministic harness, retry-once for E2E tests with flake tracking, infra-error classification, teacher re-run |
| RLS mistakes leaking data across courses | pgTAP tests per policy, service-role use limited to api/worker, security review |
| Webhook loss | Persist first, redelivery cron, periodic reconciliation |
