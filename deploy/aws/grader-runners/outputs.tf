output "webhook_url" {
  description = "The runners' GitHub App webhook URL (event: Workflow job)."
  value       = aws_lambda_function_url.webhook.function_url
}

output "runner_labels" {
  description = "Set the grader repository's HBE_RUNNER_LABELS variable to this."
  value       = jsonencode(concat(["self-hosted"], var.runner_labels))
}

output "settings_parameters" {
  description = "Create these SSM parameters (README.md) before the first job."
  value = {
    app_id      = "${local.ssm_prefix}/github-app-id"
    private_key = "${local.ssm_prefix}/github-app-private-key"
    secret      = "${local.ssm_prefix}/webhook-secret"
  }
}

output "launch_template_id" {
  value = aws_launch_template.runner.id
}
