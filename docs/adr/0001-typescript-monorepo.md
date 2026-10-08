# 0001. TypeScript monorepo with pnpm and Turborepo

Status: Accepted (2026-10-08)

## Context

UI, API, worker, grader tooling and shared rules must agree on types and validation.

## Decision

One TypeScript (strict) monorepo: `apps/` for deployables, `packages/` for shared code (shipped as TS source and bundled by each app), pnpm workspaces and Turborepo for task orchestration.

## Consequences

Shared Zod schemas and types across all roles. Workspace packages need a bundler (esbuild for the server, Next.js for web); third-party deps of bundled packages are declared directly on the server so they resolve at runtime.
