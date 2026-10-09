#!/usr/bin/env bash
# Publishes this repository's grader/ folder to the private grader repository (GRADER_REPO).
#
#   scripts/publish-grader.sh hbe-platform/hbe-grader
#
# The first time, the repository is created (private) with grader/ as its root on `main`. After
# that, the current grader/ goes to a new branch and a pull request is opened, since `main`
# should be protected (docs/GITHUB_APP_SETUP.md §7). Needs the GitHub CLI (gh), signed in as
# someone who can create and push to that repository.
set -euo pipefail

repo="${1:?usage: publish-grader.sh <owner/repo>}"
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "repository must look like owner/name" >&2; exit 1; }
root="$(cd "$(dirname "$0")/.." && pwd)"
source_sha="$(git -C "$root" rev-parse --short HEAD)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
gh auth setup-git >/dev/null 2>&1 || true

copy_grader() {
  # The grader folder's files only: no installed dependencies or test output.
  find "$work/repo" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
  tar -C "$root/grader" --exclude=node_modules --exclude=.turbo --exclude=test-results -cf - . | tar -C "$work/repo" -xf -
}

if gh repo view "$repo" >/dev/null 2>&1; then
  git clone -q "https://github.com/$repo.git" "$work/repo"
  branch="sync/$source_sha"
  git -C "$work/repo" checkout -q -b "$branch"
  copy_grader
  git -C "$work/repo" add -A
  if git -C "$work/repo" diff --cached --quiet; then
    echo "$repo already matches grader/ at $source_sha."
    exit 0
  fi
  git -C "$work/repo" -c user.name="HBE Platform" -c user.email="noreply@users.noreply.github.com" \
    commit -q -m "Sync the grader from the platform repository ($source_sha)"
  git -C "$work/repo" push -q -u origin "$branch"
  gh pr create --repo "$repo" --head "$branch" --title "Sync the grader ($source_sha)" \
    --body "grader/ from the platform repository at $source_sha. Suites already used by assignments must not change; add new suite versions instead."
else
  gh repo create "$repo" --private --description "HBE grader: harness, hidden test suites and the evaluate workflow"
  mkdir -p "$work/repo"
  git -C "$work/repo" init -q -b main
  copy_grader
  git -C "$work/repo" add -A
  git -C "$work/repo" -c user.name="HBE Platform" -c user.email="noreply@users.noreply.github.com" \
    commit -q -m "The grader, from the platform repository ($source_sha)"
  git -C "$work/repo" remote add origin "https://github.com/$repo.git"
  git -C "$work/repo" push -q -u origin main
  echo "Created https://github.com/$repo. Next: its Actions variables and secrets (docs/GITHUB_APP_SETUP.md §7)."
fi
