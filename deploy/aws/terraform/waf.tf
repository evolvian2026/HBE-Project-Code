# Stage B: AWS WAF on the ALB. AWS's common and known-bad-input rules, and a per-address rate
# limit on the endpoints anyone can call (GitHub webhooks, LTI launches). The common rules'
# body size limit (8 KB) only counts: webhook payloads, grader results and uploads are larger.

resource "aws_wafv2_web_acl" "main" {
  count = local.stage_b && var.waf_enabled ? 1 : 0
  name  = local.name
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "aws-common"
    priority = 10
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"
        rule_action_override {
          name = "SizeRestrictions_BODY"
          action_to_use {
            count {}
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-aws-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-known-bad-inputs"
    priority = 20
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-aws-known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "rate-webhooks-lti"
    priority = 30
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 600
        aggregate_key_type = "IP"
        scope_down_statement {
          or_statement {
            statement {
              byte_match_statement {
                search_string         = "/webhooks"
                positional_constraint = "STARTS_WITH"
                field_to_match {
                  uri_path {}
                }
                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }
            statement {
              byte_match_statement {
                search_string         = "/lti"
                positional_constraint = "STARTS_WITH"
                field_to_match {
                  uri_path {}
                }
                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-rate-webhooks-lti"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = local.name
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "main" {
  count        = local.stage_b && var.waf_enabled ? 1 : 0
  resource_arn = aws_lb.main[0].arn
  web_acl_arn  = aws_wafv2_web_acl.main[0].arn
}
