# Offline checks of the runner stack (a mocked AWS provider; no credentials needed):
#   terraform init -backend=false && terraform test
mock_provider "aws" {
  source = "./tests"
}

variables {
  grader_repository = "example/hbe-grader"
  runner_version    = "2.329.0"
  runner_sha256     = "0000000000000000000000000000000000000000000000000000000000000000"
  alarm_email       = "ops@example.com"
}

run "runners_are_one_job_spot_instances_behind_a_capped_scaler" {
  command = apply

  assert {
    condition     = aws_launch_template.runner.instance_initiated_shutdown_behavior == "terminate"
    error_message = "A runner that shuts down after its job is gone"
  }
  assert {
    condition     = aws_launch_template.runner.metadata_options[0].http_put_response_hop_limit == 1 && aws_launch_template.runner.metadata_options[0].http_tokens == "required"
    error_message = "Containers can't reach the instance's credentials"
  }
  assert {
    condition     = strcontains(base64decode(aws_launch_template.runner.user_data), "./run.sh --jitconfig") && strcontains(base64decode(aws_launch_template.runner.user_data), "trap 'shutdown -h now' EXIT")
    error_message = "Each runner runs one job (JIT config), then shuts down whatever happens"
  }
  assert {
    condition     = strcontains(base64decode(aws_launch_template.runner.user_data), "echo \"0000000000000000000000000000000000000000000000000000000000000000  runner.tar.gz\" | sha256sum -c -")
    error_message = "The runner download is checked"
  }
  assert {
    condition     = aws_lambda_function.scaler.environment[0].variables.MAX_RUNNERS == "10" && aws_lambda_function.scaler.reserved_concurrent_executions == 1
    error_message = "One scaler pass at a time, under the runner cap"
  }
  assert {
    condition     = aws_lambda_function.scaler.environment[0].variables.MAX_LIFETIME_MINUTES == "75"
    error_message = "Runners outliving a job are stopped"
  }
  assert {
    condition     = length(aws_subnet.public) == 3 && length(distinct(aws_subnet.public[*].availability_zone)) == 3
    error_message = "Three zones for spot capacity"
  }
  assert {
    condition     = aws_lambda_function_url.webhook.authorization_type == "NONE" && aws_cloudwatch_event_rule.every_minute.schedule_expression == "rate(1 minute)"
    error_message = "GitHub's webhook and a schedule both run the scaler"
  }
  assert {
    condition     = output.runner_labels == "[\"self-hosted\",\"hbe-grader\"]"
    error_message = "The labels for the grader repository's HBE_RUNNER_LABELS"
  }
  assert {
    condition = one([
      for st in data.aws_iam_policy_document.scaler.statement : st.condition[*].values if st.sid == "StopRunners"
    ])[0] == tolist(["prod"])
    error_message = "The scaler can terminate only this deployment's runners"
  }
  assert {
    condition = one([
      for st in data.aws_iam_policy_document.scaler.statement : st.condition[*].values if st.sid == "StartRunners"
    ])[0] == tolist([aws_launch_template.runner.arn])
    error_message = "The scaler can start instances only from the runners' launch template"
  }
  assert {
    condition     = toset(data.aws_iam_policy_document.runner.statement[0].resources) == toset(["arn:aws:ssm:ap-southeast-1:210987654321:parameter/hbe-grader/prod/jit/*"])
    error_message = "Runners can read only their one-time runner configs"
  }
}

run "a_pre_baked_ami_replaces_the_default" {
  command = plan
  variables {
    ami_id = "ami-0fedcba9876543210"
  }
  assert {
    condition     = aws_launch_template.runner.image_id == "ami-0fedcba9876543210"
    error_message = "ami_id is used"
  }
}

run "the_runner_download_needs_its_checksum" {
  command = plan
  variables {
    runner_sha256 = "not-a-checksum"
  }
  expect_failures = [var.runner_sha256]
}

run "the_cap_is_bounded" {
  command = plan
  variables {
    max_runners = 0
  }
  expect_failures = [var.max_runners]
}
