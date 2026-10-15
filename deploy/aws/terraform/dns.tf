# With a Route 53 zone: the app and API hosts (and institutions' subdomains) point at the
# Elastic IP (stage A) or the load balancer (stage B).

locals {
  dns_names = local.zone ? compact([
    var.app_host,
    var.api_host,
    var.institution_base_domain != "" ? "*.${var.institution_base_domain}" : "",
  ]) : []
}

resource "aws_route53_record" "stage_a" {
  for_each = local.stage_a ? toset(local.dns_names) : toset([])
  zone_id  = var.route53_zone_id
  name     = each.key
  type     = "A"
  ttl      = 300
  records  = [aws_eip.app[0].public_ip]
}

resource "aws_route53_record" "stage_b" {
  for_each = local.stage_b ? toset(local.dns_names) : toset([])
  zone_id  = var.route53_zone_id
  name     = each.key
  type     = "A"
  alias {
    name                   = aws_lb.main[0].dns_name
    zone_id                = aws_lb.main[0].zone_id
    evaluate_target_health = true
  }
}
