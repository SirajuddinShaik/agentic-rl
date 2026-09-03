#!/usr/bin/env bash
set -euo pipefail

: "${XYNE_SERVER_DIR:?Set XYNE_SERVER_DIR}"
: "${XYNE_BACKEND_LOG:?Set XYNE_BACKEND_LOG}"
: "${ACCESS_TOKEN_SECRET:?Set ACCESS_TOKEN_SECRET}"
: "${JWT_SECRET:?Set JWT_SECRET}"
: "${DATABASE_URL:?Set DATABASE_URL}"

backend_dir="${XYNE_SERVER_DIR}/server"
[[ -f "${backend_dir}/app/server.ts" ]] || {
  echo "XYNE backend not found under ${backend_dir}" >&2
  exit 2
}

command -v bun >/dev/null || {
  echo "bun is required to start the XYNE backend." >&2
  exit 1
}

mkdir -p "$(dirname -- "$XYNE_BACKEND_LOG")"
cd "$backend_dir"
nohup bun app/server.ts > "$XYNE_BACKEND_LOG" 2>&1 &
backend_pid=$!
echo "$backend_pid" > "${XYNE_BACKEND_LOG}.pid"
echo "XYNE backend launched with PID ${backend_pid}; log: ${XYNE_BACKEND_LOG}"
