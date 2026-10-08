# 0008. Multi-tenant shared schema

Status: Accepted (2026-10-08)

## Context

Several institutions share one deployment and must never see each other's data.

## Decision

Every tenant-owned table carries `institution_id`; parents expose `unique (institution_id, id)` and children use composite foreign keys, so cross-tenant links are rejected by the database. RLS filters by membership.

## Consequences

Slightly wider keys and indexes; isolation is enforced even for code that bypasses RLS.
