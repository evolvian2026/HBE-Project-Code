# 0006. Webhook-first, persist-then-process

Status: Accepted (2026-10-08)

## Context

GitHub times out webhook deliveries after 10 seconds and may deliver twice or not at all.

## Decision

The api role verifies the signature, stores the delivery (unique on delivery id), enqueues a job and returns 202. The worker processes idempotently; a schedule re-enqueues anything left unprocessed.

## Consequences

Duplicate deliveries are harmless; a failed enqueue never loses an event.
