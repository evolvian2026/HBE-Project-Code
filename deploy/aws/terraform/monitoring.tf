# Alarms to an SNS topic (email; add Slack through AWS Chatbot if wanted).

resource "aws_sns_topic" "alarms" {
  name = "${local.name}-alarms"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# Every host group: CPU sustained high, and a failing status check.
resource "aws_cloudwatch_metric_alarm" "cpu" {
  for_each            = aws_autoscaling_group.host
  alarm_name          = "${local.name}-${each.key}-cpu"
  alarm_description   = "${each.key} hosts above 80% CPU for 15 minutes"
  namespace           = "AWS/EC2"
  metric_name         = "CPUUtilization"
  dimensions          = { AutoScalingGroupName = each.value.name }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "status_check" {
  for_each            = aws_autoscaling_group.host
  alarm_name          = "${local.name}-${each.key}-status-check"
  alarm_description   = "A ${each.key} host fails its status checks (the group replaces it)"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  dimensions          = { AutoScalingGroupName = each.value.name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = [aws_sns_topic.alarms.arn]
}

# Stage B: errors and slowness seen by the load balancer, and unhealthy targets.
resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  count               = local.stage_b ? 1 : 0
  alarm_name          = "${local.name}-5xx"
  alarm_description   = "More than 20 server errors in 5 minutes"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = aws_lb.main[0].arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 20
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "latency" {
  count               = local.stage_b ? 1 : 0
  alarm_name          = "${local.name}-latency"
  alarm_description   = "p95 response time above 2 seconds for 10 minutes"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = { LoadBalancer = aws_lb.main[0].arn_suffix }
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 2
  threshold           = 2
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "unhealthy" {
  for_each            = aws_lb_target_group.app
  alarm_name          = "${local.name}-${each.key}-unhealthy"
  alarm_description   = "A ${each.key} target is failing its /healthz check"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = aws_lb.main[0].arn_suffix, TargetGroup = each.value.arn_suffix }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}
