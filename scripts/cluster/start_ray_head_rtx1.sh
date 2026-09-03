#!/usr/bin/env bash
set -euo pipefail

HEAD_IP="${RAY_HEAD_IP:-192.168.111.7}"
PORT="${RAY_PORT:-6379}"
DASHBOARD_PORT="${RAY_DASHBOARD_PORT:-8265}"
MILES_CONTAINER="${MILES_CONTAINER:-miles-never-delete}"
: "${ALLOW_RAY_RESTART:?Set ALLOW_RAY_RESTART=1 after confirming no Ray job is running}"
[[ "${ALLOW_RAY_RESTART}" == "1" ]] || { echo "ALLOW_RAY_RESTART must equal 1" >&2; exit 1; }

start_ray() {
  ray stop --force >/dev/null 2>&1 || true
  CUDA_VISIBLE_DEVICES=0,1,2,3,4,5,6,7 ray start \
    --head \
    --node-ip-address="${HEAD_IP}" \
    --port="${PORT}" \
    --dashboard-host=0.0.0.0 \
    --dashboard-port="${DASHBOARD_PORT}" \
    --num-gpus=8 \
    --disable-usage-stats
}

if command -v ray >/dev/null 2>&1; then
  start_ray
elif command -v docker >/dev/null 2>&1 && docker inspect "${MILES_CONTAINER}" >/dev/null 2>&1; then
  docker exec \
    -e RAY_HEAD_IP="${HEAD_IP}" \
    -e RAY_PORT="${PORT}" \
    -e RAY_DASHBOARD_PORT="${DASHBOARD_PORT}" \
    "${MILES_CONTAINER}" bash -lc '
      ray stop --force >/dev/null 2>&1 || true
      CUDA_VISIBLE_DEVICES=0,1,2,3,4,5,6,7 ray start \
        --head \
        --node-ip-address="$RAY_HEAD_IP" \
        --port="$RAY_PORT" \
        --dashboard-host=0.0.0.0 \
        --dashboard-port="$RAY_DASHBOARD_PORT" \
        --num-gpus=8 \
        --disable-usage-stats
    '
else
  echo "Ray is unavailable and container ${MILES_CONTAINER} is not running" >&2
  exit 1
fi
