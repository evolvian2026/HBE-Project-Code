# 0013. GitHub organisations are linked by the signed webhook

Status: Accepted (2026-10-08)

## Context

GitHub's post-install redirect carries `installation_id` in the query string, which anyone can forge.

## Decision

An institution admin with a linked GitHub account creates a short-lived link request. The installation is mapped only when the signed `installation.created` webhook arrives with that same GitHub user as sender. Super admins can map manually.

## Consequences

Admins must link GitHub before connecting an organisation; no GitHub API calls are needed for linking.
