# Run once per AWS account, before the main configuration: the S3 bucket that holds its
# Terraform state (versioned, encrypted, private). Locking uses S3 lock files
# (use_lockfile = true in backend.hcl), so no DynamoDB table is needed.
#
#   cd deploy/aws/terraform/bootstrap
#   terraform init && terraform apply -var state_bucket=hbe-tfstate-<account id>
#
# Its own state stays local (terraform.tfstate here, gitignored): it only describes this bucket.

terraform {
  required_version = ">= 1.16.4, < 2.0.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.66.0"
    }
  }
}

variable "region" {
  type    = string
  default = "ap-southeast-1"
}

variable "state_bucket" {
  description = "Globally unique bucket name, e.g. hbe-tfstate-<account id>."
  type        = string
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "hbe", ManagedBy = "terraform" }
  }
}

resource "aws_s3_bucket" "state" {
  bucket = var.state_bucket
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Old state versions are kept 90 days (to roll back a bad apply), then removed.
resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket     = aws_s3_bucket.state.id
  depends_on = [aws_s3_bucket_versioning.state]
  rule {
    id     = "expire-old-state"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

# Refuse anything but TLS.
resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "TlsOnly"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.state]
}

output "backend_config" {
  description = "Put this in deploy/aws/terraform/backend.hcl (gitignored), then terraform init -backend-config=backend.hcl."
  value       = <<-EOT
    bucket       = "${aws_s3_bucket.state.id}"
    key          = "hbe/prod/terraform.tfstate"
    region       = "${var.region}"
    encrypt      = true
    use_lockfile = true
  EOT
}
