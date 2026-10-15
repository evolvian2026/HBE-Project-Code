#!/bin/bash
# Loads an env file into SSM Parameter Store for the AWS hosts: each KEY=value line becomes the
# SecureString parameter /hbe/<deployment>/env/KEY, which the hosts write to /opt/hbe/.env at
# boot and on every deploy. Values are never printed. Run it from your own machine with AWS
# credentials for the account (AWS CLI v2) and keep the env file out of git (.env.* is ignored).
#
#   deploy/aws/put-env.sh prod ~/hbe/production.env
#
# Settings Terraform manages (hosts, URLs, domains, the archive bucket) and HBE_IMAGE are
# skipped: change those through Terraform and the deploy workflow.
set -euo pipefail

deployment=${1:?usage: put-env.sh <deployment> <env file>}
file=${2:?usage: put-env.sh <deployment> <env file>}
region=${AWS_REGION:-ap-southeast-1}
managed=" APP_HOST API_HOST APP_URL API_URL INSTITUTION_BASE_DOMAIN DOMAIN_PROVISIONER CUSTOM_DOMAIN_TARGET ACME_EMAIL ARCHIVE_S3_BUCKET ARCHIVE_S3_REGION ARCHIVE_OBJECT_LOCK HBE_IMAGE "

count=0
while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
  key=${line%%=*}
  value=${line#*=}
  if [[ ! "$key" =~ ^[A-Z][A-Z0-9_]*$ ]]; then
    echo "skipped a line that isn't KEY=value" >&2
    continue
  fi
  if [[ "$managed" == *" $key "* ]]; then
    echo "skipped $key (set by Terraform or the deploy workflow)"
    continue
  fi
  if [ -z "$value" ] || [[ "$value" =~ ^\<.*\>$ ]]; then
    echo "skipped $key (empty or still a placeholder)"
    continue
  fi
  aws ssm put-parameter --region "$region" --name "/hbe/$deployment/env/$key" --type SecureString \
    --value "$value" --overwrite > /dev/null
  echo "set $key"
  count=$((count + 1))
done < "$file"
echo "$count settings stored under /hbe/$deployment/env/. Deploy (or replace the hosts) to apply them."
