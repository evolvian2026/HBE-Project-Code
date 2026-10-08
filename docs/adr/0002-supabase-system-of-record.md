# 0002. Supabase as the system of record

Status: Accepted (2026-10-08)

## Context

Requested stack; we need Postgres, auth, storage and realtime with multi-role access control.

## Decision

Supabase Postgres holds all data; Supabase Auth issues identities; RLS is enabled on every table as a second line of defence behind the API's own checks.

## Consequences

Schema lives in SQL migrations (ADR 0007). Server code connects as the table owner and must authorise every query itself (`packages/core`).
