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
VM_BACKUP_ROOT="${VM_BACKUP_ROOT:-/home/aayush_shah_juspay_in/xyne-ingestion-backups}"

if [[ -n "${CLOUDSDK_PYTHON:-}" ]]; then
  export CLOUDSDK_PYTHON
fi

remote_script='
set -euo pipefail
STACK_DIR="__STACK_DIR__"
BACKUP_ROOT="__BACKUP_ROOT__"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${BACKUP_ROOT}/ingestion-deploy-${TS}"
mkdir -p "${BACKUP_DIR}/files" "${BACKUP_DIR}/docker-inspect" "${BACKUP_DIR}/container-env" "${BACKUP_DIR}/logs"

cd "${STACK_DIR}"
sudo find . -maxdepth 3 \
  \( -path ./data -o -path ./data/postgres-data -o -path ./caddy_data -o -path ./backups \) -prune -o \
  \( -name "docker-compose*.yml" -o -name "docker-compose*.yaml" -o -name ".env" -o -name "*.env" -o -name "*.sh" -o -name "*.json" -o -name "*.yaml" -o -name "*.yml" \) -print0 |
  sudo tar --ignore-failed-read --null -T - -czf "${BACKUP_DIR}/files/stack-files.tar.gz" || true
sudo chown "$(id -u):$(id -g)" "${BACKUP_DIR}/files/stack-files.tar.gz" 2>/dev/null || true

sudo docker ps -a --format "{{.Names}}" | sort | tee "${BACKUP_DIR}/container-names.txt" >/dev/null
sudo docker ps -a --no-trunc --format "table {{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Command}}\t{{.Ports}}" |
  tee "${BACKUP_DIR}/docker-ps-a.txt" >/dev/null
sudo docker images --digests --no-trunc | tee "${BACKUP_DIR}/docker-images-digests.txt" >/dev/null

for c in $(sudo docker ps -a --format "{{.Names}}" | sort); do
  sudo docker inspect "${c}" > "${BACKUP_DIR}/docker-inspect/${c}.json"
  sudo docker inspect "${c}" --format "{{range .Config.Env}}{{println .}}{{end}}" > "${BACKUP_DIR}/container-env/${c}.env" || true
  sudo docker logs --tail=300 "${c}" > "${BACKUP_DIR}/logs/${c}.log" 2>&1 || true
done

sudo docker network inspect xyne-stack_xyne > "${BACKUP_DIR}/network-xyne-stack_xyne.json" || true
sudo docker volume ls --format "{{.Name}}" | sort | tee "${BACKUP_DIR}/docker-volumes.txt" >/dev/null

tar -C "${BACKUP_DIR}" -czf "${BACKUP_ROOT}/ingestion-deploy-${TS}.tar.gz" .
printf "BACKUP_DIR=%s\n" "${BACKUP_DIR}"
printf "BACKUP_TAR=%s\n" "${BACKUP_ROOT}/ingestion-deploy-${TS}.tar.gz"
ls -lh "${BACKUP_ROOT}/ingestion-deploy-${TS}.tar.gz"
'

remote_script="${remote_script//__STACK_DIR__/${VM_STACK_DIR}}"
remote_script="${remote_script//__BACKUP_ROOT__/${VM_BACKUP_ROOT}}"

"${GCLOUD}" compute ssh "${GCP_VM}" \
  --project="${GCP_PROJECT}" \
  --zone="${GCP_ZONE}" \
  --quiet \
  --tunnel-through-iap \
  --command="${remote_script}"
