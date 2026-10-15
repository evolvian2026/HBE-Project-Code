# AWS infrastructure (Terraform)

The production hosting in `ap-southeast-1` (docs/DEPLOYMENT.md §2): the same image as the
Render demo, on EC2 Graviton hosts that run it with Docker Compose. One configuration, two
stages:

| | Stage A (`stage = "a"`, start here) | Stage B (`stage = "b"`, high availability) |
|---|---|---|
| Hosts | one, in an Auto Scaling group of one (replaced if it fails) | web+api hosts across two availability zones (2–4), and a worker host |
| TLS | Caddy, Let's Encrypt; institutions' domains get certificates on demand | ALB with ACM certificates (TLS 1.3 policy) |
| Address | Elastic IP | ALB DNS name |
| Institutions' vanity domains | live once their TXT record is found (`DOMAIN_PROVISIONER=caddy`) | add each to `vanity_domains` (an ACM certificate), then mark it live in the console (`manual`) |
| WAF | — | AWS managed rules; rate limits on `/webhooks` and `/lti` |

Both stages: a VPC with two public subnets (hosts accept only HTTP(S) from the internet in
stage A, only the ALB in stage B; no SSH, admin access through SSM Session Manager), IMDSv2,
encrypted disks, ECR (immutable tags, scanned), the records archive bucket (S3 Object Lock),
settings in SSM Parameter Store, container logs in CloudWatch, and alarms (CPU, failed status
checks, ALB 5xx and latency, unhealthy hosts) to an email address.

Going from A to B is `stage = "b"` and `terraform apply`: the hosts are replaced, so do it in
a quiet hour, and repoint DNS from the Elastic IP to the ALB (the Route 53 records change
themselves when `route53_zone_id` is set).

## Once per account: the state bucket

```sh
cd deploy/aws/terraform/bootstrap
terraform init
terraform apply -var state_bucket=hbe-tfstate-<account id>
terraform output -raw backend_config > ../backend.hcl   # gitignored
```

State is locked with an S3 lock file (`use_lockfile = true`); no DynamoDB table is needed.

## Apply

Create `prod.tfvars` (gitignored) next to this file:

```hcl
environment             = "prod"
stage                   = "a"
app_host                = "app.example.com"
api_host                = "api.example.com"
institution_base_domain = "hbe.example.com" # optional: institutions' subdomains
route53_zone_id         = "Z0123…"          # optional: DNS and certificate validation here
alarm_email             = "ops@example.com"
acme_email              = "ops@example.com" # stage A
github_repository       = "owner/repo"      # optional: the Deploy to AWS workflow
```

```sh
cd deploy/aws/terraform
terraform init -backend-config=backend.hcl
# The image repository and the deploy role first, so the hosts have an image when they boot:
terraform apply -var-file=prod.tfvars -target=aws_ecr_repository.app -target=aws_iam_role_policy.deploy
```

Then:

1. **Settings and secrets.** Fill a copy of `config/env/production-aws.env.example` outside the
   repository and load it into SSM (SecureString, one parameter per setting under
   `/hbe/<environment>/env/`): `deploy/aws/put-env.sh prod ~/hbe/production.env`. The
   hostnames, URLs, domain settings and archive bucket are set by Terraform; the script
   skips them. Check the file first with `pnpm config:check`.
2. **The image.** Set up the GitHub environment the deploy workflow uses
   (`.github/workflows/deploy-aws.yml` lists its variables; `terraform output` gives them) and
   run **Deploy to AWS** once: it pushes the image and records it as `/hbe/<environment>/image`.
3. **Everything else:** `terraform apply -var-file=prod.tfvars`. The hosts boot, read their
   settings and the image from SSM, and start. Confirm the alarm email's SNS subscription.
4. **DNS** (without `route53_zone_id`): point `app_host`, `api_host` and
   `*.institution_base_domain` at `public_ip` (stage A, A records) or `load_balancer_dns_name`
   (stage B, CNAME or alias). Stage B without a zone: also add `certificate_validation_records`.

## Deploys

Run **Deploy to AWS** (GitHub Actions, manual): it builds the arm64 image, pushes it to ECR,
sets `/hbe/<environment>/image`, and runs `/opt/hbe/deploy.sh` on the web+api hosts one at a
time (each waits for its containers' health checks; in stage B the ALB keeps serving from the
others), then on the worker host. `deploy.sh` also re-reads the settings, so after changing a
setting in SSM, run the workflow again (or `deploy.sh` with SSM Run Command).

To roll back, set `/hbe/<environment>/image` to the previous tag and run `deploy.sh` on the
hosts (SSM Run Command, document `AWS-RunShellScript`, target tag `HbeGroup`).

## Stage B: institutions' own domains

Add the domain to `vanity_domains` and apply. The institution adds the records in
`vanity_domain_validation_records` and a CNAME to the ALB (the console shows the ALB as the
target); once ACM issues the certificate it is on the ALB, and the operator marks the domain
live under Platform → Domains. Subdomains of `institution_base_domain` need nothing: the main
certificate covers `*.<base domain>`.

## Checks without AWS

`terraform test` plans both stages against a mocked AWS provider (no credentials or network
beyond the provider download) and checks what each builds; CI runs it with `fmt` and
`validate`.

## Not here

- Supabase (Pro, managed in Singapore) and the grader runners (a separate `hbe-grader`
  account, docs/DEPLOYMENT.md §2.4).
- Secrets: never in Terraform or its state; only in SSM, set by `put-env.sh`.
