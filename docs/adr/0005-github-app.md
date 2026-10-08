# 0005. Integrate through a GitHub App

Status: Accepted (2026-10-08)

## Context

We need per-organisation installation, fine-grained permissions, webhooks and Check Runs.

## Decision

One GitHub App, installed once per institution organisation. Its OAuth credentials also back Supabase's GitHub sign-in.

## Consequences

Installation tokens expire automatically; installations must be mapped to institutions (ADR 0013).
