#!/usr/bin/env bash
set -euo pipefail

failed=0

probe() {
  local name="$1"
  local url="$2"
  if curl -fsS --max-time 5 "$url" >/dev/null; then
    echo "UP   ${name} ${url}"
  else
    echo "DOWN ${name} ${url}" >&2
    failed=1
  fi
}

probe "SGLang" "${SGLANG_BASE_URL:-http://100.64.0.149:30100}/v1/models"
probe "XYNE" "${XYNE_BASE_URL:-http://100.64.0.126:3103}/v2/health"
probe "Polar rollout" "${POLAR_ROLLOUT_URL:-http://100.64.0.126:8081}/health"
probe "Polar gateway" "${POLAR_GATEWAY_URL:-http://100.64.0.126:8101}/health"
probe "Session proxy" "${SESSION_PROXY_URL:-http://100.64.0.126:18114}/health"
probe "Vespa query" "http://${VESPA_HOST:-127.0.0.1}:${VESPA_QUERY_PORT:-18081}/state/v1/health"
probe "Vespa feed" "http://${VESPA_HOST:-127.0.0.1}:${VESPA_FEED_PORT:-18080}"

if [[ -n "${RERANKER_PORT:-}" ]]; then
  probe "TEI reranker" "http://${RERANKER_HOST:-127.0.0.1}:${RERANKER_PORT}/info"
fi

if command -v pg_isready >/dev/null; then
  if pg_isready -h "${POSTGRES_HOST:-127.0.0.1}" -p "${POSTGRES_PORT:-15432}" \
      -d "${POSTGRES_DB:-xyne}" -U "${POSTGRES_USER:-xyne}" >/dev/null; then
    echo "UP   Postgres ${POSTGRES_HOST:-127.0.0.1}:${POSTGRES_PORT:-15432}"
  else
    echo "DOWN Postgres ${POSTGRES_HOST:-127.0.0.1}:${POSTGRES_PORT:-15432}" >&2
    failed=1
  fi
fi

exit "$failed"
