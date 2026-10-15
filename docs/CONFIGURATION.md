# Configuration

All environment-specific behaviour lives in configuration, not code. Moving from the free-tier
demo to Supabase Pro and AWS EC2 means **editing config values**; no code changes are needed.

## 1. How configuration is layered

```
config/profiles/<free|paid>.yaml      limits & behaviour     (selected by HBE_PLAN_PROFILE)
          ▼ overridden by
HBE__<SECTION>__<KEY> env vars         one-off tweaks per environment
          ▼ combined with
Environment variables                  endpoints & secrets    (templates in config/env/)
          ▼ tightened by
Institution limits (database)          per-tenant quotas; can only be lower than the profile
```

As built, a super admin sets an institution's limits on the platform console (blank means the
plan's value): **active students** (inviting a student past it is refused; pending invitations
count), **test runs at once** (at most `evaluation.institution_concurrency`) and **runner minutes
per month** (at most `evaluation.monthly_runner_minutes_budget`; past it, automatic runs stop,
as for the platform budget). The institution's admins see them on their Settings page.

`packages/settings` loads all of this once at startup, validates it with Zod, and **refuses to
start** if anything is missing or inconsistent. A misconfigured deploy therefore fails its health
check instead of misbehaving later. Every app imports `loadSettings()`; nothing reads
`process.env` directly.

```bash
pnpm config:check path/to/file.env    # validate an env file before deploying
```

## 2. Files

| File | Purpose |
|------|---------|
| `config/profiles/free.yaml` | Free-tier limits: low concurrency, short retention for temporary data, GitHub-hosted runners, `pg_dump` backups, run quotas within the 2,000-minute budget |
| `config/profiles/paid.yaml` | Production limits: self-hosted runners, PITR backups, SAML SSO enabled, larger quotas |
| `config/env/local.env.example` | Local development: `pnpm env:local` turns it into `.env.local` with the local stack's keys |
| `config/env/demo-render.env.example` | Free-tier demo on Render + Supabase Free |
| `config/env/production-aws.env.example` | EC2 + Supabase Pro. Lines that differ from the demo are commented `CHANGED` |
| `Dockerfile` | One image for every role; `WEB_DIR` and `HBE_CONFIG_DIR` are set inside it |
| `render.yaml` | Render Blueprint for the demo (one free Docker service, Singapore) |
| `deploy/aws/docker-compose.prod.yml` | EC2 stage A: the same image as `web` / `api` / `worker` containers, plus Caddy |
| `deploy/aws/Caddyfile` | TLS and routing for the same `app.` / `api.` hostnames |
| `supabase/snippets/demo-keep-awake.sql` / `remove-keep-awake.sql` | Demo-only keep-awake job, and how to remove it |
| `grader/.github/workflows/evaluate.yml` | Grader workflow; runner type comes from the `HBE_RUNNER_LABELS` repo variable |
| `packages/settings/` | Typed loader and validator, with tests that prove the demo → AWS switch |

Real `.env` files and keys are git-ignored. Only `*.env.example` templates are committed.

## 3. Migration recipes

### 3.1 Supabase Free → Pro (same project)

| Change | Where |
|--------|-------|
| Upgrade the plan; enable the PITR add-on | Supabase dashboard |
| `HBE_PLAN_PROFILE=paid` | env (switches backups to `supabase_pitr`, enables SAML, raises limits) |
| Disable the nightly `pg_dump` workflow, or keep it weekly | GitHub Actions workflow toggle |

Supabase URLs, keys and connection strings **don't change**. If you use a **new** Pro project
instead, also replace `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`,
`DATABASE_URL` and `QUEUE_DATABASE_URL`, then re-apply the auth settings in the dashboard.

### 3.2 Render → AWS EC2

| Change | From (demo) | To (production) |
|--------|-------------|-----------------|
| `HBE_ENV` | `demo` | `production` |
| `HBE_PLAN_PROFILE` | `free` | `paid` |
| `ROLES` | `web,api,worker` (one process) | per container in `docker-compose.prod.yml` |
| `ARCHIVE_S3_ENDPOINT` | `https://<acct>.r2.cloudflarestorage.com` | *(empty = AWS S3)* |
| `ARCHIVE_S3_REGION` | `auto` | `ap-southeast-1` |
| `ARCHIVE_S3_BUCKET` | `hbe-archive` | `hbe-prod-archive-sg` |
| `ARCHIVE_S3_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | R2 keys | *(empty = EC2 instance role)* |
| `ARCHIVE_OBJECT_LOCK` | `none` | `governance` |

The archive bucket receives a nightly copy of every record file (grade reports, source snapshots,
graded runs' artifacts) and holds full exports. With `ARCHIVE_OBJECT_LOCK=governance` the bucket
must have Object Lock enabled; objects are locked until the institution's purge date, and the
purge bypasses governance retention (the IAM role needs `s3:BypassGovernanceRetention`). Leave
`ARCHIVE_S3_BUCKET` empty locally: nothing is replicated and exports go to Storage.
| `HBE_IMAGE`, `APP_HOST`, `API_HOST`, `ACME_EMAIL` | — | set by Terraform and the deploy workflow (used by Compose and Caddy) |
| DNS for `app.` / `api.` | CNAME → Render | A → Elastic IP (or ALIAS → ALB) |
| Keep-awake job | installed | run `remove-keep-awake.sql` |

**Must stay the same:** `APP_URL`, `API_URL`, the GitHub App credentials, `LTI_PRIVATE_KEY_BASE64`
and `LTI_KEY_ID`, the Google OAuth client, and above all `TOKEN_ENCRYPTION_KEY`. If that key
changes, stored LMS tokens can no longer be decrypted.

### 3.3 GitHub-hosted → EC2 self-hosted runners

| Change | Where |
|--------|-------|
| `HBE_RUNNER_LABELS=["self-hosted","hbe-grader"]` | grader repo → Actions variables |
| `HBE__EVALUATION__RUNNER=self_hosted` (already the `paid` default) | env |
| Keep `evaluation.global_concurrency` ≤ the runner module's max instances | profile or override |

To roll back, unset the variable. Runs then go back to `ubuntu-latest`.

### 3.4 Email: Resend → Amazon SES (optional)

`EMAIL_PROVIDER=ses`, `AWS_SES_REGION=ap-southeast-1`. Credentials come from the instance role.
Supabase Auth's SMTP settings change separately, in its dashboard.

The providers are `resend` (HTTP API; the demo default, since Render free blocks outbound SMTP),
`ses`, `smtp` (`SMTP_URL`, e.g. `smtp://127.0.0.1:54325` for the local Mailpit, or
`smtps://user:pass@host:465` for a relay) and `log` (logs instead of sending). Every email goes
through the `email_outbox` table, which the worker drains every minute (and right after a
notification), retrying up to five times. Users choose which notifications they also get by
email at `/account/notifications`.

## 4. Tuning without a redeploy of code

Any profile value can be overridden per environment, for example:

```bash
HBE__EVALUATION__RUNS_PER_STUDENT_PER_DAY=8
HBE__RETENTION__NONFINAL_ARTIFACT_DAYS=30
HBE__RUNTIME__QUEUE_CONCURRENCY=3
```

Overrides are type-checked. An unknown key (a typo) or a wrong type stops startup with a clear
message.

## 5. GitHub settings

| Variable | Default | Notes |
|----------|---------|-------|
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_BASE64`, `GITHUB_APP_SLUG`, `GITHUB_WEBHOOK_SECRET` | — | From the GitHub App (docs/GITHUB_APP_SETUP.md) |
| `GITHUB_API_URL` | `https://api.github.com` | Change only for GitHub Enterprise Server |
| `GITHUB_FAKE` | `false` | `true` uses an in-memory GitHub so repository creation can be tried without an App. **Refused unless `HBE_ENV=local`.** |
| `GRADER_REPO` | — | `owner/name` of the private grader repository (its `evaluate.yml` workflow is dispatched for every test run) |
| `GRADER_WORKFLOW`, `GRADER_REF` | `evaluate.yml`, `main` | The workflow file and branch; OIDC tokens must come from exactly this workflow on this branch |
| `GRADER_CALLBACK_AUTH` | `oidc` | How the grader authenticates its callbacks. `oidc`: GitHub Actions OIDC tokens (no shared secrets). `token`: a random per-run token, so the harness can be run by hand. **`token` is refused unless `HBE_ENV=local`.** |

Evaluation limits (runs per day, concurrency, the monthly Actions-minutes budget, push debounce,
job timeout) are in the `evaluation` section of the plan profile.

### 5.1 LMS (LTI 1.3) keys

| Variable | Default | Notes |
|----------|---------|-------|
| `LTI_PRIVATE_KEY_BASE64`, `LTI_KEY_ID` | — | The tool's RSA signing key (PKCS#8 PEM, base64-encoded) and the key ID published with it at `/.well-known/jwks.json`. Locally a temporary key is generated at startup. |
| `LTI_PREVIOUS_PRIVATE_KEY_BASE64`, `LTI_PREVIOUS_KEY_ID` | — | Only during a key rollover: the old key stays in the JWKS (never used to sign) until the LMSs have fetched the new one. |

Generate a key on your own machine and paste it into the hosting dashboard (never into a chat or
a commit):

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out lti.pem
base64 -w0 lti.pem    # macOS: base64 -i lti.pem
```

Use a dated key ID (`lti-2026-01`). To rotate yearly: set the current key as the previous one,
put a new key and ID in place, and remove the previous key a week later. LMS connections
themselves are made per institution on the **LMS** page (one-time Dynamic Registration URL, or
the platform's details entered by hand); the tool's URLs are shown there.

### 5.2 Google Classroom

| Variable | Default | Notes |
|----------|---------|-------|
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | — | The platform's OAuth client. Without them, institutions can't turn Google Classroom on. |
| `TOKEN_ENCRYPTION_KEY` | — | Encrypts teachers' Google refresh tokens. Outside local development it must be 32 random bytes, base64 (`openssl rand -base64 32`). Keep it forever: a new key makes stored tokens unreadable, and every teacher must connect Google again. |
| `GOOGLE_FAKE_URL` | — | A stand-in Google for tests (`packages/lms/src/google-testing.ts`). **Refused unless `HBE_ENV=local`.** |

Setting up the OAuth client, once for the platform (Google Cloud console, a project owned by
the platform team):

1. **APIs & Services → Library:** enable the *Google Classroom API*.
2. **OAuth consent screen:** user type *External*, app name *HBE Projects*, your support
   email and domain, and these scopes: `openid`, `email`, `classroom.courses.readonly`,
   `classroom.rosters.readonly`, `classroom.profile.emails`, `classroom.coursework.students`.
   Classroom scopes are sensitive, so Google reviews the app before people outside your test
   users can consent; plan a few weeks for verification before the first school uses it.
3. **Credentials → Create OAuth client ID:** type *Web application*, authorised redirect URI
   `https://<API_URL host>/v1/oauth/google/callback` (add the local one,
   `http://localhost:4000/v1/oauth/google/callback`, to a separate development client).
4. Put the client ID and secret in the hosting dashboard (never in a chat or a commit).

Each school's Google Workspace admin may need to allow the app (Admin console → Security →
API controls → App access control) before its teachers can connect.

### 5.3 Single sign-on (SAML)

Single sign-on runs through Supabase Auth's SAML 2.0 support, which needs **Supabase Pro**. It
is on in the `paid` profile (`features.saml_sso`) and off in `free`; `HBE__FEATURES__SAML_SSO`
overrides it.

1. In the Supabase dashboard (the platform's project): **Authentication → Sign In / Providers →
   SAML 2.0**, turn it on. Nothing else is configured there: the platform registers each
   institution's identity provider through Supabase's admin API with `SUPABASE_SECRET_KEY`.
2. An institution's admin asks for it on their Settings page (the IdP's metadata URL or file,
   their email domains, and whether people who sign in join as students) and gives their IdP
   the service-provider details shown there: entity ID / metadata
   `https://<project>.supabase.co/auth/v1/sso/saml/metadata` and reply URL `…/sso/saml/acs`.
3. The platform operator checks that the institution owns the domains (for example a letter
   from its IT office, or a DNS TXT record it adds), then turns it on from the console.
   An IdP can assert any address in its domains, so this check matters; public email domains
   (gmail.com and the like) are refused.

People who already signed in with GitHub or an email link keep that account; an SSO sign-in
with the same address is a separate account. Someone signed in through an institution's IdP
only accepts that institution's invitations.

**Local development and CI:** the Supabase CLI can't turn SAML on, so `bash scripts/local-saml.sh`
(after `pnpm db:start`) re-creates the local Auth container with SAML on. The E2E tests sign in
through a stand-in IdP (`e2e/tests/fake-idp.ts`).

### 5.4 Institution addresses (subdomains and vanity domains)

- `INSTITUTION_BASE_DOMAIN` (e.g. `hbe.example.com`): institutions answer at
  `<slug>.hbe.example.com`. Needs a wildcard DNS record (`*.hbe.example.com` CNAME to the
  app's host) and a wildcard certificate; on Render, add `*.hbe.example.com` as a custom domain
  of the web service (Render issues the certificate). Some names are never institutions' (www,
  app, api, admin, platform, …). Set it on the web and api roles. Locally it is `localhost`:
  browsers resolve `<slug>.localhost` to your machine (use the single-process server,
  `ROLES=web,api,…`, to try it).
- `CUSTOM_DOMAIN_TARGET`: the hostname institutions point their vanity domain's CNAME at
  (shown in their instructions; default: APP_URL's host).
- `DOMAIN_PROVISIONER`: `manual` (default; the operator adds each verified domain to the
  hosting and marks it live in the console), `render` (with `RENDER_API_KEY` and
  `RENDER_SERVICE_ID`, the platform adds it through Render's API and Render issues the
  certificate) or `caddy` (AWS stage A: the domain is live once its TXT record is found, and
  Caddy gets its certificate on the first visit, after checking with
  `GET /v1/hosts/tls-check` that it is an institution's address). Terraform sets it on AWS:
  `caddy` in stage A, `manual` in stage B (an ACM certificate per domain,
  `deploy/aws/terraform/README.md`).

## 6. Platform settings in the database

A few switches must be enforced by the database itself, so they live in the
`platform_settings` table rather than in env vars. Super admins can change them; every change
is audited.

| Key | Default | Effect |
|-----|---------|--------|
| `require_admin_mfa` | `true` | Admin powers (RLS and API) need a session that passed two-factor authentication. Only set to `false` for local experiments. |

## 7. Adding a new setting

1. Add the key to **both** `free.yaml` and `paid.yaml` (a test fails if they diverge).
2. Add it to `profileSchema` in `packages/settings/src/profile.ts`.
3. For a new secret or endpoint, add it to `envSchema` (and to a role rule in `env.ts` if it's
   required), and to all three `config/env/*.env.example` files and `render.yaml`.
