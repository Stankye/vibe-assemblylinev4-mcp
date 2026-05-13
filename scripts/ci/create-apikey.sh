#!/usr/bin/env bash
# Log into AL4 with username+password and mint an API key.
#
# AL4 4.7 endpoint:  PUT /api/v4/apikey/add/
#   body: { "priv": ["R","W"], "uname": "<user>", "key_name": "<name>",
#           "expiry_ts": "<iso>" | null }
#   response.api_response.keypassword = "<key_name>:<random_secret>"
#
# Required env:
#   AL4_URL             e.g. https://localhost
#   AL4_ADMIN_USER      e.g. admin
#   AL4_ADMIN_PASSWORD  e.g. admin
#   AL4_APIKEY_NAME     optional, default: cikey
#   AL4_APIKEY_DTL_DAYS optional, default: 1   (set to 0 for no expiry — only
#                       works if the server has apikey_max_dtl unset)

set -euo pipefail

AL4_URL="${AL4_URL:?AL4_URL must be set}"
AL4_ADMIN_USER="${AL4_ADMIN_USER:?AL4_ADMIN_USER must be set}"
AL4_ADMIN_PASSWORD="${AL4_ADMIN_PASSWORD:?AL4_ADMIN_PASSWORD must be set}"
KEYNAME="${AL4_APIKEY_NAME:-cikey}"
DTL_DAYS="${AL4_APIKEY_DTL_DAYS:-1}"

COOKIES=$(mktemp)
LOGIN_BODY=$(mktemp)
trap 'rm -f "$COOKIES" "$LOGIN_BODY"' EXIT

# Wait until the login endpoint accepts our credentials (UI bootstrap can lag
# a few seconds behind nginx coming up).
deadline=$(( $(date +%s) + 180 ))
while :; do
  status=$(curl -sk -o "$LOGIN_BODY" -w '%{http_code}' \
    -c "$COOKIES" \
    -H 'Content-Type: application/json' \
    -X POST "${AL4_URL}/api/v4/auth/login/" \
    --data "{\"user\":\"${AL4_ADMIN_USER}\",\"password\":\"${AL4_ADMIN_PASSWORD}\"}" \
    || echo 000)
  if [[ "$status" == "200" ]]; then
    break
  fi
  if (( $(date +%s) > deadline )); then
    echo "Login to AL4 failed after 3 min (status=$status):" >&2
    cat "$LOGIN_BODY" >&2 || true
    exit 1
  fi
  sleep 3
done

# Build the request body.  expiry_ts is required when the server enforces
# apikey_max_dtl; we send a near-future ISO timestamp by default which is
# always valid.
if [[ "$DTL_DAYS" -gt 0 ]]; then
  EXPIRY_TS=$(python3 -c "import datetime,sys; print((datetime.datetime.utcnow()+datetime.timedelta(days=int(sys.argv[1]))).strftime('%Y-%m-%dT%H:%M:%S.000000Z'))" "$DTL_DAYS")
  EXPIRY_FIELD="\"$EXPIRY_TS\""
else
  EXPIRY_FIELD="null"
fi

REQ_BODY=$(cat <<EOF
{
  "priv": ["R", "W"],
  "uname": "${AL4_ADMIN_USER}",
  "key_name": "${KEYNAME}",
  "expiry_ts": ${EXPIRY_FIELD}
}
EOF
)

# Mutating endpoints require the XSRF token from the login cookie echoed back
# as the X-XSRF-TOKEN header (see assemblyline_ui.api.base.api_login).
XSRF=$(awk '$6 == "XSRF-TOKEN" { print $7 }' "$COOKIES" | tail -1)
if [[ -z "$XSRF" ]]; then
  echo "Could not extract XSRF-TOKEN cookie from login response" >&2
  cat "$COOKIES" >&2
  exit 1
fi

# If a key with this name already exists from a prior CI run, delete it first.
# The key id is "<key_name>+<uname>" per assemblyline.odm.models.apikey.
KEY_ID="${KEYNAME}+${AL4_ADMIN_USER}"
curl -sk -b "$COOKIES" -H "X-XSRF-TOKEN: $XSRF" -X DELETE \
  "${AL4_URL}/api/v4/apikey/${KEY_ID}/" >/dev/null || true

RESP=$(curl -sk -b "$COOKIES" \
  -H 'Content-Type: application/json' \
  -H "X-XSRF-TOKEN: $XSRF" \
  -X PUT "${AL4_URL}/api/v4/apikey/add/" \
  --data "$REQ_BODY")

APIKEY=$(python3 - "$RESP" <<'PY'
import json, sys
try:
    d = json.loads(sys.argv[1])
except Exception as e:
    sys.exit(f"Could not parse apikey response as JSON: {e}\n{sys.argv[1][:500]}")
if isinstance(d.get("api_status_code"), int) and d["api_status_code"] >= 400:
    sys.exit(f"AL4 returned {d['api_status_code']}: {d.get('api_error_message','')}")
r = d.get("api_response") or {}
kp = r.get("keypassword") if isinstance(r, dict) else None
if not kp:
    sys.exit(f"Unexpected apikey response (no keypassword): {sys.argv[1][:500]}")
print(kp)
PY
)

if [[ -z "$APIKEY" ]]; then
  echo "Failed to mint apikey, response: $RESP" >&2
  exit 1
fi

# Tell GitHub Actions to redact this value from any subsequent log line.
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "::add-mask::$APIKEY"
  echo "apikey=$APIKEY" >> "$GITHUB_OUTPUT"
else
  echo "$APIKEY"
fi
