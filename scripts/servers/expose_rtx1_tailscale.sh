#!/usr/bin/env bash
# Expose RTX1 loopback-only Polar services on its Tailscale IP without
# restarting the services or disturbing an active rollout.

set -Eeuo pipefail

TARGET_HOST="${TARGET_HOST:-rtx1}"
TAILSCALE_IP="${TAILSCALE_IP:-100.64.0.126}"
PORTS="${PORTS:-8081,8101,18114}"
CHECK_ONLY="${CHECK_ONLY:-0}"

usage() {
  cat <<'EOF'
Usage: scripts/servers/expose_rtx1_tailscale.sh [options]

Options:
  --host HOST   SSH target (default: rtx1)
  --ip IP       RTX1 Tailscale IPv4 address (default: 100.64.0.126)
  --ports LIST  Comma-separated loopback ports (default: 8081,8101,18114)
  --check-only  Do not start missing proxies; only report status
  -h, --help    Show this help
EOF
}

while (($#)); do
  case "$1" in
    --host) TARGET_HOST="${2:?missing HOST}"; shift 2 ;;
    --ip) TAILSCALE_IP="${2:?missing IP}"; shift 2 ;;
    --ports) PORTS="${2:?missing LIST}"; shift 2 ;;
    --check-only) CHECK_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

IFS=',' read -r -a PORT_LIST <<<"${PORTS}"

command -v ssh >/dev/null 2>&1 || {
  echo "Missing local command: ssh" >&2
  exit 2
}

remote_ip="$(ssh "${TARGET_HOST}" tailscale ip -4 | tail -n 1)"
if [[ "${remote_ip}" != "${TAILSCALE_IP}" ]]; then
  echo "Expected ${TARGET_HOST} Tailscale IP ${TAILSCALE_IP}, found ${remote_ip}" >&2
  exit 2
fi

ssh "${TARGET_HOST}" 'command -v socat >/dev/null && command -v ss >/dev/null' || {
  echo "socat and ss are required on ${TARGET_HOST}" >&2
  exit 2
}

failed=0
for port in "${PORT_LIST[@]}"; do
  if ssh "${TARGET_HOST}" "ss -ltn | grep -F '${TAILSCALE_IP}:${port}' >/dev/null"; then
    echo "UP   ${TARGET_HOST} ${TAILSCALE_IP}:${port} -> 127.0.0.1:${port}"
    continue
  fi

  if [[ "${CHECK_ONLY}" == "1" ]]; then
    echo "DOWN ${TARGET_HOST} ${TAILSCALE_IP}:${port} -> 127.0.0.1:${port}" >&2
    failed=1
    continue
  fi

  if ! ssh "${TARGET_HOST}" "ss -ltn | grep -F '127.0.0.1:${port}' >/dev/null"; then
    echo "No loopback listener on ${TARGET_HOST}:127.0.0.1:${port}" >&2
    failed=1
    continue
  fi

  ssh "${TARGET_HOST}" \
    "nohup socat TCP-LISTEN:${port},bind=${TAILSCALE_IP},fork,reuseaddr TCP:127.0.0.1:${port} >/tmp/agentic-rl-socat-${port}.log 2>&1 </dev/null &"
  sleep 1

  if ssh "${TARGET_HOST}" "ss -ltn | grep -F '${TAILSCALE_IP}:${port}' >/dev/null"; then
    echo "STARTED ${TARGET_HOST} ${TAILSCALE_IP}:${port} -> 127.0.0.1:${port}"
  else
    echo "FAILED ${TARGET_HOST} ${TAILSCALE_IP}:${port} -> 127.0.0.1:${port}" >&2
    failed=1
  fi
done

exit "${failed}"
