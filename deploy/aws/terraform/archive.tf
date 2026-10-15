# The records archive replica (ARCHITECTURE §12.4): S3 in the region, with Object Lock so
# copies can't be changed or deleted before the institution's purge date. The hosts reach it
# with their instance role (ARCHIVE_S3_ACCESS_KEY_ID stays empty).

locals {
  archive_bucket = var.archive_bucket != "" ? var.archive_bucket : "${local.name}-archive-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket" "archive" {
  bucket              = local.archive_bucket
  object_lock_enabled = true
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "archive" {
  bucket = aws_s3_bucket.archive.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "archive" {
  bucket                  = aws_s3_bucket.archive.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "archive" {
  bucket = aws_s3_bucket.archive.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Deleting a versioned object only hides it: the purge's deletes leave earlier versions, which
# this removes once their lock has ended (the lock runs to the purge date).
resource "aws_s3_bucket_lifecycle_configuration" "archive" {
  bucket     = aws_s3_bucket.archive.id
  depends_on = [aws_s3_bucket_versioning.archive]
  rule {
    id     = "remove-deleted-copies"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
    expiration {
      expired_object_delete_marker = true
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}
