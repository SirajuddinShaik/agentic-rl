#!/usr/bin/env bash
set -euo pipefail

# Run on xyne-k8s-test. Recreates only the OCR autoscaler sidecar while
# preserving the current container environment and adding the cost config mount.

STACK_DIR="${STACK_DIR:-/home/shivral_somani_juspay_in/xyne-stack}"
CONTAINER_NAME="${CONTAINER_NAME:-xyne-ocr-autoscaler}"
IMAGE="${IMAGE:-xyne-sync-redis:codex-ocr-observability-1bdaf07a}"
NETWORK="${NETWORK:-xyne-stack_xyne}"
METRICS_PORT="${METRICS_PORT:-3021}"
HOTPATCH_DIR="${HOTPATCH_DIR:-${STACK_DIR}/runtime/autoscaler-redis-submitter-max-20260608T181258Z}"
COST_FILE="${COST_FILE:-/opt/monitoring/ocr-costs.json}"
ENV_FILE="${ENV_FILE:-}"

required_file() {
  local path="$1"
  if [[ ! -f "${path}" ]]; then
    echo "missing required file: ${path}" >&2
    exit 1
  fi
}

required_file "${HOTPATCH_DIR}/server/scripts/ocrAutoscaler.ts"
required_file "${HOTPATCH_DIR}/server/lib/ocrAutoscaler.ts"
required_file "${HOTPATCH_DIR}/server/lib/doclingRuntimeConfig.ts"
required_file "${HOTPATCH_DIR}/server/lib/ocrAutoscalerMetrics.ts"
required_file "${HOTPATCH_DIR}/bin/count-docling-submitters.sh"
required_file "${HOTPATCH_DIR}/bin/scale-docling-submitters.sh"
required_file "${COST_FILE}"

if [[ ! -S /var/run/docker.sock ]]; then
  echo "missing Docker socket: /var/run/docker.sock" >&2
  exit 1
fi

DOCKER_GID="$(stat -c %g /var/run/docker.sock)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
runtime_dir="${STACK_DIR}/runtime"
generated_env_file="${runtime_dir}/ocr-autoscaler-recreate-env-${timestamp}.env"
backup_name="${CONTAINER_NAME}-pre-recreate-${timestamp}"

sudo mkdir -p "${runtime_dir}"

if [[ -n "${ENV_FILE}" ]]; then
  required_file "${ENV_FILE}"
  sudo cp "${ENV_FILE}" "${generated_env_file}"
elif sudo docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
  sudo docker inspect "${CONTAINER_NAME}" \
    --format '{{range .Config.Env}}{{println .}}{{end}}' \
    > "${generated_env_file}"
else
  echo "no ENV_FILE provided and ${CONTAINER_NAME} does not exist to copy env from" >&2
  exit 1
fi

tmp_env="${generated_env_file}.tmp"
grep -v '^OCR_COST_CONFIG_PATH=' "${generated_env_file}" > "${tmp_env}" || true
printf 'OCR_COST_CONFIG_PATH=/etc/xyne/ocr-costs.json\n' >> "${tmp_env}"
sudo mv "${tmp_env}" "${generated_env_file}"
sudo chmod 600 "${generated_env_file}"

if sudo docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
  sudo docker stop "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  sudo docker rename "${CONTAINER_NAME}" "${backup_name}"
fi

sudo docker run -d \
  --name "${CONTAINER_NAME}" \
  --restart unless-stopped \
  --network "${NETWORK}" \
  --group-add "${DOCKER_GID}" \
  -p "${METRICS_PORT}:${METRICS_PORT}" \
  --env-file "${generated_env_file}" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "${HOTPATCH_DIR}/server/scripts/ocrAutoscaler.ts:/usr/src/app/server/scripts/ocrAutoscaler.ts:ro" \
  -v "${HOTPATCH_DIR}/server/lib/ocrAutoscaler.ts:/usr/src/app/server/lib/ocrAutoscaler.ts:ro" \
  -v "${HOTPATCH_DIR}/server/lib/doclingRuntimeConfig.ts:/usr/src/app/server/lib/doclingRuntimeConfig.ts:ro" \
  -v "${HOTPATCH_DIR}/server/lib/ocrAutoscalerMetrics.ts:/usr/src/app/server/lib/ocrAutoscalerMetrics.ts:ro" \
  -v "${HOTPATCH_DIR}/bin/count-docling-submitters.sh:/usr/local/bin/count-docling-submitters.sh:ro" \
  -v "${HOTPATCH_DIR}/bin/scale-docling-submitters.sh:/usr/local/bin/scale-docling-submitters.sh:ro" \
  -v "${COST_FILE}:/etc/xyne/ocr-costs.json:ro" \
  "${IMAGE}" \
  bun run scripts/ocrAutoscaler.ts

echo "started ${CONTAINER_NAME}"
echo "previous container: ${backup_name}"
echo "env file: ${generated_env_file}"
