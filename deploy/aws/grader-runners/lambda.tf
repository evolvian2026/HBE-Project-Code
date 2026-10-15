data "archive_file" "scaler" {
  type        = "zip"
  output_path = "${path.module}/.build/scaler.zip"
  source {
    filename = "index.mjs"
    content  = file("${path.module}/lambda/index.mjs")
  }
  source {
    filename = "scaler.mjs"
    content  = file("${path.module}/lambda/scaler.mjs")
  }
  source {
    filename = "github.mjs"
    content  = file("${path.module}/lambda/github.mjs")
  }
}

resource "aws_cloudwatch_log_group" "scaler" {
  name              = "/aws/lambda/${local.name}-scaler"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "scaler" {
  function_name    = "${local.name}-scaler"
  role             = aws_iam_role.scaler.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.scaler.output_path
  source_code_hash = data.archive_file.scaler.output_base64sha256
  memory_size      = 256
  timeout          = 60
  # One pass at a time, so two passes never start runners for the same job.
  reserved_concurrent_executions = 1

  environment {
    variables = {
      DEPLOYMENT           = var.environment
      REPOSITORY           = var.grader_repository
      RUNNER_LABELS        = join(",", var.runner_labels)
      MAX_RUNNERS          = tostring(var.max_runners)
      INSTANCE_TYPES       = join(",", var.instance_types)
      ON_DEMAND_FALLBACK   = tostring(var.on_demand_fallback)
      SUBNET_IDS           = join(",", aws_subnet.public[*].id)
      LAUNCH_TEMPLATE_ID   = aws_launch_template.runner.id
      SSM_PREFIX           = local.ssm_prefix
      MAX_LIFETIME_MINUTES = tostring(var.max_job_minutes + 15)
      IDLE_MINUTES         = "15"
      BOOT_MINUTES         = "10"
    }
  }

  depends_on = [aws_cloudwatch_log_group.scaler, aws_iam_role_policy.scaler]
}

# GitHub's workflow_job webhook (the runners' GitHub App). Public: every request must carry
# the webhook secret's signature, or the scaler refuses it.
resource "aws_lambda_function_url" "webhook" {
  function_name      = aws_lambda_function.scaler.function_name
  authorization_type = "NONE"
}

resource "aws_lambda_permission" "webhook_url" {
  statement_id           = "GitHubWebhookUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.scaler.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "webhook_invoke" {
  statement_id             = "GitHubWebhookInvoke"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.scaler.function_name
  principal                = "*"
  invoked_via_function_url = true
}

# And every minute, for webhooks that were missed or arrived during another pass, and to stop
# idle runners.
resource "aws_cloudwatch_event_rule" "every_minute" {
  name                = "${local.name}-scaler"
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "scaler" {
  rule = aws_cloudwatch_event_rule.every_minute.name
  arn  = aws_lambda_function.scaler.arn
}

resource "aws_lambda_permission" "schedule" {
  statement_id  = "EveryMinute"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.scaler.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.every_minute.arn
}
