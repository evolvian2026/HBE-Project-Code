locals {
  name    = "hbe-${var.environment}"
  stage_a = var.stage == "a"
  stage_b = var.stage == "b"
  # Parameters under this path become /opt/hbe/.env on every host (secrets: SecureString).
  ssm_path  = "/hbe/${var.environment}"
  log_group = "/hbe/${var.environment}/app"
  zone      = var.route53_zone_id != ""
  # Names on the stage B certificate.
  cert_names = compact([
    var.api_host,
    var.institution_base_domain != "" ? "*.${var.institution_base_domain}" : "",
  ])
}
