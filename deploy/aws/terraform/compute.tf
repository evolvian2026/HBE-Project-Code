# Hosts: Amazon Linux 2023 on Graviton, IMDSv2 only, encrypted disks, no SSH key. Each runs
# the same image with the Compose profiles for its job, and is replaced (not patched) when
# its launch template changes.

data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

variable "compose_version" {
  description = "Docker Compose plugin installed on the hosts."
  type        = string
  default     = "2.29.7"
}

locals {
  registry = split("/", aws_ecr_repository.app.repository_url)[0]
  user_data = {
    for role, profiles in {
      app    = local.stage_a ? "app,worker,tls" : "app"
      worker = "worker"
      } : role => base64encode(templatefile("${path.module}/templates/user-data.sh.tftpl", {
        region            = var.region
        ssm_path          = local.ssm_path
        log_group         = local.log_group
        registry          = local.registry
        profiles          = profiles
        compose_version   = var.compose_version
        compose_b64       = filebase64("${path.module}/../docker-compose.prod.yml")
        caddyfile_b64     = filebase64("${path.module}/../Caddyfile")
        eip_allocation_id = local.stage_a && role == "app" ? aws_eip.app[0].allocation_id : ""
    }))
  }
}

resource "aws_launch_template" "host" {
  for_each      = local.stage_b ? toset(["app", "worker"]) : toset(["app"])
  name_prefix   = "${local.name}-${each.key}-"
  image_id      = data.aws_ssm_parameter.al2023_arm64.value
  instance_type = each.key == "worker" ? var.worker_instance_type : var.app_instance_type
  user_data     = local.user_data[each.key]

  iam_instance_profile {
    arn = aws_iam_instance_profile.host.arn
  }
  vpc_security_group_ids = [aws_security_group.host.id]

  metadata_options {
    http_tokens = "required"
    # The app's containers use the instance role (archive bucket, logs): one hop more than the host.
    http_put_response_hop_limit = 2
    http_endpoint               = "enabled"
  }

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 30
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  monitoring {
    enabled = true
  }

  tag_specifications {
    resource_type = "instance"
    # Deploys find a group's hosts by HbeGroup (SSM Run Command; github.tf allows only these).
    tags = { Name = "${local.name}-${each.key}", Role = each.key, HbeGroup = "${local.name}-${each.key}" }
  }
}

resource "aws_autoscaling_group" "host" {
  for_each            = aws_launch_template.host
  name                = "${local.name}-${each.key}"
  vpc_zone_identifier = aws_subnet.public[*].id
  # Stage A and the worker: one self-healing host. Stage B web+api: across both zones.
  min_size         = local.stage_b && each.key == "app" ? var.app_hosts.min : 1
  desired_capacity = local.stage_b && each.key == "app" ? var.app_hosts.desired : 1
  max_size         = local.stage_b && each.key == "app" ? var.app_hosts.max : 1

  target_group_arns         = local.stage_b && each.key == "app" ? [for tg in aws_lb_target_group.app : tg.arn] : []
  health_check_type         = local.stage_b && each.key == "app" ? "ELB" : "EC2"
  health_check_grace_period = 300

  launch_template {
    id      = each.value.id
    version = each.value.latest_version
  }

  # A new launch template (image, user data) rolls the hosts, keeping most of them serving.
  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = local.stage_b && each.key == "app" ? 50 : 0
    }
  }

  tag {
    key                 = "Name"
    value               = "${local.name}-${each.key}"
    propagate_at_launch = true
  }
}

# Stage A: a fixed address for DNS (the host takes it at boot).
resource "aws_eip" "app" {
  count  = local.stage_a ? 1 : 0
  domain = "vpc"
  tags   = { Name = local.name }
}

resource "aws_cloudwatch_log_group" "app" {
  name              = local.log_group
  retention_in_days = var.log_retention_days
}
