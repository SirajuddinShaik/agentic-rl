#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${SCRIPT_DIR}/.env.local"
  set +a
fi

GCLOUD="${GCLOUD:-gcloud}"
GCP_PROJECT="${GCP_PROJECT:-xyne-spaces-sbx}"
GCP_ZONE="${GCP_ZONE:-asia-southeast1-a}"
GCP_VM="${GCP_VM:-xyne-k8s-test}"
VM_STACK_DIR="${VM_STACK_DIR:-/home/shivral_somani_juspay_in/xyne-stack}"
ROLLBACK_IMAGE="${ROLLBACK_IMAGE:?set ROLLBACK_IMAGE to the previous ingestion image tag}"

if [[ -n "${CLOUDSDK_PYTHON:-}" ]]; then
  export CLOUDSDK_PYTHON
fi

remote_script='
set -euo pipefail
STACK_DIR="__STACK_DIR__"
IMAGE="__IMAGE__"
cd "${STACK_DIR}"
export INGESTION_IMAGE="${IMAGE}"
export DOCKER_SOCKET_GID="$(stat -c %g /var/run/docker.sock)"
export INGESTION_HELPER_DIR="${STACK_DIR}/deployment/ingestion/bin"
SERVICES="app-sync-result-worker docling-scheduler-splitter docling-scheduler-submitter docling-scheduler-result docling-scheduler-result-2 docling-scheduler-result-3 docling-scheduler-result-4 docling-scheduler-writer docling-scheduler-reaper ocr-autoscaler"

compose() {
  sudo env \
    INGESTION_IMAGE="${INGESTION_IMAGE}" \
    DOCKER_SOCKET_GID="${DOCKER_SOCKET_GID}" \
    INGESTION_HELPER_DIR="${INGESTION_HELPER_DIR}" \
    XYNE_DOCKER_NETWORK="${XYNE_DOCKER_NETWORK:-xyne-stack_xyne}" \
    docker compose -p xyne-stack -f "${STACK_DIR}/docker-compose.ingestion.yml" "$@"
}

rename_legacy_autoscaler() {
  if ! sudo docker inspect xyne-ocr-autoscaler >/dev/null 2>&1; then
    return 0
  fi

  local project service
  project="$(sudo docker inspect xyne-ocr-autoscaler --format "{{ index .Config.Labels \"com.docker.compose.project\" }}" 2>/dev/null || true)"
  service="$(sudo docker inspect xyne-ocr-autoscaler --format "{{ index .Config.Labels \"com.docker.compose.service\" }}" 2>/dev/null || true)"
  if [[ "${project}" == "xyne-stack" && "${service}" == "ocr-autoscaler" ]]; then
    echo "Existing xyne-ocr-autoscaler is already compose-managed; compose will recreate it."
    return 0
  fi

  local ts
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  echo "Renaming legacy manual xyne-ocr-autoscaler before rollback compose takeover"
  sudo docker stop xyne-ocr-autoscaler >/dev/null 2>&1 || true
  sudo docker rename xyne-ocr-autoscaler "xyne-ocr-autoscaler-pre-rollback-${ts}"
}

rename_legacy_autoscaler

compose up -d --no-deps --force-recreate ${SERVICES}
sudo docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Image}}" |
  grep -E "^(NAMES|xyne-stack-app-sync-result-worker-1|docling-scheduler-|xyne-ocr-autoscaler)"
curl -fsS http://127.0.0.1:3021/metrics | head
'

remote_script="${remote_script//__STACK_DIR__/${VM_STACK_DIR}}"
remote_script="${remote_script//__IMAGE__/${ROLLBACK_IMAGE}}"

"${GCLOUD}" compute ssh "${GCP_VM}" \
  --project="${GCP_PROJECT}" \
  --zone="${GCP_ZONE}" \
  --quiet \
  --tunnel-through-iap \
  --command="${remote_script}"
