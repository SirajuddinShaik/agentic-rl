#!/usr/bin/env bash
#
# wait-for-xyne.sh — poll the Xyne backend health endpoint until it is healthy
# or a timeout elapses.
#
#   -H <host:port>   host:port of the Xyne backend (default: localhost:3000)
#   -t <seconds>     overall timeout in seconds (default: 60)
#   -i <seconds>     interval between polls in seconds (default: 2)
#
# Exit 0 when the endpoint reports healthy; exit 1 on timeout (with a clear
# message on stderr).

set -euo pipefail

HOST_PORT="localhost:3000"
TIMEOUT_SECS=60
INTERVAL_SECS=2

usage() {
    echo "usage: $0 [-H host:port] [-t timeout-secs] [-i interval-secs]" >&2
    exit 2
}

while getopts "H:t:i:h" opt; do
    case "$opt" in
        H) HOST_PORT="$OPTARG" ;;
        t) TIMEOUT_SECS="$OPTARG" ;;
        i) INTERVAL_SECS="$OPTARG" ;;
        h) usage ;;
        *) usage ;;
    esac
done

URL="http://${HOST_PORT}/v2/health"

if ! [[ "$TIMEOUT_SECS" =~ ^[0-9]+$ ]] || [[ "$TIMEOUT_SECS" -le 0 ]]; then
    echo "error: -t must be a positive integer" >&2
    exit 2
fi

START=$(date +%s)
while :; do
    NOW=$(date +%s)
    ELAPSED=$((NOW - START))
    if [ "$ELAPSED" -ge "$TIMEOUT_SECS" ]; then
        echo "TIMEOUT: Xyne not healthy at $URL after ${TIMEOUT_SECS}s" >&2
        exit 1
    fi

    if curl -fsS --max-time 5 "$URL" >/dev/null 2>&1; then
        echo "Xyne healthy at $URL"
        exit 0
    fi

    sleep "$INTERVAL_SECS"
done
