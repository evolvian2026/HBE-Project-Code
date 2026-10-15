# Stage B certificates (ACM, DNS-validated): the app and API hosts and institutions'
# subdomains on one; each vanity domain on its own. With a Route 53 zone the validation
# records are created here; otherwise add them from the outputs.

resource "aws_acm_certificate" "main" {
  count                     = local.stage_b ? 1 : 0
  domain_name               = var.app_host
  subject_alternative_names = local.cert_names
  validation_method         = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

locals {
  # The certificate's names key the records (known when planning; the records are not).
  validation = local.stage_b ? {
    for o in aws_acm_certificate.main[0].domain_validation_options : o.domain_name => o
  } : {}
}

resource "aws_route53_record" "validation" {
  for_each        = local.stage_b && local.zone ? toset(concat([var.app_host], local.cert_names)) : toset([])
  zone_id         = var.route53_zone_id
  name            = local.validation[each.key].resource_record_name
  type            = local.validation[each.key].resource_record_type
  records         = [local.validation[each.key].resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "main" {
  count                   = local.stage_b && local.zone ? 1 : 0
  certificate_arn         = aws_acm_certificate.main[0].arn
  validation_record_fqdns = [for r in aws_route53_record.validation : r.fqdn]
}

resource "aws_acm_certificate" "vanity" {
  for_each          = local.stage_b ? var.vanity_domains : toset([])
  domain_name       = each.key
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}
