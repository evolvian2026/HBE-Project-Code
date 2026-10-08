# Delivery Roadmap

The plan is built around getting one end-to-end vertical slice working early (a student pushes,
tests run, a teacher sees the result), then widening it. Durations assume 2–3 developers and are
indicative only.

## Phase 0: Foundations (1–2 weeks)
- Monorepo scaffold (pnpm, Turborepo, TS strict, ESLint/Prettier, Vitest), CI on PRs
- Local Supabase stack, first migrations (profiles, roles, courses, memberships), pgTAP harness
- Supabase Auth: GitHub (students) + email (staff); Custom Access Token Hook
- Render Blueprint for `web` + `api` on staging; custom domain on staging subdomain
- Dev GitHub App + test org; webhook endpoint with signature verification and `github_events` inbox
- ADR-001 to ADR-005 recording decisions D1–D7 from ARCHITECTURE §1

**Exit:** a staff user and a student can log in on `staging.example.com`; webhooks land in the DB.

## Phase 1: MVP vertical slice (4–6 weeks)
- Admin: invite users (single + CSV), create courses, assign staff
- Teacher: create and publish an assignment → repos provisioned from template
- Worker + BullMQ: webhook normalisation (push, PR, issues), commit attribution
- Grader v1: private grader repo, `evaluate.yml`, Compose harness, API + Playwright stages,
  OIDC-authenticated results callback, artifacts in Storage
- Check Run on the student commit; run history and run detail pages
- Teacher matrix dashboard; submission page with results and activity timeline
- Rubric scoring, general feedback, grade computation, release, CSV export
- In-app notifications; deadline cron with final graded run

**Exit:** a pilot course with 1–2 assignments runs end to end on production.

## Phase 2: v1 hardening (4 weeks)
- Inline code review UI and PR review mirroring
- Extensions, regrade requests, late policy edge cases, bulk re-run
- Reconciliation cron jobs (redelivery, sync), stale-run reaper, quotas, concurrency caps
- Realtime run status, email notifications
- Admin: settings, audit log viewer, system health, GitHub installation health
- Observability (Sentry, OTel, alerts), backup/restore drill, load test at NFR-1 targets
- Accessibility audit; security review / pen-test of the auth, RLS and grader paths

**Exit:** ready for the full term rollout.

## Phase 3: Scale & extend (ongoing)
- Self-hosted ephemeral runners (ARC) for cost and throughput
- Teams and sections, analytics (per-test failure heat-maps, at-risk prediction)
- Optional stages: Lighthouse, Semgrep, coverage, similarity detection
- LTI 1.3 / LMS grade passback
- Multi-institution tenancy, if needed

## Key risks
| Risk | Mitigation |
|------|-----------|
| Actions minutes cost/limits at deadline peaks | Education benefits, debounce + quotas, self-hosted runners in Phase 3, queue instead of drop |
| Student stacks too varied for one harness | Strict runtime contract enforced by templates; contract validator as the first stage, with a clear error |
| Flaky E2E tests causing unfair grades | Deterministic seeds, retry-once for E2E tests with flake tracking, infra-error classification, teacher re-run |
| GitHub rate limits during bulk provisioning | Throttled provisioning queue, per-installation rate tracking, provisioning days before release |
| RLS mistakes leaking data across courses | pgTAP tests per policy, service-role use limited to api/worker, security review |
| Webhook loss | Persist first, redelivery cron, periodic reconciliation |
