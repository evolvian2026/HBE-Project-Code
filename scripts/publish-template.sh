#!/usr/bin/env bash
# Publishes a starter template folder (templates/<profile>) as a private GitHub template repository.
#
#   scripts/publish-template.sh templates/mern-node20 my-org/mern-starter
#
# Needs the GitHub CLI (gh), signed in as someone who can create repositories in that
# organization. Then use "my-org/mern-starter" as the assignment's template repository.
set -euo pipefail

src="${1:?usage: publish-template.sh <template folder> <owner/repo>}"
repo="${2:?usage: publish-template.sh <template folder> <owner/repo>}"
[[ -f "$src/compose.yaml" ]] || { echo "$src doesn't look like a template (no compose.yaml)" >&2; exit 1; }
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "repository must look like owner/name" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# The folder's files only: no installed dependencies, build output or local databases.
tar -C "$src" --exclude=node_modules --exclude=dist --exclude=__pycache__ --exclude=.venv \
  --exclude=db.sqlite3 --exclude=junit.xml -cf - . | tar -C "$work" -xf -

gh repo create "$repo" --private --description "Starter template ($(basename "$src"))"
git -C "$work" init -q -b main
git -C "$work" add .
git -C "$work" -c user.name="HBE Platform" -c user.email="noreply@users.noreply.github.com" \
  commit -q -m "Starter template: $(basename "$src")"
git -C "$work" remote add origin "https://github.com/$repo.git"
gh auth setup-git >/dev/null 2>&1 || true
git -C "$work" push -q -u origin main
gh repo edit "$repo" --template
echo "Published https://github.com/$repo (template). Use \"$repo\" as the assignment's template repository."
