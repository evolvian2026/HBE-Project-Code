data "aws_iam_policy_document" "assume_ec2" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "assume_lambda" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

locals {
  arn_prefix = "arn:${data.aws_partition.current.partition}"
  account    = data.aws_caller_identity.current.account_id
  params_arn = "${local.arn_prefix}:ssm:${var.region}:${local.account}:parameter${local.ssm_prefix}"
  ssm_kms = {
    test     = "StringEquals"
    variable = "kms:ViaService"
    values   = ["ssm.${var.region}.amazonaws.com"]
  }
}

# ── The runner instances: read (and delete) their one-time runner config, Session Manager
# for debugging. No platform secrets, nothing else. ───────────────────────────────────────

resource "aws_iam_role" "runner" {
  name               = "${local.name}-runner"
  assume_role_policy = data.aws_iam_policy_document.assume_ec2.json
}

resource "aws_iam_role_policy_attachment" "runner_ssm" {
  role       = aws_iam_role.runner.name
  policy_arn = "${local.arn_prefix}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "runner" {
  statement {
    sid       = "OwnRunnerConfig"
    actions   = ["ssm:GetParameter", "ssm:DeleteParameter"]
    resources = ["${local.params_arn}/jit/*"]
  }
  statement {
    sid       = "Decrypt"
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = local.ssm_kms.test
      variable = local.ssm_kms.variable
      values   = local.ssm_kms.values
    }
  }
}

resource "aws_iam_role_policy" "runner" {
  name   = "runner"
  role   = aws_iam_role.runner.id
  policy = data.aws_iam_policy_document.runner.json
}

resource "aws_iam_instance_profile" "runner" {
  name = "${local.name}-runner"
  role = aws_iam_role.runner.name
}

# ── The scaler: start instances from the launch template only, stop only runners. ──────

resource "aws_iam_role" "scaler" {
  name               = "${local.name}-scaler"
  assume_role_policy = data.aws_iam_policy_document.assume_lambda.json
}

data "aws_iam_policy_document" "scaler" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.scaler.arn}:*"]
  }
  statement {
    sid       = "Settings"
    actions   = ["ssm:GetParameters"]
    resources = ["${local.params_arn}/*"]
  }
  statement {
    sid       = "RunnerConfigs"
    actions   = ["ssm:PutParameter", "ssm:DeleteParameter"]
    resources = ["${local.params_arn}/jit/*"]
  }
  statement {
    sid       = "EncryptAndDecrypt"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = ["*"]
    condition {
      test     = local.ssm_kms.test
      variable = local.ssm_kms.variable
      values   = local.ssm_kms.values
    }
  }
  statement {
    sid       = "SeeInstances"
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
  }
  # Instances only from the runners' launch template…
  statement {
    sid       = "StartRunners"
    actions   = ["ec2:RunInstances"]
    resources = ["${local.arn_prefix}:ec2:${var.region}:${local.account}:instance/*"]
    condition {
      test     = "ArnLike"
      variable = "ec2:LaunchTemplate"
      values   = [aws_launch_template.runner.arn]
    }
  }
  # …and what they need to start.
  statement {
    sid     = "StartRunnersWith"
    actions = ["ec2:RunInstances"]
    resources = [
      aws_launch_template.runner.arn,
      "${local.arn_prefix}:ec2:${var.region}::image/*",
      "${local.arn_prefix}:ec2:${var.region}:${local.account}:subnet/*",
      "${local.arn_prefix}:ec2:${var.region}:${local.account}:security-group/${aws_security_group.runner.id}",
      "${local.arn_prefix}:ec2:${var.region}:${local.account}:network-interface/*",
      "${local.arn_prefix}:ec2:${var.region}:${local.account}:volume/*",
      "${local.arn_prefix}:ec2:${var.region}:${local.account}:spot-instances-request/*",
    ]
  }
  statement {
    sid       = "TagWhenStarting"
    actions   = ["ec2:CreateTags"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "ec2:CreateAction"
      values   = ["RunInstances"]
    }
  }
  statement {
    sid       = "StopRunners"
    actions   = ["ec2:TerminateInstances"]
    resources = ["${local.arn_prefix}:ec2:${var.region}:${local.account}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/${local.tag}"
      values   = [var.environment]
    }
  }
  statement {
    sid       = "GiveRunnersTheirRole"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.runner.arn]
  }
  statement {
    sid       = "SpotServiceRole"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["${local.arn_prefix}:iam::${local.account}:role/aws-service-role/spot.amazonaws.com/*"]
    condition {
      test     = "StringEquals"
      variable = "iam:AWSServiceName"
      values   = ["spot.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "scaler" {
  name   = "scaler"
  role   = aws_iam_role.scaler.id
  policy = data.aws_iam_policy_document.scaler.json
}
