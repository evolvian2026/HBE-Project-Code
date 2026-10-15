terraform {
  required_version = ">= 1.16.4, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.66.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "2.7.1"
    }
  }

  # State in the grader account's own bucket (../terraform/bootstrap, applied there).
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "hbe-grader"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
