# Ephemeral GitHub Actions runners for the grader (docs/DEPLOYMENT.md §2.4), in their own AWS
# account: a runner is an EC2 instance (spot, x86) that runs one grading job and terminates.
# A small Lambda (lambda/) starts them when the grader repository queues jobs, up to
# max_runners, and stops any that idle or outstay a job.

locals {
  name       = "hbe-grader-${var.environment}"
  ssm_prefix = "/hbe-grader/${var.environment}"
  tag        = "hbe:grader-runner"
}

data "aws_availability_zones" "available" {
  state = "available"
}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

# ── Network: public subnets, egress only (builds download packages), nothing inbound, no
# peering with the app's account. ──────────────────────────────────────────────────────────

resource "aws_vpc" "runners" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = local.name }
}

resource "aws_internet_gateway" "runners" {
  vpc_id = aws_vpc.runners.id
  tags   = { Name = local.name }
}

# Three zones where the region has them: more spot capacity to choose from.
resource "aws_subnet" "public" {
  count                   = min(3, length(data.aws_availability_zones.available.names))
  vpc_id                  = aws_vpc.runners.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true
  tags                    = { Name = "${local.name}-${count.index}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.runners.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.runners.id
  }
  tags = { Name = local.name }
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "runner" {
  name        = "${local.name}-runner"
  description = "Grader runners: no inbound traffic"
  vpc_id      = aws_vpc.runners.id
}

resource "aws_vpc_security_group_egress_rule" "runner" {
  security_group_id = aws_security_group.runner.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# ── The runners ─────────────────────────────────────────────────────────────────────────

data "aws_ssm_parameter" "al2023_x86" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_launch_template" "runner" {
  name_prefix = "${local.name}-"
  image_id    = var.ami_id != "" ? var.ami_id : data.aws_ssm_parameter.al2023_x86.value
  # Shutting down (after its one job) terminates the instance.
  instance_initiated_shutdown_behavior = "terminate"
  update_default_version               = true
  vpc_security_group_ids               = [aws_security_group.runner.id]

  user_data = base64encode(templatefile("${path.module}/templates/runner-user-data.sh.tftpl", {
    region          = var.region
    ssm_prefix      = local.ssm_prefix
    runner_version  = var.runner_version
    runner_sha256   = var.runner_sha256
    compose_version = var.compose_version
  }))

  iam_instance_profile {
    arn = aws_iam_instance_profile.runner.arn
  }

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
    # One hop: the containers that build and run student code can't reach the instance's
    # credentials. The runner reads its name from the instance's tags.
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = var.volume_size
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }
}
