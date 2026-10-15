variable "environment" {
  description = "Name of this runner deployment (prod). Names resources, the SSM path /hbe-grader/<environment>/ and the runners."
  type        = string
  default     = "prod"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.environment))
    error_message = "Lowercase letters, digits and hyphens."
  }
}

variable "region" {
  type    = string
  default = "ap-southeast-1"
}

variable "grader_repository" {
  description = "owner/repo of the grader repository (GRADER_REPO): the only repository the runners serve."
  type        = string
  validation {
    condition     = can(regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", var.grader_repository))
    error_message = "owner/repo"
  }
}

variable "runner_labels" {
  description = "The runners' own labels. The grader repository's HBE_RUNNER_LABELS is [\"self-hosted\", these…]."
  type        = list(string)
  default     = ["hbe-grader"]
}

variable "max_runners" {
  description = "The most runners at once: the ceiling on cost. Jobs beyond it wait in GitHub's queue."
  type        = number
  default     = 10
  validation {
    condition     = var.max_runners >= 1 && var.max_runners <= 100
    error_message = "Between 1 and 100."
  }
}

variable "instance_types" {
  description = "x86 instance types to try, in order (spot first, then on-demand if allowed). Many stacks' images are amd64 only."
  type        = list(string)
  default     = ["c6i.large", "c7i.large", "m6i.large", "c5.large"]
}

variable "on_demand_fallback" {
  description = "Start an on-demand instance when no spot capacity is left for any type."
  type        = bool
  default     = true
}

variable "volume_size" {
  description = "Root disk (GiB): images, builds and the browser tester."
  type        = number
  default     = 60
}

variable "ami_id" {
  description = "A pre-baked runner AMI (Docker, Compose, the runner, cached base images). Empty: the latest Amazon Linux 2023 (x86_64), set up at boot."
  type        = string
  default     = ""
}

variable "runner_version" {
  description = "GitHub Actions runner version, e.g. 2.329.0 (github.com/actions/runner/releases). Keep it recent: GitHub refuses runners that are too old."
  type        = string
  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.runner_version))
    error_message = "A version such as 2.329.0."
  }
}

variable "runner_sha256" {
  description = "SHA-256 of actions-runner-linux-x64-<version>.tar.gz, from that release's notes."
  type        = string
  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.runner_sha256))
    error_message = "64 lowercase hex characters."
  }
}

variable "compose_version" {
  description = "Docker Compose plugin installed on the runners."
  type        = string
  default     = "2.29.7"
}

variable "max_job_minutes" {
  description = "The longest a grading job can take (the grader's job timeout). Runners older than this plus 15 minutes are terminated."
  type        = number
  default     = 60
}

variable "monthly_budget_usd" {
  description = "AWS Budgets alert for the whole grader account (80% spent, 100% forecast)."
  type        = number
  default     = 200
}

variable "alarm_email" {
  description = "Budget alerts and scaler errors."
  type        = string
}

variable "vpc_cidr" {
  type    = string
  default = "10.50.0.0/16"
}

variable "log_retention_days" {
  type    = number
  default = 30
}
