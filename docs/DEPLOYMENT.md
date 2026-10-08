# Deployment

The plan has two stages:

1. **Demo**: everything runs on **free tiers** (Render, Supabase, GitHub, Cloudflare R2, Resend).
2. **Production**: the app moves to **AWS EC2 in ap-southeast-1 (Singapore)**, Supabase is
   upgraded to Pro, and grading moves to self-hosted runners on EC2. **The platform pays for
   all evaluation compute.**

All data is hosted in **Singapore**: Supabase `ap-southeast-1`, Render `singapore`, AWS
`ap-southeast-1`.

> Free-tier limits change often. The numbers below were correct when this was written; check
> the providers' pricing pages before relying on them.

---

## 1. Demo on free tiers

### 1.1 Topology

```
                 app.example.com ─┐
                 api.example.com ─┤ CNAME
                                  ▼
          ┌──────────────────────────────────────────┐
          │ Render FREE web service "hbe-app"         │
          │ region: singapore · runtime: docker       │
          │ ROLES=web,api,worker  (one process)       │
          └───────────────┬──────────────────────────┘
                          │ Supavisor pooler (session mode, IPv4)
          ┌───────────────▼──────────────────────────┐
          │ Supabase FREE project, Singapore          │
          │ Postgres (+ pg-boss, pg_cron, pg_net)     │
          │ Auth · Storage · Realtime                 │
          └──────────────────────────────────────────┘
 GitHub free org: classroom repos + private grader repo (hosted runners, 2,000 min/month)
 Cloudflare R2 free: archive replica + nightly pg_dump backups
 Resend free: email (HTTP API)
```

Both hostnames point at the same Render service. The `api` role only answers on
`api.example.com`, and the `web` role on `app.example.com` (routing by `Host` header). That
keeps the external URLs identical to production.

### 1.2 Free-tier constraints and how the design handles them

| Constraint | Impact | Handling |
|------------|--------|----------|
| **Render free has no background workers, cron jobs or Key Value** | No separate worker/cron/Redis | All roles in one process (`ROLES=web,api,worker`); queue and schedules are pg-boss in Postgres. |
| **Render free spins down after about 15 min with no inbound traffic** (cold start of up to a minute) | GitHub webhooks time out after 10 s; schedules stop while asleep | Supabase **pg_cron + pg_net** call `https://api.example.com/healthz` every 10 minutes, so the service stays awake. The webhook redelivery job catches anything missed during a restart or deploy. |
| **750 free instance hours per workspace per month** | One always-on service uses about 730 h | Run exactly **one** free service. Use a separate Render workspace (or local) for staging. |
| **512 MB RAM, 0.1 CPU** | Heavy work could cause out-of-memory crashes | Snapshots happen in the grader, not the app; PDFs use pure-JS `@react-pdf/renderer`; pg-boss concurrency = 2; Next.js `output: standalone`. |
| **Render free blocks outbound SMTP** | Can't send email over SMTP from the app | Send email through the **Resend HTTP API**. Supabase Auth uses Resend SMTP from Supabase's side, which isn't affected. |
| **Supabase free: 500 MB DB, 1 GB Storage, 50 MB max upload** | Records and artifacts outgrow it quickly | Demo retention overrides (`DEMO_MODE=true`): raw webhook payloads 7 days, non-final run artifacts 14 days, pg-boss archive 1 day, Playwright traces only on failure. Show storage usage in the super admin console. |
| **Supabase free pauses after 7 days of inactivity** | Demo goes dark | The always-awake app polls pg-boss continuously, which counts as activity. Still worth checking before each demo. |
| **Supabase free has no backups/PITR, no SAML SSO, no custom auth domain** | Data loss risk; SSO can't be demoed | A nightly GitHub Actions workflow runs `pg_dump` and uploads it to R2 (keeping 14 days). SAML is demoed only after the Pro upgrade; use Google/Microsoft OAuth for the demo. |
| **GitHub free org: 2,000 Actions minutes/month for private repos** | About 300 evaluation runs/month at roughly 6 min each | Demo quotas: 5 manual runs/student/day, push debounce, and a global monthly budget enforced by the worker. Apply for GitHub Education benefits. |
| **Render free build minutes are limited** | Frequent deploys can run out | Turborepo build filters; deploy only on merge to `main`. |

**Demo capacity:** comfortably one or two institutions, about 30 students, and a handful of
assignments. That's enough to show the full flow, including LMS grade passback.

### 1.3 Demo setup checklist

1. **Domain**: point `app.example.com` and `api.example.com` (CNAME) at the Render service,
   and add both as custom domains in Render. Render issues TLS certificates automatically.
2. **Supabase (Singapore)**:
   - Enable GitHub and Google auth providers and set the Custom Access Token Hook.
   - Set Site URL `https://app.example.com` and redirect URLs `https://app.example.com/**`.
   - Use Resend for custom SMTP.
   - Enable the `pg_cron` and `pg_net` extensions and add the keep-awake job.
   - Create the Storage buckets.
3. **GitHub**:
   - Create a demo org with a private `hbe-grader` repo.
   - Create the GitHub App, with webhook `https://api.example.com/webhooks/github`, and
     install it on the demo org.
   - Store the grader's App credentials as Actions secrets in `hbe-grader`.
4. **Render**:
   - Create a Blueprint from `render.yaml` (one free Docker web service, region `singapore`,
     health check `/healthz`).
   - Add env vars: Supabase URL and keys, `DATABASE_URL` (pooler, session mode),
     GitHub App ID/key/secret, Resend key, R2 keys, `ROLES=web,api,worker`, `DEMO_MODE=true`.
5. **Cloudflare R2**: create an `hbe-archive` bucket for replicas and database dumps.
6. **LMS sandboxes**:
   - Moodle: run it in Docker locally, or use a MoodleCloud trial.
   - Canvas: use a sandbox from a pilot institution or a local open-source Canvas.
   - Google Classroom: use a Google Workspace for Education test domain.
7. **Monitoring**: Sentry free plan, plus an external uptime check (e.g. UptimeRobot free) on
   `/healthz`.

```yaml
# render.yaml (demo)
services:
  - type: web
    name: hbe-app
    runtime: docker
    plan: free
    region: singapore
    dockerfilePath: ./Dockerfile
    healthCheckPath: /healthz
    domains: [app.example.com, api.example.com]
    envVars:
      - key: ROLES
        value: web,api,worker
      - key: DEMO_MODE
        value: "true"
      - key: TZ
        value: Asia/Singapore
      - key: DATABASE_URL
        sync: false
      - key: SUPABASE_URL
        sync: false
      - key: SUPABASE_SERVICE_ROLE_KEY
        sync: false
      - key: GITHUB_APP_ID
        sync: false
      - key: GITHUB_APP_PRIVATE_KEY
        sync: false
      - key: GITHUB_WEBHOOK_SECRET
        sync: false
      - key: RESEND_API_KEY
        sync: false
```

```sql
-- Keep the free Render service awake (runs inside Supabase)
select cron.schedule('keep-awake', '*/10 * * * *',
  $$ select net.http_get('https://api.example.com/healthz') $$);
```

---

## 2. Production on AWS EC2 (ap-southeast-1)

### 2.1 What changes and what doesn't

| Piece | Demo | Production |
|-------|------|------------|
| App code and Docker image | same | same (multi-arch image, `linux/amd64` + `linux/arm64`) |
| Hostnames | `app.` / `api.` | same, so the GitHub App, LTI, OAuth and Supabase config don't change |
| App host | Render free, one process | EC2, separate `web` / `api` / `worker` containers |
| Supabase | Free | **Pro, upgraded in place** (same project, same data, no migration) |
| Queue / schedules | pg-boss | pg-boss |
| Grader runners | GitHub-hosted | **Ephemeral self-hosted EC2 runners** (separate AWS account) |
| Archive replica / DB dumps | Cloudflare R2 | **S3 ap-southeast-1**, Object Lock (governance) |
| Email | Resend | Resend (or SES ap-southeast-1) |
| Retention | demo overrides | real policy: contract + 2 years (ARCHITECTURE §12) |

> Supabase stays a managed service. Self-hosting Supabase on EC2 is possible, but you would
> lose managed backups and PITR and take on database operations, which isn't worth it at this scale.

### 2.2 App stage A: single host (first production step)

```
Route 53 / existing DNS ──▶ Elastic IP ──▶ EC2 t4g.medium (Graviton, 2 vCPU / 4 GB)
                                            Auto Scaling group min=max=1 (self-healing)
                                            Docker Compose:
                                              caddy   (TLS via Let's Encrypt, :80/:443)
                                              web     (ROLES=web)
                                              api     (ROLES=api)
                                              worker  (ROLES=worker, concurrency 5)
```

- **Network**: the security group allows only 80/443 inbound. There is **no SSH**; admin access
  is through **SSM Session Manager**. IMDSv2 is required.
- **Secrets**: SSM Parameter Store (SecureString), fetched at boot by user-data and written to
  the Compose env file (readable by root only).
- **Images**: GitHub Actions builds the images and pushes them to **ECR**. Deploys run
  `docker compose pull && docker compose up -d` via **SSM Run Command**, with each container
  checked against `/healthz`.
- **Logs and metrics**: CloudWatch agent (container logs, memory and disk) and Sentry. CloudWatch
  alarms notify SNS → email/Slack.
- **Infrastructure as code**: Terraform in `deploy/aws/`, with state in S3 and locking in DynamoDB.

This is enough for about 100 concurrent students. Because the host is stateless, if it fails
the Auto Scaling group replaces it in a few minutes.

### 2.3 App stage B: high availability (when uptime requirements grow)

- An **ALB** with an **ACM** certificate replaces Caddy. An Auto Scaling group of 2+ instances
  across two availability zones runs `web` + `api`, and a separate small group runs `worker`.
  pg-boss safely handles several workers, and its schedules run only once even with many workers.
- Optionally move to **ECS on EC2** (same images) for rolling deploys.
- AWS WAF on the ALB with managed rule sets, plus rate limiting on `/webhooks` and `/lti`.

### 2.4 Grader runners on EC2 (platform-paid compute)

```
GitHub (grader repo) ── workflow_job webhook ──▶ API Gateway + Lambda (scale-up)
                                                   │ launches
                                                   ▼
                      AWS account "hbe-grader" (separate from the app account)
                      VPC, public subnets, egress only, no peering to the app
                      EC2 spot (x86, e.g. c6i.large / m6i.large), one job per instance,
                      ephemeral runner registers → runs evaluate.yml → terminates
```

- Built with the open-source **`terraform-aws-github-runner`** module, which scales to zero
  when idle. Set a **max-instances cap** (e.g. 10) to put a hard ceiling on cost.
- **Pre-baked AMI** with Docker, Compose, Playwright browsers and cached base images for every
  stack profile, so runs start fast.
- **x86 runners**, not ARM, because many student stacks and base images only ship amd64.
- **Hardening**: the instance role has only SSM and CloudWatch permissions; IMDS hop limit 1 so
  containers can't reach instance credentials; no platform secrets on the runner; one job per
  instance, which is destroyed afterwards.
- The workflow switches `runs-on: ubuntu-latest` to `runs-on: [self-hosted, hbe-grader]`. GitHub
  OIDC results authentication still works unchanged.
- **Cost control**: per-institution run quotas (already enforced), spot instances, an AWS
  Budgets alert on the grader account, and a monthly usage report per institution in the super
  admin console.

### 2.5 Supabase Pro (Singapore)

- Upgrade the **same** project in place: daily backups, the PITR add-on, no pausing, SAML SSO
  for institutions, and an optional `auth.example.com` custom domain.
- Size the compute add-on for the worker's connection count. Keep pg-boss on the session pooler
  and app queries on the transaction pooler.

---

## 3. Migration runbook: Render free → AWS EC2

Because hostnames, the image and the database stay the same, this is a **DNS cutover**, not a
data migration.

1. **Prepare (about a week before)**
   - Set up an AWS Organization with accounts `hbe-prod` and `hbe-grader`; Terraform state
     bucket; ECR repositories.
   - Upgrade Supabase to **Pro** and enable PITR. Turn `DEMO_MODE` off in config so the real
     retention policy applies.
   - Run `terraform apply` for stage A and the S3 archive bucket.
   - Copy R2 objects to S3 with `rclone sync`. Switch the replication job to S3.
2. **Parallel run (1–2 days before)**
   - Deploy the image to EC2 and expose it temporarily as `app-aws.example.com` /
     `api-aws.example.com` for smoke tests: login, a dashboard, a manual evaluation run on a
     test repo.
   - Lower the DNS TTL for `app.` and `api.` to 60 s.
3. **Cutover (low-traffic window, avoiding deadlines)**
   - On Render, set `ROLES=web,api` so only EC2 runs the worker.
   - Repoint the `app.` and `api.` DNS records to the EC2 Elastic IP (or the ALB alias). Caddy
     or ACM issues certificates.
   - Check webhook deliveries (GitHub App → Advanced), and that LTI launches and Google OAuth
     work. These need no config changes because the hostnames are unchanged.
4. **Watch for 48 hours**, keeping Render as an instant rollback (DNS back). Then delete the
   Render service and the keep-awake `pg_cron` job.
5. **Runners (independent step)**: deploy the runner stack, test with one assignment by
   setting `runs-on` per suite, then switch all suites.

---

## 4. Environment matrix

| Env | App host | Supabase | GitHub | Purpose |
|-----|----------|----------|--------|---------|
| local | `pnpm dev` (all roles) | `supabase start` (Docker) | dev App + test org, webhooks through `smee.io` | Development |
| demo | Render free (Singapore) | Free project (Singapore) | demo App + demo org | Demos and pilot |
| production | EC2 ap-southeast-1 | Pro project (Singapore, the upgraded demo project or a fresh one) | prod App + classroom orgs | Live institutions |

If the demo data shouldn't carry over into production, create a fresh Pro project instead of
upgrading. In that case the migration also means re-pointing env vars and re-registering
Supabase auth settings, but the hostnames still stay the same.
