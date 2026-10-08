# 0007. SQL migrations are the schema source of truth

Status: Accepted (2026-10-08)

## Context

RLS policies, triggers and helper functions are database code and need review and tests.

## Decision

Hand-written SQL migrations under `supabase/migrations`, tested with pgTAP (`supabase/tests`). Kysely types are maintained by hand and checked against the live schema by an integration test.

## Consequences

Every new tenant table must also be added to `tests.visible_rows`, or the isolation test fails.
