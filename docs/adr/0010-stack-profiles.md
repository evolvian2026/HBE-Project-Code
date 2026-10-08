# 0010. Stack profiles fix each project's tech stack

Status: Accepted (2026-10-08)

## Context

Any stack is allowed, but the grader must know how to build and test each project.

## Decision

Admins curate versioned stack profiles; each assignment is locked to one.

## Consequences

Hidden tests stay black-box (HTTP and browser); stack-specific stages use adapters.
