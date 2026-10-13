# Security review (Phase 2G)

What protects each part of the platform, what the review changed, and what is still open.
It is an internal review of the code, not a substitute for the external penetration test
recommended before the pilot (see "Still open").

## Tenant isolation

- Every tenant-owned table has row-level security; the policies, column grants and the
  security-definer helpers are covered by pgTAP (`supabase/tests/database`), and a guard test fails if a
  new tenant table isn't listed in `tests.visible_rows()`.
- The API checks institution and course roles itself as well (`@hbe/core` permissions), so a
  wrong policy and a wrong check would both have to happen for data to leak.
- Realtime and Storage go through the same policies: browsers join Realtime with the person's
  own token, and run files are fetched through signed URLs created with the person's session.

## Authentication

- Supabase Auth issues sessions; the API verifies every token (`auth.ts`). Admins and the
  platform operator must use two-factor authentication (`aal2`), checked by the database and
  the API. Admins can reset another member's second factor (audited, the person is emailed).
- SAML single sign-on is turned on per institution only after the operator has checked the
  domain. SSO sign-ins can only take up invitations of the institution that owns the domain.
- **Changed:** session cookies are `Secure` whenever the site is served over HTTPS.

## Web app

- **Changed:** a Content-Security-Policy with a new nonce for every response
  (`apps/web/src/lib/csp.ts`, set in the middleware): scripts run only with the nonce
  (`'strict-dynamic'`), the browser talks only to the site and to Supabase (HTTP and Realtime
  WebSocket; images from Storage, for run screenshots), no plugins, no `<base>` changes, and the app can't be framed. Every page is
  rendered per request so its scripts carry the nonce. HSTS, `X-Frame-Options: DENY`,
  `nosniff`, a strict referrer policy and a Permissions-Policy are sent too.
- Markdown (assignment specs, feedback) is rendered with `react-markdown` without raw HTML;
  unsafe link schemes are dropped.
- Files a run produced (from student code) are never served from the app's origin: they are
  redirected to Supabase Storage with a 60-second signed URL, and only PNG images and plain
  text open in the browser; everything else downloads.
- Server actions are protected by Next.js's same-origin check.

## API

- **Changed:** security headers on every response (`apps/server/src/security.ts`): `nosniff`,
  referrer policy, HSTS over HTTPS, `X-Frame-Options: DENY` and `default-src 'none'` for JSON,
  and `Cache-Control: no-store` for `/v1`. Only the LTI pages may be framed (the LMS shows
  them).
- **Changed:** rate limits per process: 600 requests a minute per credential on `/v1`
  (counted per token, because the web app calls the API for everyone from one address, and
  a campus's students often share one), and 600 a minute per address on `/lti`. Over the
  limit: `429` with `Retry-After`. GitHub webhooks are signed and not limited.
- Errors: unexpected errors are logged and answered with a generic `internal_error`; stack
  traces are never sent.
- Request bodies are limited to 1 MB (webhooks have their own limit).

## LMS and other outbound requests

- **Changed:** URLs that come from an LMS or an admin (the Dynamic Registration configuration
  and registration endpoint, JWKS, token, line item and roster URLs) are fetched with
  `outboundFetch` (`packages/lms/src/outbound.ts`): HTTPS only, public internet addresses only
  (no private, loopback, link-local or cloud metadata addresses), checked after DNS
  resolution when connecting (so DNS rebinding doesn't get around it), no redirects, at most
  2 MB and 15 seconds. Local development allows the stand-in LMS on localhost.
- LTI launches: single-use state and nonce, the id_token is verified against the platform's
  JWKS (issuer, audience, expiry), and Dynamic Registration needs an admin's one-time invite.
- Google, GitHub and Supabase are called only at configured URLs.

## GitHub and the grader

- Webhooks are verified with HMAC-SHA256 (timing-safe) over the exact body before anything is
  stored.
- Grader callbacks are authenticated with GitHub Actions OIDC tokens bound to the run (or a
  per-run token, only locally); student code runs in GitHub-hosted runners, never on the
  platform's servers (§6.4 of ARCHITECTURE.md).
- The GitHub App asks only for the permissions listed in GITHUB_APP_SETUP.md, each with what
  it is used for; repository contents are read-only.

## Secrets and logs

- Secrets come from the environment (never the repository); `config:check` validates them,
  and local-only switches (fake GitHub, fake Google, token grader auth) are refused outside
  `HBE_ENV=local`.
- Logs never include the `Authorization` and `Cookie` headers or the webhook signature.
  **Changed:** request logs no longer include one-time codes, invites and tokens from query
  strings (`code`, `state`, `invite`, `registration_token`, `token`, `id_token`, …).

## Dependencies

- **Changed:** `pnpm audit` reports no known vulnerabilities (yaml upgraded, PostCSS
  overridden inside Next.js, Vitest 4). CI fails on any high or critical advisory, and
  Dependabot proposes updates weekly once they are 14 days old (security updates at once).

## Still open

- An external penetration test of tenant isolation, authentication, LTI and the grader paths
  before the pilot.
- Rate limits are counted per process; with several api instances the effective limit is
  that many times higher. A shared store (Postgres or Redis) is needed if that matters.
- Style attributes are allowed by the CSP (`style-src 'unsafe-inline'`); scripts are not.
- Error tracking (Sentry) must be configured to scrub personal data before it is turned on.
