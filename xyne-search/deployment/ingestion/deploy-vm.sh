#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

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
VM_DEPLOY_DIR="${VM_DEPLOY_DIR:-/home/aayush_shah_juspay_in/xyne-ingestion-deploy}"
INGESTION_IMAGE_REPO="${INGESTION_IMAGE_REPO:-xyne-ingestion}"
INGESTION_DEPLOY_INCLUDE_APP_SYNC="${INGESTION_DEPLOY_INCLUDE_APP_SYNC:-false}"
INGESTION_DRY_RUN="${INGESTION_DRY_RUN:-false}"

if [[ -n "${CLOUDSDK_PYTHON:-}" ]]; then
  export CLOUDSDK_PYTHON
fi

git_sha="$(git -C "${REPO_ROOT}" rev-parse --short=12 HEAD 2>/dev/null || echo nogit)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
image_tag="${INGESTION_IMAGE_TAG:-${git_sha}-${timestamp}}"
image="${INGESTION_IMAGE_REPO}:${image_tag}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT
image_tar="${tmp_dir}/ingestion-image-${image_tag}.tar.gz"
context_tar="${tmp_dir}/ingestion-context-${image_tag}.tar.gz"
build_on_vm="${INGESTION_BUILD_ON_VM:-false}"

if [[ "${INGESTION_DRY_RUN}" == "true" ]]; then
  image="${INGESTION_IMAGE_REPO}:dry-run"
  image_tar=""
  context_tar=""
else
  if [[ "${build_on_vm}" != "true" ]] && docker info >/dev/null 2>&1; then
    echo "Building ${image}"
    docker build -f "${SCRIPT_DIR}/Dockerfile" -t "${image}" "${REPO_ROOT}"
    docker save "${image}" | gzip > "${image_tar}"
  else
    build_on_vm="true"
    image_tar=""
    echo "Local Docker is unavailable or INGESTION_BUILD_ON_VM=true; packaging local source for VM build"
    COPYFILE_DISABLE=1 tar --no-xattrs -C "${REPO_ROOT}" \
      --exclude .git \
      --exclude .codex-vm-audits \
      --exclude '*/node_modules' \
      --exclude 'server/__pycache__' \
      --exclude 'server/scripts/__pycache__' \
      --exclude vm-images \
      --exclude eval-results \
      --exclude storage \
      -czf "${context_tar}" .
  fi
fi

echo "Running VM backup"
"${SCRIPT_DIR}/backup-vm.sh"

echo "Copying deployment files to ${GCP_VM}:${VM_DEPLOY_DIR}"
"${GCLOUD}" compute ssh "${GCP_VM}" \
  --project="${GCP_PROJECT}" \
  --zone="${GCP_ZONE}" \
  --quiet \
  --tunnel-through-iap \
  --command="mkdir -p '${VM_DEPLOY_DIR}/bin'"

if [[ "${INGESTION_DRY_RUN}" == "true" ]]; then
  "${GCLOUD}" compute scp \
    "${SCRIPT_DIR}/docker-compose.yml" \
    "${SCRIPT_DIR}/bin/count-docling-submitters.sh" \
    "${SCRIPT_DIR}/bin/scale-docling-submitters.sh" \
    "${GCP_VM}:${VM_DEPLOY_DIR}/" \
    --project="${GCP_PROJECT}" \
    --zone="${GCP_ZONE}" \
    --quiet \
    --tunnel-through-iap
elif [[ "${build_on_vm}" == "true" ]]; then
  "${GCLOUD}" compute scp "${context_tar}" \
    "${SCRIPT_DIR}/docker-compose.yml" \
    "${SCRIPT_DIR}/bin/count-docling-submitters.sh" \
    "${SCRIPT_DIR}/bin/scale-docling-submitters.sh" \
    "${GCP_VM}:${VM_DEPLOY_DIR}/" \
    --project="${GCP_PROJECT}" \
    --zone="${GCP_ZONE}" \
    --quiet \
    --tunnel-through-iap
else
  "${GCLOUD}" compute scp "${image_tar}" \
    "${SCRIPT_DIR}/docker-compose.yml" \
    "${SCRIPT_DIR}/bin/count-docling-submitters.sh" \
    "${SCRIPT_DIR}/bin/scale-docling-submitters.sh" \
    "${GCP_VM}:${VM_DEPLOY_DIR}/" \
    --project="${GCP_PROJECT}" \
    --zone="${GCP_ZONE}" \
    --quiet \
    --tunnel-through-iap
fi

remote_script='
set -euo pipefail
STACK_DIR="__STACK_DIR__"
DEPLOY_DIR="__DEPLOY_DIR__"
IMAGE="__IMAGE__"
IMAGE_TAR="__IMAGE_TAR__"
CONTEXT_TAR="__CONTEXT_TAR__"
BUILD_ON_VM="__BUILD_ON_VM__"
INCLUDE_APP_SYNC="__INCLUDE_APP_SYNC__"
DRY_RUN="__DRY_RUN__"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
COMPOSE_ARGS="-p xyne-stack -f ${STACK_DIR}/docker-compose.ingestion.yml"
RUNNING_SERVICES="app-sync-result-worker docling-scheduler-splitter docling-scheduler-submitter docling-scheduler-result docling-scheduler-result-2 docling-scheduler-result-3 docling-scheduler-result-4 docling-scheduler-writer docling-scheduler-reaper ocr-autoscaler"
SPARE_SERVICES="$(for i in $(seq 2 30); do printf "docling-scheduler-submitter-%s " "$i"; done)"
WATCH_UNRELATED="xyne-app xyne-db xyne-redis vespa entrag-vespa prometheus grafana xyne-alloy xyne-loki cadvisor-new node-exporter postgres-exporter redis-exporter xyne-caddy"
STATE_DIR="${DEPLOY_DIR}/state-${TS}"

cd "${STACK_DIR}"
mkdir -p "${STATE_DIR}"
sudo mkdir -p "${STACK_DIR}/deployment/ingestion/bin"
sudo cp "${DEPLOY_DIR}/docker-compose.yml" "${STACK_DIR}/docker-compose.ingestion.yml"
sudo cp "${DEPLOY_DIR}/count-docling-submitters.sh" "${STACK_DIR}/deployment/ingestion/bin/count-docling-submitters.sh"
sudo cp "${DEPLOY_DIR}/scale-docling-submitters.sh" "${STACK_DIR}/deployment/ingestion/bin/scale-docling-submitters.sh"
sudo chmod +x "${STACK_DIR}/deployment/ingestion/bin/"*.sh

before_file="${STATE_DIR}/unrelated-started-before.txt"
after_file="${STATE_DIR}/unrelated-started-after.txt"
for c in ${WATCH_UNRELATED}; do
  if sudo docker inspect "${c}" >/dev/null 2>&1; then
    sudo docker inspect "${c}" --format "{{.Name}} {{.State.StartedAt}}" >> "${before_file}"
  fi
done

socket_gid="$(stat -c %g /var/run/docker.sock)"
export INGESTION_IMAGE="${IMAGE}"
export DOCKER_SOCKET_GID="${socket_gid}"
export INGESTION_HELPER_DIR="${STACK_DIR}/deployment/ingestion/bin"
export XYNE_DOCKER_NETWORK="${XYNE_DOCKER_NETWORK:-xyne-stack_xyne}"

compose() {
  sudo env \
    INGESTION_IMAGE="${INGESTION_IMAGE}" \
    DOCKER_SOCKET_GID="${DOCKER_SOCKET_GID}" \
    INGESTION_HELPER_DIR="${INGESTION_HELPER_DIR}" \
    XYNE_DOCKER_NETWORK="${XYNE_DOCKER_NETWORK}" \
    docker compose ${COMPOSE_ARGS} "$@"
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

  echo "Renaming legacy manual xyne-ocr-autoscaler before compose takeover"
  sudo docker stop xyne-ocr-autoscaler >/dev/null 2>&1 || true
  sudo docker rename xyne-ocr-autoscaler "xyne-ocr-autoscaler-pre-ingestion-${TS}"
}

compose config >/dev/null

if [[ "${DRY_RUN}" == "true" ]]; then
  echo "Dry run complete: compose config and backup succeeded."
  exit 0
fi

if [[ "${BUILD_ON_VM}" == "true" ]]; then
  build_dir="${DEPLOY_DIR}/build-context-${TS}"
  rm -rf "${build_dir}"
  mkdir -p "${build_dir}"
  tar -xzf "${DEPLOY_DIR}/${CONTEXT_TAR}" -C "${build_dir}"
  sudo docker build -f "${build_dir}/deployment/ingestion/Dockerfile" -t "${IMAGE}" "${build_dir}"
else
  sudo docker load -i "${DEPLOY_DIR}/${IMAGE_TAR}"
fi

compose --profile submitter-spares create --force-recreate ${SPARE_SERVICES}

rename_legacy_autoscaler

if [[ "${INCLUDE_APP_SYNC}" == "true" ]]; then
  RUNNING_SERVICES="app-sync ${RUNNING_SERVICES}"
fi

compose up -d --no-deps --force-recreate ${RUNNING_SERVICES}

echo "Container status"
sudo docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Image}}" |
  grep -E "^(NAMES|xyne-app-sync|xyne-stack-app-sync-result-worker-1|docling-scheduler-|xyne-ocr-autoscaler)"

echo "Autoscaler metrics"
metrics_file="${STATE_DIR}/autoscaler-metrics.txt"
for attempt in $(seq 1 18); do
  if curl -fsS http://127.0.0.1:3021/metrics > "${metrics_file}"; then
    break
  fi
  if [[ "${attempt}" == "18" ]]; then
    echo "ERROR: autoscaler metrics endpoint did not become ready" >&2
    sudo docker logs --tail=80 xyne-ocr-autoscaler 2>&1 || true
    exit 1
  fi
  sleep 10
done
grep -E "xyne_ocr_autoscaler_snapshot_ready|xyne_ocr_decision|xyne_ocr_submitter_containers" "${metrics_file}" |
  head -40

echo "Redis scheduler state"
sudo docker exec xyne-redis sh -lc '"'"'
echo runtime_fields=$(redis-cli HLEN docling:runtime-config)
echo results_len=$(redis-cli XLEN docling:results)
echo request_permits=$(redis-cli ZCARD docling:scheduler:permit:ocr-submit:active 2>/dev/null || true)
echo page_permits=$(redis-cli ZCARD docling:scheduler:permit:ocr-submit-pages:active 2>/dev/null || true)
redis-cli XINFO GROUPS docling:results
'"'"'

echo "Docling DB status"
sudo docker exec xyne-db psql -U xyne -d xyne -P pager=off -c "
select status, count(*) as count
from docling_async_files
group by status
order by count desc;
"

for c in ${WATCH_UNRELATED}; do
  if sudo docker inspect "${c}" >/dev/null 2>&1; then
    sudo docker inspect "${c}" --format "{{.Name}} {{.State.StartedAt}}" >> "${after_file}"
  fi
done

if ! diff -u "${before_file}" "${after_file}"; then
  echo "ERROR: unrelated container start times changed" >&2
  exit 1
fi

echo "Recent ingestion logs"
for c in xyne-ocr-autoscaler docling-scheduler-splitter docling-scheduler-submitter docling-scheduler-result docling-scheduler-writer docling-scheduler-reaper xyne-stack-app-sync-result-worker-1; do
  echo "==== ${c}"
  sudo docker logs --tail=30 "${c}" 2>&1 || true
done
'

remote_script="${remote_script//__STACK_DIR__/${VM_STACK_DIR}}"
remote_script="${remote_script//__DEPLOY_DIR__/${VM_DEPLOY_DIR}}"
remote_script="${remote_script//__IMAGE__/${image}}"
if [[ -n "${image_tar}" ]]; then
  remote_script="${remote_script//__IMAGE_TAR__/$(basename "${image_tar}")}"
else
  remote_script="${remote_script//__IMAGE_TAR__/}"
fi
if [[ -n "${context_tar}" ]]; then
  remote_script="${remote_script//__CONTEXT_TAR__/$(basename "${context_tar}")}"
else
  remote_script="${remote_script//__CONTEXT_TAR__/}"
fi
remote_script="${remote_script//__BUILD_ON_VM__/${build_on_vm}}"
remote_script="${remote_script//__INCLUDE_APP_SYNC__/${INGESTION_DEPLOY_INCLUDE_APP_SYNC}}"
remote_script="${remote_script//__DRY_RUN__/${INGESTION_DRY_RUN}}"

"${GCLOUD}" compute ssh "${GCP_VM}" \
  --project="${GCP_PROJECT}" \
  --zone="${GCP_ZONE}" \
  --quiet \
  --tunnel-through-iap \
  --command="${remote_script}"
