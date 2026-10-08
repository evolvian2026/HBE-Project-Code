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
| `HBE_IMAGE`, `APP_HOST`, `API_HOST`, `ACME_EMAIL` | — | set (used by Compose and Caddy) |
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
