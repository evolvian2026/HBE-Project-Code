# 0003. The app host runs only platform code

Status: Accepted (2026-10-08)

## Context

Student submissions are untrusted code. Render (and plain EC2 app hosts) are not sandboxes.

## Decision

The app host (Render free for the demo, EC2 later) runs one Docker image for the web, api and worker roles, and never executes student code.

## Consequences

Grading runs elsewhere (ADR 0004). The same image and hostnames are used before and after the move to AWS, so migration is a config change (docs/CONFIGURATION.md).
