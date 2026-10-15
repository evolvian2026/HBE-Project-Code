# Grader runners (AWS account `hbe-grader`)

Self-hosted GitHub Actions runners for the grader repository (`GRADER_REPO`), so grading runs
in Singapore on the platform's own compute (docs/DEPLOYMENT.md §2.4). Apply this in its **own
AWS account**, separate from the app's: it shares no network, role or secret with the
platform.

```
grader repository ── workflow_job webhook ──▶ Lambda "scaler" (function URL, signature checked)
  (evaluate.yml queued)                         also every minute (EventBridge)
                                                │ for each queued job, up to max_runners:
                                                │   JIT runner config → SSM (SecureString)
                                                ▼   RunInstances (spot, then on-demand)
                       EC2 x86 runner: Docker + Compose + GitHub runner, reads its config once,
                       runs ONE job, shuts down → terminated
```

- **One job per instance**, with a just-in-time runner config (single use, removed from SSM
  as soon as the instance reads it). Instances that never register (10 min), idle without a
  job (15 min) or outlive the longest job are terminated, and their runners removed.
- **Capped**: never more than `max_runners` at once; further jobs wait in GitHub's queue.
  An AWS Budgets alert covers the whole account.
- **Hardened**: no inbound traffic; IMDSv2 with one hop (the containers that build and run
  student code can't reach the instance's credentials); the instance role can only read its
  own runner config (and Session Manager, for debugging); no platform secrets on runners.
  The scaler can start instances only from the runners' launch template and terminate only
  runners.
- **x86 spot** across three availability zones and several instance types, falling back to
  on-demand when spot is short (`on_demand_fallback`). A spot interruption fails that one
  job; re-run it from the platform.

## Setup

1. **State bucket** in this account: apply `../terraform/bootstrap` here
   (`-var state_bucket=hbe-grader-tfstate-<account id>`), and use its `backend_config`
   output as `backend.hcl` in this folder with `key = "hbe-grader/prod/terraform.tfstate"`.
2. **A GitHub App for the runners**, owned by the organization that owns the grader
   repository (Settings → Developer settings → GitHub Apps → New):
   - Repository permissions: **Administration: Read and write** (to register runners),
     **Actions: Read** (to see queued jobs). Nothing else.
   - Webhook: active, URL from step 4 (use a placeholder until then), a long random secret,
     event **Workflow job**.
   - Install it on the grader repository only.
3. **Its settings in SSM** (from your machine, with credentials for this account):

   ```sh
   aws ssm put-parameter --type String       --name /hbe-grader/prod/github-app-id         --value <app id>
   aws ssm put-parameter --type SecureString --name /hbe-grader/prod/github-app-private-key --value "$(cat app.pem)"
   aws ssm put-parameter --type SecureString --name /hbe-grader/prod/webhook-secret        --value <secret>
   ```

4. **Apply**, with `prod.tfvars` (gitignored):

   ```hcl
   grader_repository = "hbe-platform/hbe-grader"
   runner_version    = "2.329.0"   # the latest from github.com/actions/runner/releases
   runner_sha256     = "…"         # actions-runner-linux-x64-<version>.tar.gz, from those notes
   alarm_email       = "ops@example.com"
   max_runners       = 10
   ```

   ```sh
   terraform init -backend-config=backend.hcl
   terraform apply -var-file=prod.tfvars
   ```

   Set the App's webhook URL to the `webhook_url` output, and confirm the alarm email's SNS
   subscription.
5. **Switch the grader over**: in the grader repository, set the Actions variable
   `HBE_RUNNER_LABELS` to the `runner_labels` output (`["self-hosted","hbe-grader"]`). To try
   it first, run one assignment's evaluation and watch the scaler's log group; unsetting the
   variable goes back to GitHub-hosted runners.

## Keeping it current

- **Runner version**: GitHub stops accepting runners some time after a newer release. Update
  `runner_version` and `runner_sha256` and apply; new instances use it.
- **Faster starts**: each instance installs Docker, Compose and the runner at boot (about a
  minute). A pre-baked AMI with those and the stacks' base images cached (`ami_id`) cuts that
  and the image pulls.

## Checks without AWS

`terraform test` (mocked provider) and `node --test lambda/test/*.test.mjs` (the scaler's
decisions, the App's JWT, webhook signatures and the GitHub calls, with fakes); CI runs both.
