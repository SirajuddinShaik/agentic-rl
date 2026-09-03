#!/usr/bin/env bash
# Start the reproducible current Xyne -> Polar session proxy (:18114 -> :8101).
# This is deliberately idempotent: an already-healthy live proxy is not restarted.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../.." && pwd)"
runtime_dir="${repo_root}/.runtime"
proxy_script="${POLAR_SESSION_PROXY_SCRIPT:-${repo_root}/polar/src/polar/xyne/session_proxy.py}"
runtime_proxy_script="${runtime_dir}/session-proxy-v34.py"

export POLAR_SESSION_PROXY_HOST="${POLAR_SESSION_PROXY_HOST:-127.0.0.1}"
export POLAR_SESSION_PROXY_PORT="${POLAR_SESSION_PROXY_PORT:-18114}"
export POLAR_SESSION_PROXY_UPSTREAM="${POLAR_SESSION_PROXY_UPSTREAM:-http://127.0.0.1:8101}"
export POLAR_SESSION_PROXY_TIMEOUT_SECONDS="${POLAR_SESSION_PROXY_TIMEOUT_SECONDS:-7200}"
export POLAR_SESSION_PROXY_DEFAULT_MAX_TOKENS="${POLAR_SESSION_PROXY_DEFAULT_MAX_TOKENS:-16384}"
export POLAR_SESSION_PROXY_MAX_TOKENS="${POLAR_SESSION_PROXY_MAX_TOKENS:-16384}"
export POLAR_SESSION_ROUTES_PATH="${POLAR_SESSION_ROUTES_PATH:-/tmp/polar_session_routes.json}"
export POLAR_SESSION_ROUTES_LOCK_PATH="${POLAR_SESSION_ROUTES_LOCK_PATH:-/tmp/polar_session_routes.lock}"

for command in python3 curl; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "MISSING command: $command" >&2
    exit 2
  }
done
test -f "${proxy_script}" || {
  echo "MISSING session proxy: ${proxy_script}" >&2
  exit 2
}

mkdir -p "${runtime_dir}"
health_host="127.0.0.1"
if [[ "${POLAR_SESSION_PROXY_HOST}" != "0.0.0.0" ]]; then
  health_host="${POLAR_SESSION_PROXY_HOST}"
fi
health_url="http://${health_host}:${POLAR_SESSION_PROXY_PORT}/health"

if curl -fsS --max-time 2 "${health_url}" >/dev/null 2>&1; then
  echo "Session proxy already healthy: ${health_url}"
  exit 0
fi

# Execute from .runtime so the adjacent polar/xyne/types.py cannot shadow
# Python's stdlib types module when this script is run from the repository.
cp "${proxy_script}" "${runtime_proxy_script}"
nohup python3 "${runtime_proxy_script}" \
  >"${runtime_dir}/session-proxy-v34.log" 2>&1 &
proxy_pid=$!
echo "${proxy_pid}" >"${runtime_dir}/session-proxy-v34.pid"

for _attempt in {1..20}; do
  if curl -fsS --max-time 2 "${health_url}" >/dev/null; then
    echo "Session proxy healthy: ${health_url} (pid ${proxy_pid})"
    exit 0
  fi
  sleep 0.25
done

echo "Session proxy failed to become healthy: ${health_url}" >&2
if kill -0 "${proxy_pid}" 2>/dev/null; then
  kill "${proxy_pid}" 2>/dev/null || true
fi
tail -n 50 "${runtime_dir}/session-proxy-v34.log" >&2 || true
exit 1
