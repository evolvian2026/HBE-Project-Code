# Stand-ins for what AWS would report, so `terraform test` runs offline without credentials.
mock_data "aws_availability_zones" {
  defaults = { names = ["ap-southeast-1a", "ap-southeast-1b", "ap-southeast-1c"] }
}
mock_data "aws_ssm_parameter" {
  defaults = { value = "ami-0123456789abcdef0" }
}
mock_data "aws_caller_identity" {
  defaults = { account_id = "210987654321" }
}
mock_data "aws_partition" {
  defaults = { partition = "aws" }
}
mock_data "aws_iam_policy_document" {
  defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
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
mock_resource "aws_launch_template" {
  defaults = {
    id             = "lt-0123456789abcdef0"
    arn            = "arn:aws:ec2:ap-southeast-1:210987654321:launch-template/lt-0123456789abcdef0"
    latest_version = 1
  }
}
mock_resource "aws_iam_role" {
  defaults = { arn = "arn:aws:iam::210987654321:role/hbe-grader-prod-runner" }
}
mock_resource "aws_iam_instance_profile" {
  defaults = { arn = "arn:aws:iam::210987654321:instance-profile/hbe-grader-prod-runner" }
}
mock_resource "aws_cloudwatch_log_group" {
  defaults = { arn = "arn:aws:logs:ap-southeast-1:210987654321:log-group:/aws/lambda/hbe-grader-prod-scaler" }
}
mock_resource "aws_lambda_function" {
  defaults = { arn = "arn:aws:lambda:ap-southeast-1:210987654321:function:hbe-grader-prod-scaler" }
}
mock_resource "aws_lambda_function_url" {
  defaults = { function_url = "https://abc123.lambda-url.ap-southeast-1.on.aws/" }
}
mock_resource "aws_sns_topic" {
  defaults = { arn = "arn:aws:sns:ap-southeast-1:210987654321:hbe-grader-prod-alarms" }
}
mock_resource "aws_cloudwatch_event_rule" {
  defaults = { arn = "arn:aws:events:ap-southeast-1:210987654321:rule/hbe-grader-prod-scaler" }
}
