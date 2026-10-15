# Settings the hosts read at boot. Secrets are NOT in Terraform: put them under
# /hbe/<environment>/env/ yourself (SecureString), one parameter per variable, e.g.
#   aws ssm put-parameter --type SecureString --name /hbe/prod/env/SUPABASE_SECRET_KEY --value …
# (README.md lists them; the template is config/env/production-aws.env.example).

resource "aws_ssm_parameter" "image" {
  name        = "${local.ssm_path}/image"
  description = "The image every host runs (deploys update it, then run /opt/hbe/deploy.sh)."
  type        = "String"
  value       = var.image != "" ? var.image : "${aws_ecr_repository.app.repository_url}:latest"
  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "hosts" {
  # The keys are known when planning (the ALB's address is not), so optional settings are left
  # out by their variables only: empty means unset.
  for_each = merge(
    {
      APP_HOST = var.app_host
      API_HOST = var.api_host
      APP_URL  = "https://${var.app_host}"
      API_URL  = "https://${var.api_host}"
      # Stage A: Caddy issues certificates on demand. Stage B: the operator adds each domain to
      # vanity_domains (an ACM certificate), then marks it live in the console.
      DOMAIN_PROVISIONER   = local.stage_a ? "caddy" : "manual"
      CUSTOM_DOMAIN_TARGET = local.stage_a ? var.app_host : aws_lb.main[0].dns_name
      ARCHIVE_S3_BUCKET    = aws_s3_bucket.archive.id
      ARCHIVE_S3_REGION    = var.region
      ARCHIVE_OBJECT_LOCK  = "governance"
    },
    { for k, v in {
      INSTITUTION_BASE_DOMAIN = var.institution_base_domain
      ACME_EMAIL              = var.acme_email
    } : k => v if v != "" },
  )
  name  = "${local.ssm_path}/env/${each.key}"
  type  = "String"
  value = each.value
}
