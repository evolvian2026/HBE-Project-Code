# Stand-ins for what AWS would report, so `terraform test` runs offline without credentials.
mock_data "aws_availability_zones" {
  defaults = { names = ["ap-southeast-1a", "ap-southeast-1b", "ap-southeast-1c"] }
}
mock_data "aws_ssm_parameter" {
  defaults = { value = "ami-0123456789abcdef0" }
}
mock_data "aws_caller_identity" {
  defaults = { account_id = "123456789012" }
}
mock_data "aws_partition" {
  defaults = { partition = "aws" }
}
mock_data "aws_iam_policy_document" {
  defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
}
mock_resource "aws_ecr_repository" {
  defaults = { repository_url = "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/hbe-prod" }
}
mock_resource "aws_eip" {
  defaults = { allocation_id = "eipalloc-0123456789abcdef0", public_ip = "203.0.113.10" }
}
mock_resource "aws_lb" {
  defaults = {
    arn        = "arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:loadbalancer/app/hbe-prod/abc"
    dns_name   = "hbe-prod-123.ap-southeast-1.elb.amazonaws.com"
    zone_id    = "Z1LMS91P8CMLE5"
    arn_suffix = "app/hbe-prod/abc"
  }
}
mock_resource "aws_cloudwatch_log_group" {
  defaults = { arn = "arn:aws:logs:ap-southeast-1:123456789012:log-group:/hbe/prod/app" }
}
mock_resource "aws_iam_instance_profile" {
  defaults = { arn = "arn:aws:iam::123456789012:instance-profile/hbe-prod-host" }
}
mock_resource "aws_acm_certificate" {
  defaults = {
    arn = "arn:aws:acm:ap-southeast-1:123456789012:certificate/abc"
    domain_validation_options = [
      { domain_name = "app.example.com", resource_record_name = "_a.app.example.com.", resource_record_type = "CNAME", resource_record_value = "_a.acm-validations.aws." },
      { domain_name = "api.example.com", resource_record_name = "_b.api.example.com.", resource_record_type = "CNAME", resource_record_value = "_b.acm-validations.aws." },
      { domain_name = "*.hbe.example.com", resource_record_name = "_c.hbe.example.com.", resource_record_type = "CNAME", resource_record_value = "_c.acm-validations.aws." },
    ]
  }
}
mock_resource "aws_launch_template" {
  defaults = { id = "lt-0123456789abcdef0", latest_version = 1 }
}
mock_resource "aws_sns_topic" {
  defaults = { arn = "arn:aws:sns:ap-southeast-1:123456789012:hbe-prod-alarms" }
}
mock_resource "aws_vpc" {
  defaults = { id = "vpc-0123456789abcdef0" }
}
mock_resource "aws_subnet" {
  defaults = { id = "subnet-0123456789abcdef0" }
}
mock_resource "aws_security_group" {
  defaults = { id = "sg-0123456789abcdef0" }
}
mock_resource "aws_iam_role" {
  defaults = { arn = "arn:aws:iam::123456789012:role/hbe-prod-host" }
}
mock_resource "aws_lb_target_group" {
  defaults = {
    arn        = "arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:targetgroup/hbe-prod/abc"
    arn_suffix = "targetgroup/hbe-prod/abc"
  }
}
mock_resource "aws_lb_listener" {
  defaults = { arn = "arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:listener/app/hbe-prod/abc/def" }
}
mock_resource "aws_acm_certificate_validation" {
  defaults = { certificate_arn = "arn:aws:acm:ap-southeast-1:123456789012:certificate/abc" }
}
mock_resource "aws_wafv2_web_acl" {
  defaults = { arn = "arn:aws:wafv2:ap-southeast-1:123456789012:regional/webacl/hbe-prod/abc" }
}
mock_resource "aws_s3_bucket" {
  defaults = { arn = "arn:aws:s3:::hbe-prod-archive-123456789012", id = "hbe-prod-archive-123456789012" }
}
mock_resource "aws_iam_openid_connect_provider" {
  defaults = { arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" }
}
mock_resource "aws_ssm_parameter" {
  defaults = { arn = "arn:aws:ssm:ap-southeast-1:123456789012:parameter/hbe/prod/image" }
}
