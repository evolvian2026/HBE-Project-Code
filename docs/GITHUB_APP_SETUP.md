# GitHub App setup

The platform uses **one GitHub App per environment** (development, demo, production). Never share
an App between environments: each has its own webhook URL, keys and installations.

This page gives the exact settings for the **development App**. The demo and production Apps use
the same settings with the URLs in [§6](#6-demo-and-production-apps).

> Until the App exists, local development can run with `GITHUB_FAKE=true` (the default in
> `config/env/local.env.example`): repositories are "created" in an in-memory GitHub, so the
> rest of the platform can be tried. Set it to `false` once the App's credentials are in place.

> Set every permission and event now, even though Phase 0 only uses some of them. Each later
> permission change makes every organisation that installed the App approve it again.

---

## 1. Create the App

1. Decide which GitHub organisation owns the App (for example `evolvian2026`). Create the App
   there, not on a personal account, so it survives staff changes.
2. Go to **Organisation → Settings → Developer settings → GitHub Apps → New GitHub App**.
   (Direct link: `https://github.com/organizations/<org>/settings/apps/new`.)
3. Also create one or two free **test organisations** (for example `hbe-dev-alpha` and
   `hbe-dev-beta`). Each stands in for an institution's classroom organisation.

## 2. Registration form

### Basics

| Field | Value |
|-------|-------|
| GitHub App name | `HBE Projects Dev` (must be unique on GitHub; if taken, add a suffix such as `HBE Projects Dev Evolvian`) |
| Description | `Development App for the HBE project evaluation platform.` |
| Homepage URL | `https://github.com/evolvian2026/HBE-Project-Code` |

### Identifying and authorizing users

| Field | Value |
|-------|-------|
| Callback URL 1 | `http://127.0.0.1:54321/auth/v1/callback` |
| Callback URL 2 (click **Add Callback URL**) | `http://localhost:54321/auth/v1/callback` |
| Expire user authorization tokens | ✅ checked |
| Request user authorization (OAuth) during installation | ⬜ **unchecked** (it would disable the Setup URL below) |
| Enable Device Flow | ⬜ unchecked |

These callback URLs belong to the local Supabase Auth server, which handles GitHub sign-in for
the app. The first one is the exact URL the local stack sends.

### Post installation

| Field | Value |
|-------|-------|
| Setup URL | `http://localhost:4000/v1/github/setup` |
| Redirect on update | ✅ checked |

### Webhook

| Field | Value |
|-------|-------|
| Active | ✅ checked |
| Webhook URL | Your forwarding URL + `/webhooks/github`, see [§4](#4-forward-webhooks-to-your-machine) (for example `https://smee.io/AbC123xyz`) |
| Webhook secret | Output of `openssl rand -hex 32` (save it, it goes in `.env.local`) |
| SSL verification | Enable |

### Permissions

**Repository permissions**

| Permission | Access | Used for |
|------------|--------|----------|
| Actions | Read and write | Starting the grading workflow and reading its results |
| Administration | Read and write | Creating student repositories from templates, adding collaborators, branch rules |
| Checks | Read and write | Posting test results as check runs on commits and pull requests |
| Commit statuses | Read-only | Reading CI status on student commits |
| Contents | Read-only | Reading code, commits and pushes |
| Issues | Read and write | Tracking issue activity; posting feedback |
| Metadata | Read-only | Required by GitHub (selected automatically) |
| Pull requests | Read and write | Tracking pull requests; posting review comments |

Leave every other repository permission at **No access**.

**Organisation permissions**

| Permission | Access | Used for |
|------------|--------|----------|
| Members | Read-only | Matching organisation members and teams to course rosters |

**Account permissions**

| Permission | Access | Used for |
|------------|--------|----------|
| Email addresses | Read-only | Lets GitHub sign-in read the user's email (sign-in fails without it) |

### Subscribe to events

These checkboxes appear once the permissions above are set. Tick:

- Check suite
- Create
- Delete
- Issue comment
- Issues
- Pull request
- Pull request review
- Pull request review comment
- Push
- Repository
- Workflow run

Installation events (`installation`, `installation_repositories`) are always delivered; they
have no checkbox.

### Where can this GitHub App be installed?

**Any account.** Every institution installs the App on its own organisation. An installation
that no institution admin requested is stored but stays unlinked (see
[ADR 0013](adr/0013-installation-linking-by-webhook.md)).

Click **Create GitHub App**.

## 3. Collect the credentials

On the App's settings page:

| On GitHub | Where it goes |
|-----------|---------------|
| **App ID** (General → About) | `.env.local`: `GITHUB_APP_ID` |
| **Client ID** | `.env.local`: `GITHUB_APP_CLIENT_ID` · `supabase/.env.local`: `SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID` |
| **Generate a new client secret** | `.env.local`: `GITHUB_APP_CLIENT_SECRET` · `supabase/.env.local`: `SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET` |
| **Generate a private key** (downloads a `.pem`) | `.env.local`: `GITHUB_APP_PRIVATE_KEY_BASE64` = output of `base64 -w0 key.pem` (macOS: `base64 -i key.pem`) |
| The webhook secret you generated | `.env.local`: `GITHUB_WEBHOOK_SECRET` |
| The App's slug: the last part of its public URL `https://github.com/apps/<slug>` | `.env.local`: `GITHUB_APP_SLUG` |

`.env.local` (repo root) is created by `pnpm env:local`. Create `supabase/.env.local` yourself:

```bash
cat > supabase/.env.local <<'EOF'
SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID=<Client ID>
SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET=<client secret>
EOF
```

Both files are git-ignored. Keep the `.pem` in a password manager and delete the downloaded copy.
Anyone with the private key can act as the App on every organisation that installed it.

Then in `supabase/config.toml`, under `[auth.external.github]`, set `enabled = true`, and restart
Supabase so it picks up the change:

```bash
pnpm db:stop && pnpm db:start
```

## 4. Forward webhooks to your machine

GitHub can't reach `localhost`, so a forwarder relays deliveries to
`http://localhost:4000/webhooks/github`.

**Option A: smee.io (stable URL, nothing to install).** Open https://smee.io, click
**Start a new channel**, use the channel URL as the App's Webhook URL, then run:

```bash
npx smee-client --url https://smee.io/<channel> --target http://localhost:4000/webhooks/github
```

smee re-encodes the JSON body. If a delivery is rejected with `invalid_signature`, use option B.

**Option B: a tunnel (exact bytes).** For example `cloudflared tunnel --url http://localhost:4000`
prints an `https://<random>.trycloudflare.com` address. Set the App's Webhook URL to that
address + `/webhooks/github`. The address changes each time you start the tunnel.

## 5. Check that it works

1. `pnpm db:start`, `pnpm dev`, and the forwarder from §4 are running.
2. Open http://localhost:3000 → **Continue with GitHub** → authorise. You land on the dashboard,
   and the header shows your GitHub login.
3. Make yourself super admin (README), then create an institution in **Platform** with the
   **verified email of your GitHub account** as the first admin. Sign out and sign in with GitHub
   again: the invitation is accepted and you land on the institution page as admin.
4. On the institution page, click **Connect organisation**. GitHub opens the install page:
   choose a test organisation (for example `hbe-dev-alpha`) and install.
5. GitHub sends you back to the **GitHub App installed** page. Back on the institution page, the
   organisation is listed as **connected**.
6. On GitHub, App settings → **Advanced → Recent deliveries** shows each webhook. A `202`
   response means the platform accepted it; you can redeliver any delivery from there.

If step 5 shows no organisation: check the delivery in Recent deliveries (a `401` means the
webhook secret doesn't match `GITHUB_WEBHOOK_SECRET`), and check that you connected with the same
GitHub account you signed in with.

## 6. Demo and production Apps

Create a separate App for the demo, named for example `HBE Projects`, with the same permissions,
events and options, and these URLs:

| Field | Value |
|-------|-------|
| Homepage URL | `https://app.example.com` |
| Callback URL | `https://<project-ref>.supabase.co/auth/v1/callback` (or `https://auth.example.com/auth/v1/callback` once the Supabase custom domain is set up) |
| Setup URL | `https://api.example.com/v1/github/setup` |
| Webhook URL | `https://api.example.com/webhooks/github` |

For hosted Supabase, enter the Client ID and secret under **Authentication → Sign In / Providers
→ GitHub** in the Supabase dashboard instead of `supabase/.env.local`. The other values go in
the environment variables listed in [CONFIGURATION.md](CONFIGURATION.md).

**The demo App also becomes the production App.** The move to AWS keeps the same hostnames and
upgrades the same Supabase project in place (CONFIGURATION.md §3.1), so none of these URLs
change and every institution's installation keeps working. Create a separate production App only
if production gets a fresh Supabase project, which changes the callback URL.
