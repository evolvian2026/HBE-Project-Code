variable "environment" {
  description = "Name of this deployment (prod, staging). Names resources and the SSM path /hbe/<environment>/."
  type        = string
  default     = "prod"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.environment))
    error_message = "Lowercase letters, digits and hyphens."
  }
}

variable "region" {
  description = "AWS region (data residency: Singapore)."
  type        = string
  default     = "ap-southeast-1"
}

variable "stage" {
  description = "a: one host with Caddy (TLS) and an Elastic IP. b: an ALB with ACM certificates, web+api hosts across two availability zones, and a worker host."
  type        = string
  default     = "a"
  validation {
    condition     = contains(["a", "b"], var.stage)
    error_message = "stage is \"a\" or \"b\"."
  }
}

variable "app_host" {
  description = "The web app's hostname (APP_URL), e.g. app.example.com."
  type        = string
}

variable "api_host" {
  description = "The API's hostname (API_URL), e.g. api.example.com."
  type        = string
}

variable "institution_base_domain" {
  description = "INSTITUTION_BASE_DOMAIN, if institutions have subdomains (<slug>.<this>): stage B adds *.<this> to the certificate."
  type        = string
  default     = ""
}

variable "vanity_domains" {
  description = "Stage B: institutions' own domains to serve (each gets an ACM certificate on the ALB; the institution adds its validation record). Stage A needs none: Caddy issues certificates on demand."
  type        = set(string)
  default     = []
}

variable "route53_zone_id" {
  description = "A Route 53 hosted zone for app_host and api_host (and the base domain): records and certificate validation are then managed here. Empty: create them at your DNS provider from the outputs."
  type        = string
  default     = ""
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "app_instance_type" {
  description = "Stage A: the single host. Stage B: each web+api host. Graviton (arm64) types."
  type        = string
  default     = "t4g.medium"
}

variable "worker_instance_type" {
  description = "Stage B: the worker host."
  type        = string
  default     = "t4g.small"
}

variable "app_hosts" {
  description = "Stage B: web+api hosts (min, desired and max of their Auto Scaling group)."
  type        = object({ min = number, desired = number, max = number })
  default     = { min = 2, desired = 2, max = 4 }
  validation {
    condition     = var.app_hosts.min >= 2 && var.app_hosts.min <= var.app_hosts.desired && var.app_hosts.desired <= var.app_hosts.max
    error_message = "At least two hosts (one per availability zone), and min <= desired <= max."
  }
}

variable "image" {
  description = "The first image to run (ECR URI with tag). Deploys change the SSM parameter /hbe/<environment>/image afterwards, not this variable."
  type        = string
  default     = ""
}

variable "acme_email" {
  description = "Stage A: Let's Encrypt account email (Caddy)."
  type        = string
  default     = ""
}

variable "alarm_email" {
  description = "Where alarms are sent (an SNS email subscription to confirm)."
  type        = string
}

variable "waf_enabled" {
  description = "Stage B: AWS WAF on the ALB (managed rule sets and rate limits on /webhooks and /lti)."
  type        = bool
  default     = true
}

variable "archive_bucket" {
  description = "Name of the records archive bucket (created here, with Object Lock). Empty: hbe-<environment>-archive-<account id>."
  type        = string
  default     = ""
}

variable "github_repository" {
  description = "owner/repo whose GitHub Actions may deploy (the Deploy to AWS workflow, via OIDC: no stored AWS keys). Empty: no deploy role."
  type        = string
  default     = ""
}

variable "github_environment" {
  description = "The GitHub Actions environment the deploy job runs in; only that job can take the deploy role."
  type        = string
  default     = "production"
}

variable "github_oidc_provider_arn" {
  description = "The account's GitHub OIDC provider, if it already has one (an account has one per URL). Empty: created here."
  type        = string
  default     = ""
}

variable "log_retention_days" {
  type    = number
  default = 30
}
