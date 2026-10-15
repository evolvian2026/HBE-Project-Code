# Offline checks of what each stage builds (a mocked AWS provider; no credentials needed):
#   terraform init -backend=false && terraform test
mock_provider "aws" {
  source = "./tests"
}

variables {
  environment             = "prod"
  app_host                = "app.example.com"
  api_host                = "api.example.com"
  institution_base_domain = "hbe.example.com"
  route53_zone_id         = "Z0123456789"
  alarm_email             = "ops@example.com"
  acme_email              = "ops@example.com"
  image                   = "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/hbe-prod:v1"
}

run "stage_a_is_one_self_healing_host_behind_caddy" {
  command = apply
  variables {
    stage = "a"
  }

  assert {
    condition     = length(aws_lb.main) == 0 && length(aws_wafv2_web_acl.main) == 0
    error_message = "Stage A has no load balancer or WAF"
  }
  assert {
    condition     = keys(aws_autoscaling_group.host) == ["app"] && aws_autoscaling_group.host["app"].max_size == 1
    error_message = "Stage A is one host in an Auto Scaling group of one"
  }
  assert {
    condition     = strcontains(base64decode(aws_launch_template.host["app"].user_data), "COMPOSE_PROFILES=app,worker,tls")
    error_message = "The single host runs web, api, worker and Caddy"
  }
  assert {
    condition     = strcontains(base64decode(aws_launch_template.host["app"].user_data), "--allocation-id \"eipalloc-0123456789abcdef0\"")
    error_message = "The host takes the Elastic IP at boot"
  }
  assert {
    condition     = toset(keys(aws_vpc_security_group_ingress_rule.caddy)) == toset(["80", "443"]) && length(aws_vpc_security_group_ingress_rule.from_alb) == 0
    error_message = "Only HTTP and HTTPS reach the host"
  }
  assert {
    condition     = aws_ssm_parameter.hosts["DOMAIN_PROVISIONER"].value == "caddy"
    error_message = "Caddy issues institutions' certificates on demand"
  }
  assert {
    condition     = toset(keys(aws_route53_record.stage_a)) == toset(["app.example.com", "api.example.com", "*.hbe.example.com"])
    error_message = "The app, the API and institutions' subdomains point at the Elastic IP"
  }
  assert {
    condition     = aws_launch_template.host["app"].metadata_options[0].http_tokens == "required"
    error_message = "IMDSv2 only"
  }
  assert {
    condition     = aws_s3_bucket.archive.bucket == "hbe-prod-archive-123456789012" && aws_s3_bucket.archive.object_lock_enabled
    error_message = "The records archive is a bucket with Object Lock"
  }
  assert {
    condition     = aws_ssm_parameter.hosts["ARCHIVE_S3_BUCKET"].value == aws_s3_bucket.archive.id && aws_ssm_parameter.hosts["ARCHIVE_OBJECT_LOCK"].value == "governance"
    error_message = "The hosts archive records there, with their instance role"
  }
}

run "stage_b_spreads_web_and_api_over_two_zones_behind_an_alb" {
  command = apply
  variables {
    stage             = "b"
    vanity_domains    = ["projects.example.edu"]
    github_repository = "example/hbe"
  }
  # A distinct ARN: as a set, two equal mock ARNs would collapse into one.
  override_resource {
    target = aws_lb_target_group.app["api"]
    values = {
      arn        = "arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:targetgroup/hbe-prod-api/def"
      arn_suffix = "targetgroup/hbe-prod-api/def"
    }
  }

  assert {
    condition     = length(aws_lb.main) == 1 && toset(keys(aws_lb_target_group.app)) == toset(["web", "api"])
    error_message = "One ALB with web and api target groups"
  }
  assert {
    condition     = aws_autoscaling_group.host["app"].min_size == 2 && length(distinct(aws_subnet.public[*].availability_zone)) == 2 && aws_autoscaling_group.host["app"].vpc_zone_identifier == toset(aws_subnet.public[*].id)
    error_message = "At least two web+api hosts across two zones"
  }
  assert {
    condition     = aws_autoscaling_group.host["app"].health_check_type == "ELB" && length(aws_autoscaling_group.host["app"].target_group_arns) == 2
    error_message = "The web+api hosts are in both target groups and replaced when unhealthy"
  }
  assert {
    condition     = aws_autoscaling_group.host["worker"].max_size == 1
    error_message = "One worker host"
  }
  assert {
    condition     = strcontains(base64decode(aws_launch_template.host["app"].user_data), "COMPOSE_PROFILES=app\"") && strcontains(base64decode(aws_launch_template.host["worker"].user_data), "COMPOSE_PROFILES=worker\"")
    error_message = "Web+api hosts and the worker host run their own services, without Caddy"
  }
  assert {
    condition     = toset(keys(aws_vpc_security_group_ingress_rule.from_alb)) == toset(["3000", "4000"]) && length(aws_vpc_security_group_ingress_rule.caddy) == 0
    error_message = "Only the ALB reaches the hosts"
  }
  assert {
    condition     = one([for c in aws_lb_listener_rule.api[0].condition : c.host_header[0].values if length(c.host_header) > 0]) == toset(["api.example.com"])
    error_message = "api_host goes to the api containers"
  }
  assert {
    condition     = contains(tolist(aws_acm_certificate.main[0].subject_alternative_names), "*.hbe.example.com")
    error_message = "The certificate covers institutions' subdomains"
  }
  assert {
    condition     = keys(aws_lb_listener_certificate.vanity) == ["projects.example.edu"]
    error_message = "Each vanity domain has its own certificate on the listener"
  }
  assert {
    condition     = length(aws_wafv2_web_acl_association.main) == 1
    error_message = "WAF protects the ALB"
  }
  assert {
    condition     = aws_ssm_parameter.hosts["DOMAIN_PROVISIONER"].value == "manual"
    error_message = "Stage B vanity domains go live once their certificate is added"
  }
  assert {
    condition     = toset(keys(aws_cloudwatch_metric_alarm.unhealthy)) == toset(["web", "api"])
    error_message = "Unhealthy targets raise alarms"
  }
  assert {
    condition     = length(aws_iam_role.deploy) == 1 && length(aws_iam_openid_connect_provider.github) == 1
    error_message = "GitHub Actions deploys through OIDC"
  }
  assert {
    condition = one([
      for c in data.aws_iam_policy_document.deploy_trust[0].statement[0].condition : c.values
      if c.variable == "token.actions.githubusercontent.com:sub"
    ]) == tolist(["repo:example/hbe:environment:production"])
    error_message = "Only the repository's deploy environment can take the deploy role"
  }
  assert {
    condition = toset(one([
      for st in data.aws_iam_policy_document.deploy[0].statement : st.condition[*].values if st.sid == "OnThisDeploymentsHosts"
    ])[0]) == toset(["hbe-prod-app", "hbe-prod-worker"])
    error_message = "Deploys run commands on this deployment's hosts only"
  }
}

run "settings_that_are_unset_are_left_out" {
  command = apply
  variables {
    stage                   = "a"
    institution_base_domain = ""
    route53_zone_id         = ""
  }

  assert {
    condition     = !contains(keys(aws_ssm_parameter.hosts), "INSTITUTION_BASE_DOMAIN") && length(aws_route53_record.stage_a) == 0 && length(aws_iam_role.deploy) == 0
    error_message = "No empty settings, no DNS records without a zone, and no deploy role without a repository"
  }
}

run "stage_must_be_a_or_b" {
  command = plan
  variables {
    stage = "c"
  }
  expect_failures = [var.stage]
}

run "stage_b_needs_two_hosts" {
  command = plan
  variables {
    stage     = "b"
    app_hosts = { min = 1, desired = 1, max = 2 }
  }
  expect_failures = [var.app_hosts]
}
