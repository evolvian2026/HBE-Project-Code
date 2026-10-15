terraform {
  required_version = ">= 1.16.4, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.66.0"
    }
  }

  # State in S3 (bucket from bootstrap/), locked with an S3 lock file. Configure with
  # `terraform init -backend-config=backend.hcl` (see README.md).
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "hbe"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
