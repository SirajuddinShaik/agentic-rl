#!/usr/bin/env bash
set -euo pipefail

EXPECTED_GPUS="${EXPECTED_RAY_GPUS:-12}"
MILES_CONTAINER="${MILES_CONTAINER:-miles-never-delete}"

if command -v ray >/dev/null 2>&1; then
  status="$(ray status)"
elif command -v docker >/dev/null 2>&1 && docker inspect "${MILES_CONTAINER}" >/dev/null 2>&1; then
  status="$(docker exec "${MILES_CONTAINER}" ray status)"
else
  echo "Ray is unavailable and container ${MILES_CONTAINER} is not running" >&2
  exit 1
fi
printf '%s\n' "${status}"
grep -Eq "[0-9.]+/${EXPECTED_GPUS}\.0 GPU" <<<"${status}" || {
  echo "Ray does not expose the expected ${EXPECTED_GPUS} GPUs" >&2
  exit 1
}
