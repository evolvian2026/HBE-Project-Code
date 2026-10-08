# Architecture Decision Records

Short records of significant decisions. Status of all: **Accepted** (2026-10-08).

| # | Decision |
|---|----------|
| [0001](0001-typescript-monorepo.md) | TypeScript monorepo with pnpm and Turborepo |
| [0002](0002-supabase-system-of-record.md) | Supabase as the system of record |
| [0003](0003-app-host-runs-only-our-code.md) | The app host runs only platform code |
| [0004](0004-grading-on-github-actions.md) | Student code runs on throwaway CI runners |
| [0005](0005-github-app.md) | Integrate through a GitHub App |
| [0006](0006-webhook-first-async.md) | Webhook-first, persist-then-process |
| [0007](0007-sql-migrations.md) | SQL migrations are the schema source of truth |
| [0008](0008-multi-tenant-shared-schema.md) | Multi-tenant shared schema |
| [0009](0009-platform-is-system-of-record.md) | The platform keeps the master copy of records |
| [0010](0010-stack-profiles.md) | Stack profiles fix each project's tech stack |
| [0011](0011-process-score.md) | Activity counts toward grades as a capped process score |
| [0012](0012-authorisation-reads-database.md) | Authorisation reads memberships from the database, not token claims |
| [0013](0013-installation-linking-by-webhook.md) | GitHub organisations are linked by the signed webhook |
| [0014](0014-dependency-majors.md) | Pin the newest release of well-understood major versions |

To add one: copy the format, take the next number, and link it here.
