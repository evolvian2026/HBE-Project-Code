#!/usr/bin/env bash
# Turns on SAML SSO in the local Supabase stack (local development and CI E2E only).
#
# The Supabase CLI can't enable SAML for its local Auth server, so this re-creates the Auth
# container as it is (same image, settings, network and labels, so `supabase stop` still
# manages it) plus GOTRUE_SAML_ENABLED and a throwaway signing key. Hosted Supabase projects
# turn SAML on in the dashboard instead (docs/CONFIGURATION.md §5.3). Run it after
# `pnpm db:start`; `supabase start` brings back the plain container.
set -euo pipefail

project="${SUPABASE_PROJECT_ID:-hbe-project-code}"
c="supabase_auth_${project}"
docker inspect "$c" >/dev/null

if docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c" | grep -q '^GOTRUE_SAML_ENABLED=true$'; then
  echo "SAML is already on"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c" | grep -v '^$' > "$work/env"
echo "GOTRUE_SAML_ENABLED=true" >> "$work/env"
echo "GOTRUE_SAML_PRIVATE_KEY=$(openssl genrsa 2048 2>/dev/null | openssl rsa -traditional -outform DER 2>/dev/null | base64 -w0)" >> "$work/env"

image="$(docker inspect -f '{{.Config.Image}}' "$c")"
network="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$c")"
labels=()
while IFS='=' read -r k v; do [ -n "$k" ] && labels+=(--label "$k=$v"); done < <(
  docker inspect -f '{{range $k, $v := .Config.Labels}}{{$k}}={{$v}}{{println}}{{end}}' "$c"
)

docker rm -f "$c" >/dev/null
docker run -d --name "$c" --network "$network" --network-alias auth "${labels[@]}" \
  --restart unless-stopped --env-file "$work/env" \
  --health-cmd 'wget --no-verbose --tries=1 --spider http://127.0.0.1:9999/health' --health-interval 10s \
  "$image" auth >/dev/null

for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$c")" = "healthy" ] && { echo "SAML is on"; exit 0; }
  sleep 1
done
echo "the Auth container didn't become healthy" >&2
docker logs --tail 20 "$c" >&2
exit 1
