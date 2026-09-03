#!/usr/bin/env bash
set -euo pipefail

HEAD_IP="${RAY_HEAD_IP:-192.168.111.7}"
WORKER_IP="${RAY_WORKER_IP:-192.168.111.8}"
PORT="${RAY_PORT:-6379}"
MILES_CONTAINER="${MILES_CONTAINER:-miles-never-delete}"
: "${ALLOW_RAY_RESTART:?Set ALLOW_RAY_RESTART=1 after confirming no Ray job is running}"
[[ "${ALLOW_RAY_RESTART}" == "1" ]] || { echo "ALLOW_RAY_RESTART must equal 1" >&2; exit 1; }

start_ray() {
  ray stop --force >/dev/null 2>&1 || true
  CUDA_VISIBLE_DEVICES=4,5,6,7 ray start \
    --address="${HEAD_IP}:${PORT}" \
    --node-ip-address="${WORKER_IP}" \
    --num-gpus=4 \
    --disable-usage-stats
}

if command -v ray >/dev/null 2>&1; then
  start_ray
elif command -v docker >/dev/null 2>&1 && docker inspect "${MILES_CONTAINER}" >/dev/null 2>&1; then
  docker exec \
    -e RAY_HEAD_IP="${HEAD_IP}" \
    -e RAY_WORKER_IP="${WORKER_IP}" \
    -e RAY_PORT="${PORT}" \
    "${MILES_CONTAINER}" bash -lc '
      ray stop --force >/dev/null 2>&1 || true
      CUDA_VISIBLE_DEVICES=4,5,6,7 ray start \
        --address="$RAY_HEAD_IP:$RAY_PORT" \
        --node-ip-address="$RAY_WORKER_IP" \
        --num-gpus=4 \
        --disable-usage-stats
    '
else
  echo "Ray is unavailable and container ${MILES_CONTAINER} is not running" >&2
  exit 1
fi
