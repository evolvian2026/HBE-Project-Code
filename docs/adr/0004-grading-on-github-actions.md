# 0004. Student code runs on throwaway CI runners

Status: Accepted (2026-10-08)

## Context

Evaluations need isolation, a full Docker Compose stack, and cheap scale-to-zero compute.

## Decision

Grading runs in a private grader repo's GitHub Actions workflow: hosted runners first, ephemeral self-hosted EC2 runners later. Results return via an OIDC-authenticated callback.

## Consequences

No long-lived secrets on runners; switching runner type is one repo variable. Actions minutes are a cost the platform pays and must meter.
