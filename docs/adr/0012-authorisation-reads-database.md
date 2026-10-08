# 0012. Authorisation reads memberships from the database, not token claims

Status: Accepted (2026-10-08)

## Context

JWTs live for up to an hour; a removed or demoted member must lose access immediately.

## Decision

The Custom Access Token Hook adds `platform_role` and `institutions` claims for UI routing only. RLS helpers (`private.*`) and the API's `loadActor` always read current memberships from the database.

## Consequences

One extra indexed lookup per request; revocation is instant. Suspended institutions disappear for their members at once.
