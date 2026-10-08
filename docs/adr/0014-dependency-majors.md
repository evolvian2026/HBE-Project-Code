# 0014. Pin the newest release of well-understood major versions

Status: Accepted (2026-10-08)

## Context

Several libraries released new majors in 2026 (TypeScript 7, Zod 4, pg-boss 12, Vitest 5, Next.js 16).

## Decision

Phase 0 pins the latest release of the previous majors (TypeScript 5.9, Zod 3.25, pg-boss 10, Vitest 3, Next.js 15.5, ESLint 9) with exact versions.

## Consequences

Upgrades are planned, tested changes rather than surprises; schedule a dependency-upgrade pass before Phase 2.
