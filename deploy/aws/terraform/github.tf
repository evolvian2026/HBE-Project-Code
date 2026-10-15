# The role GitHub Actions takes to deploy (.github/workflows/deploy-aws.yml), through GitHub's
# OIDC tokens: no AWS keys are stored in GitHub. It can push the image, set which image runs,
# and run /opt/hbe/deploy.sh on this deployment's hosts — nothing else.

locals {
  deploy      = var.github_repository != ""
  oidc_issuer = "token.actions.githubusercontent.com"
  oidc_provider_arn = !local.deploy ? "" : (
    var.github_oidc_provider_arn != "" ? var.github_oidc_provider_arn : aws_iam_openid_connect_provider.github[0].arn
  )
}

resource "aws_iam_openid_connect_provider" "github" {
  count          = local.deploy && var.github_oidc_provider_arn == "" ? 1 : 0
  url            = "https://${local.oidc_issuer}"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "deploy_trust" {
  count = local.deploy ? 1 : 0
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer}:aud"
      values   = ["sts.amazonaws.com"]
    }
    # Only jobs in the deploy environment (which can require reviewers and a branch).
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer}:sub"
      values   = ["repo:${var.github_repository}:environment:${var.github_environment}"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  count              = local.deploy ? 1 : 0
  name               = "${local.name}-deploy"
  assume_role_policy = data.aws_iam_policy_document.deploy_trust[0].json
}

data "aws_iam_policy_document" "deploy" {
  count = local.deploy ? 1 : 0
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "PushTheImage"
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:DescribeImages",
      "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage",
    ]
    resources = [aws_ecr_repository.app.arn]
  }
  statement {
    sid       = "SetTheImage"
    actions   = ["ssm:GetParameter", "ssm:PutParameter"]
    resources = [aws_ssm_parameter.image.arn]
  }
  statement {
    sid       = "RunDeployScript"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:${data.aws_partition.current.partition}:ssm:${var.region}::document/AWS-RunShellScript"]
  }
  statement {
    sid       = "OnThisDeploymentsHosts"
    actions   = ["ssm:SendCommand"]
    resources = ["arn:${data.aws_partition.current.partition}:ec2:${var.region}:${data.aws_caller_identity.current.account_id}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "ssm:resourceTag/HbeGroup"
      values   = ["${local.name}-app", "${local.name}-worker"]
    }
  }
  statement {
    sid       = "FollowTheDeploy"
    actions   = ["ssm:ListCommands", "ssm:ListCommandInvocations", "ssm:GetCommandInvocation", "autoscaling:DescribeAutoScalingGroups"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "deploy" {
  count  = local.deploy ? 1 : 0
  name   = "deploy"
  role   = aws_iam_role.deploy[0].id
  policy = data.aws_iam_policy_document.deploy[0].json
}
