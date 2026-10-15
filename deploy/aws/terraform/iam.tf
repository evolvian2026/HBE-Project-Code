# The hosts' role: SSM (Session Manager, Run Command, their own parameters), ECR pulls,
# CloudWatch (logs, agent), the archive bucket and, in stage A, taking the Elastic IP.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

data "aws_iam_policy_document" "assume_ec2" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "host" {
  name               = "${local.name}-host"
  assume_role_policy = data.aws_iam_policy_document.assume_ec2.json
}

resource "aws_iam_role_policy_attachment" "managed" {
  for_each = toset([
    "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore",
    "arn:${data.aws_partition.current.partition}:iam::aws:policy/CloudWatchAgentServerPolicy",
    "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
  ])
  role       = aws_iam_role.host.name
  policy_arn = each.value
}

data "aws_iam_policy_document" "host" {
  statement {
    sid       = "ReadOwnParameters"
    actions   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
    resources = ["arn:${data.aws_partition.current.partition}:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_path}/*"]
  }
  statement {
    sid       = "DecryptParameters"
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }
  }
  statement {
    sid       = "ContainerLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = ["${aws_cloudwatch_log_group.app.arn}:*"]
  }
  statement {
    sid       = "ArchiveBucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.archive.arn]
  }
  statement {
    sid = "ArchiveObjects"
    actions = [
      "s3:GetObject", "s3:PutObject", "s3:PutObjectRetention", "s3:DeleteObject",
      "s3:BypassGovernanceRetention", "s3:AbortMultipartUpload",
    ]
    resources = ["${aws_s3_bucket.archive.arn}/*"]
  }
  dynamic "statement" {
    for_each = local.stage_a ? [1] : []
    content {
      sid       = "TakeTheElasticIp"
      actions   = ["ec2:AssociateAddress"]
      resources = ["*"]
    }
  }
}

resource "aws_iam_role_policy" "host" {
  name   = "host"
  role   = aws_iam_role.host.id
  policy = data.aws_iam_policy_document.host.json
}

resource "aws_iam_instance_profile" "host" {
  name = "${local.name}-host"
  role = aws_iam_role.host.name
}
