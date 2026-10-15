# Stage B: an Application Load Balancer across both zones. HTTP is redirected to HTTPS;
# api_host goes to the api containers, every other host (the app, institutions' subdomains
# and vanity domains) to the web containers.

resource "aws_lb" "main" {
  count                      = local.stage_b ? 1 : 0
  name                       = local.name
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb[0].id]
  subnets                    = aws_subnet.public[*].id
  drop_invalid_header_fields = true
  idle_timeout               = 120
}

resource "aws_lb_target_group" "app" {
  for_each             = local.stage_b ? { web = 3000, api = 4000 } : {}
  name                 = "${local.name}-${each.key}"
  port                 = each.value
  protocol             = "HTTP"
  vpc_id               = aws_vpc.main.id
  deregistration_delay = 30
  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  count             = local.stage_b ? 1 : 0
  load_balancer_arn = aws_lb.main[0].arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  count             = local.stage_b ? 1 : 0
  load_balancer_arn = aws_lb.main[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = local.zone ? aws_acm_certificate_validation.main[0].certificate_arn : aws_acm_certificate.main[0].arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app["web"].arn
  }
}

resource "aws_lb_listener_rule" "api" {
  count        = local.stage_b ? 1 : 0
  listener_arn = aws_lb_listener.https[0].arn
  priority     = 10
  condition {
    host_header {
      values = [var.api_host]
    }
  }
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app["api"].arn
  }
}

# Institutions' own domains: one more certificate each on the HTTPS listener (served once
# ACM has validated it, which needs the institution's DNS record from the outputs).
resource "aws_lb_listener_certificate" "vanity" {
  for_each        = local.stage_b ? var.vanity_domains : toset([])
  listener_arn    = aws_lb_listener.https[0].arn
  certificate_arn = aws_acm_certificate.vanity[each.key].arn
}
