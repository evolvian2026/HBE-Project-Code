output "ecr_repository_url" {
  description = "Push the app image here (GitHub Actions), then set /hbe/<environment>/image and deploy."
  value       = aws_ecr_repository.app.repository_url
}

output "public_ip" {
  description = "Stage A: point app_host, api_host (and *.institution_base_domain) here."
  value       = local.stage_a ? aws_eip.app[0].public_ip : null
}

output "load_balancer_dns_name" {
  description = "Stage B: CNAME (or alias) app_host, api_host and *.institution_base_domain here; institutions CNAME their vanity domains here."
  value       = local.stage_b ? aws_lb.main[0].dns_name : null
}

output "certificate_validation_records" {
  description = "Stage B without a Route 53 zone: add these CNAME records so ACM can issue the certificate."
  value = local.stage_b && !local.zone ? [
    for o in aws_acm_certificate.main[0].domain_validation_options : {
      name  = o.resource_record_name
      type  = o.resource_record_type
      value = o.resource_record_value
    }
  ] : []
}

output "vanity_domain_validation_records" {
  description = "Stage B: records each institution adds so ACM can issue its domain's certificate."
  value = {
    for d, cert in aws_acm_certificate.vanity : d => [
      for o in cert.domain_validation_options : { name = o.resource_record_name, type = o.resource_record_type, value = o.resource_record_value }
    ]
  }
}

output "host_groups" {
  description = "Auto Scaling groups (deploy with SSM Run Command on their instances: /opt/hbe/deploy.sh)."
  value       = { for k, g in aws_autoscaling_group.host : k => g.name }
}

output "archive_bucket" {
  description = "The records archive bucket (ARCHIVE_S3_BUCKET, set on the hosts already)."
  value       = aws_s3_bucket.archive.id
}

output "deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN variable of the GitHub environment that deploys."
  value       = local.deploy ? aws_iam_role.deploy[0].arn : null
}

output "alarm_topic_arn" {
  value = aws_sns_topic.alarms.arn
}
