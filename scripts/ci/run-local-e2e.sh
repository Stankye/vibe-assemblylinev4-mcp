#!/usr/bin/env bash
# Local equivalent of .github/workflows/e2e.yml.
#
# Brings up the AL4 appliance, mints an API key, runs the e2e suite, then
# tears the appliance back down.  Mirrors the workflow step-for-step so the
# same script that works on your laptop works in CI.
#
# Requirements (host):
#   - bash, curl, openssl, git, python3
#   - docker + docker compose plugin
#   - node 20+ and npm
#   - ~15 GB free disk
#
# Usage:
#   bash scripts/ci/run-local-e2e.sh           # full cycle, with teardown
#   KEEP_RUNNING=1 bash scripts/ci/run-local-e2e.sh  # leave appliance up for poking
#   SKIP_BUILD=1 bash scripts/ci/run-local-e2e.sh    # reuse dist/ from a prior build
#
# Optional env (defaults match the workflow):
#   AL4_ADMIN_USER, AL4_ADMIN_PASSWORD, AL4_URL, AL4_COMPOSE_REF

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

export AL4_ADMIN_USER="${AL4_ADMIN_USER:-admin}"
export AL4_ADMIN_PASSWORD="${AL4_ADMIN_PASSWORD:-admin}"
export AL4_URL="${AL4_URL:-https://localhost}"
export AL4_TLS_VERIFY="${AL4_TLS_VERIFY:-false}"
export RUNNER_TEMP="${RUNNER_TEMP:-${TMPDIR:-/tmp}/al4-ci}"
mkdir -p "$RUNNER_TEMP"

teardown() {
  if [[ "${KEEP_RUNNING:-0}" == "1" ]]; then
    echo "── KEEP_RUNNING=1 — leaving appliance up at $AL4_URL"
    return
  fi
  local WORK="$RUNNER_TEMP/al4-appliance"
  if [[ -d "$WORK" ]]; then
    echo "── Tearing down appliance"
    (cd "$WORK" && docker compose down -v --remove-orphans) || true
  fi
}
trap teardown EXIT

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "── npm ci && build"
  npm ci
  npm run build
fi

echo "── Starting AL4 appliance"
bash scripts/ci/start-al4.sh

echo "── Minting API key"
APIKEY="$(bash scripts/ci/create-apikey.sh)"
export AL4_USERNAME="$AL4_ADMIN_USER"
export AL4_APIKEY="$APIKEY"

echo "── Running E2E suite"
node dist/test/e2e.js
