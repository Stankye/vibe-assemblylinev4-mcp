#!/usr/bin/env bash
# Bring up a minimal Assemblyline 4 appliance for CI.
#
# - Clones (or reuses) the CybercentreCanada/assemblyline-docker-compose repo at
#   the version pinned below.
# - Configures it for a single-host CI environment (DOMAIN=localhost,
#   self-signed cert, minimal profile, no metrics).
# - Brings up only the *core* stack (no service registration) — services are
#   not needed to validate the MCP server's API plumbing, and pulling the ~50
#   per-service images would blow past the runner's disk quota.
# - Runs the bootstrap.py one-shot to create the admin user.
#
# Outputs (via $GITHUB_OUTPUT when run from a workflow step):
#   al4_dir   path to the cloned appliance
#
# Required env (with defaults):
#   AL4_COMPOSE_REF     git ref of assemblyline-docker-compose (default: master)
#   AL4_ADMIN_USER      admin username (default: admin)
#   AL4_ADMIN_PASSWORD  admin password (default: admin)

set -euo pipefail

AL4_COMPOSE_REF="${AL4_COMPOSE_REF:-master}"
AL4_ADMIN_USER="${AL4_ADMIN_USER:-admin}"
AL4_ADMIN_PASSWORD="${AL4_ADMIN_PASSWORD:-admin}"

WORK="${AL4_WORK_DIR:-$RUNNER_TEMP/al4-appliance}"
mkdir -p "$WORK"

if [[ ! -d "$WORK/.git" ]]; then
  echo "── Cloning assemblyline-docker-compose@${AL4_COMPOSE_REF} into $WORK"
  git clone --depth 1 --branch "$AL4_COMPOSE_REF" \
    https://github.com/CybercentreCanada/assemblyline-docker-compose.git "$WORK"
fi

cd "$WORK"

# Override domain / credentials.  Keep the upstream defaults for everything else.
cat > .env.ci <<EOF
DOMAIN=localhost
AL_ADMIN_USER=${AL4_ADMIN_USER}
AL_ADMIN_PASSWORD=${AL4_ADMIN_PASSWORD}
ELASTIC_MEM=1536
COMPOSE_PROFILES=minimal
EOF

# Merge the override on top of the shipped .env.
cat .env.ci >> .env

# Generate a self-signed cert that matches DOMAIN=localhost.
# shellcheck disable=SC1091  # .env is created by the upstream repo at clone time
source .env
openssl req -nodes -x509 -newkey rsa:2048 \
  -keyout ./config/nginx.key -out ./config/nginx.crt \
  -days 365 -subj "/C=CA/ST=Ontario/L=Ottawa/O=CCCS/CN=${DOMAIN}" \
  >/dev/null 2>&1

echo "── Pulling images (core stack only)"
docker compose pull --ignore-buildable --quiet

echo "── Starting core stack"
docker compose up -d

echo "── Waiting for nginx → API to respond on https://localhost"
deadline=$(( $(date +%s) + 600 ))
until curl -sk --max-time 5 https://localhost/api/v4/ | grep -q 'api_response\|api_status_code'; do
  if (( $(date +%s) > deadline )); then
    echo "AL4 API did not come up within 10 minutes" >&2
    docker compose ps
    docker compose logs --tail=200 nginx ui_minimal elasticsearch_minimal || true
    exit 1
  fi
  sleep 5
done
echo "── API is up"

echo "── Running bootstrap.py to create admin user"
docker compose -f bootstrap-compose.yaml run --rm first_time_setup

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "al4_dir=$WORK" >> "$GITHUB_OUTPUT"
fi

echo "── AL4 appliance ready"
