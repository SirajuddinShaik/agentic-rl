#!/usr/bin/env bash
# Build and start a new Miles container on a remote GPU node from the sanitized
# source trees in this repository.
#
# Default target:
#   tata06, GPUs 0-3, host networking, idle container
#
# The script intentionally does not stop Ray, Docker containers, GPU processes,
# or training jobs. It only creates a uniquely named container. If that name
# already exists, it fails unless REPLACE_CONTAINER=1 is explicitly set.
#
# Examples:
#   scripts/setup_miles_container.sh
#   REMOTE_TARGET=tata06 GPU_DEVICES=0,1,2,3 scripts/setup_miles_container.sh
#   REPLACE_CONTAINER=1 IMAGE_TAG=agentic-rl/miles-overlay:current scripts/setup_miles_container.sh
#
# Optional post-setup actions:
#   START_RAY=1                 start a Ray head inside the new container
#   STRICT_ENDPOINTS=1          fail if RTX1/RTX2 service endpoints are unreachable
#
# No credentials are copied or embedded by this script.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

REMOTE_TARGET="${REMOTE_TARGET:-tata06}"
REMOTE_STAGE="${REMOTE_STAGE:-/data/aicloud/agentic-rl-miles-overlay}"
BASE_IMAGE="${BASE_IMAGE:-radixark/miles@sha256:08be00658cd24eaa364ca4ad0b1a3911dfbe4adc04fd0c148e4241402fb40812}"
IMAGE_TAG="${IMAGE_TAG:-agentic-rl/miles-overlay:current}"
CONTAINER_NAME="${CONTAINER_NAME:-miles-tata06-overlay}"
GPU_DEVICES="${GPU_DEVICES:-0,1,2,3}"
SHM_SIZE="${SHM_SIZE:-64g}"
PULL_BASE_IMAGE="${PULL_BASE_IMAGE:-1}"
RUN_TESTS="${RUN_TESTS:-1}"
START_CONTAINER="${START_CONTAINER:-1}"
REPLACE_CONTAINER="${REPLACE_CONTAINER:-0}"
START_RAY="${START_RAY:-0}"
CHECK_ENDPOINTS="${CHECK_ENDPOINTS:-1}"
STRICT_ENDPOINTS="${STRICT_ENDPOINTS:-0}"
RAY_HEAD_IP="${RAY_HEAD_IP:-100.64.0.204}"
RAY_PORT="${RAY_PORT:-6379}"
RAY_DASHBOARD_PORT="${RAY_DASHBOARD_PORT:-8265}"

POLAR_ROLLOUT_URL="${POLAR_ROLLOUT_URL:-http://100.64.0.126:8081}"
POLAR_GATEWAY_URL="${POLAR_GATEWAY_URL:-http://100.64.0.126:8101}"
XYNE_BASE_URL="${XYNE_BASE_URL:-http://100.64.0.126:3103}"
SESSION_PROXY_URL="${SESSION_PROXY_URL:-http://100.64.0.126:18114}"
SGLANG_BASE_URL="${SGLANG_BASE_URL:-http://100.64.0.149:30100}"

usage() {
  cat <<'EOF'
Usage: scripts/setup_miles_container.sh [options]

Options:
  --host HOST          Remote SSH target (default: tata06)
  --gpus DEVICES       Comma-separated GPU devices (default: 0,1,2,3)
  --container NAME     New container name (default: miles-tata06-overlay)
  --image TAG          Built image tag (default: agentic-rl/miles-overlay:current)
  --base-image IMAGE   Upstream Miles base image (default: pinned digest in this repo)
  --stage PATH         Remote staging directory
  --no-pull            Do not pull the base image
  --no-tests           Skip in-container validation
  --no-start           Build and stage only; do not start a container
  --no-endpoints       Skip external RTX1/RTX2 endpoint checks
  --replace            Remove only the named container if it already exists
  --start-ray          Start a Ray head after setup
  --strict-endpoints   Fail if external Polar/Xyne/SGLang endpoints are down
  -h, --help           Show this help
EOF
}

while (($#)); do
  case "$1" in
    --host) REMOTE_TARGET="${2:?missing HOST}"; shift 2 ;;
    --gpus) GPU_DEVICES="${2:?missing DEVICES}"; shift 2 ;;
    --container) CONTAINER_NAME="${2:?missing NAME}"; shift 2 ;;
    --image) IMAGE_TAG="${2:?missing TAG}"; shift 2 ;;
    --base-image) BASE_IMAGE="${2:?missing IMAGE}"; shift 2 ;;
    --stage) REMOTE_STAGE="${2:?missing PATH}"; shift 2 ;;
    --no-pull) PULL_BASE_IMAGE=0; shift ;;
    --no-tests) RUN_TESTS=0; shift ;;
    --no-start) START_CONTAINER=0; shift ;;
    --no-endpoints) CHECK_ENDPOINTS=0; shift ;;
    --replace) REPLACE_CONTAINER=1; shift ;;
    --start-ray) START_RAY=1; shift ;;
    --strict-endpoints) STRICT_ENDPOINTS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

for command in rsync ssh; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Missing local command: $command" >&2
    exit 2
  }
done

[[ -f "${REPO_ROOT}/docker/miles-overlay.Dockerfile" ]] || {
  echo "Missing ${REPO_ROOT}/docker/miles-overlay.Dockerfile" >&2
  exit 2
}
[[ -f "${REPO_ROOT}/miles/train_async_microbatch_v2.py" ]] || {
  echo "Missing Miles training script under ${REPO_ROOT}/miles" >&2
  exit 2
}
[[ -f "${REPO_ROOT}/polar-pkg/polar/__init__.py" ]] || {
  echo "Missing Polar package under ${REPO_ROOT}/polar-pkg" >&2
  exit 2
}

rsync_exclude=(
  --exclude '.git/'
  --exclude '.venv/'
  --exclude '.pytest_cache/'
  --exclude '.ruff_cache/'
  --exclude '__pycache__/'
  --exclude '*.pyc'
  --exclude '*.pyo'
  --exclude '*.egg-info/'
  --exclude '.DS_Store'
  --exclude 'tmp/'
  --exclude 'checkpoints/'
  --exclude 'trajectory_dumps/'
  --exclude 'wandb/'
  --exclude 'logs/'
  --exclude 'datasets/'
  --exclude 'node_modules/'
)

echo "== Configuration =="
echo "Remote target:      ${REMOTE_TARGET}"
echo "Remote stage:       ${REMOTE_STAGE}"
echo "Base image:         ${BASE_IMAGE}"
echo "Built image:        ${IMAGE_TAG}"
echo "Container name:     ${CONTAINER_NAME}"
echo "GPU devices:        ${GPU_DEVICES}"
echo "Start container:    ${START_CONTAINER}"
echo "Run tests:          ${RUN_TESTS}"
echo "Start Ray:          ${START_RAY}"
echo

echo "== Preparing remote staging directory =="
ssh "${REMOTE_TARGET}" "mkdir -p '${REMOTE_STAGE}/docker'"

echo "== Copying sanitized repository overlay =="
rsync -a --delete "${rsync_exclude[@]}" \
  "${REPO_ROOT}/miles/" "${REMOTE_TARGET}:${REMOTE_STAGE}/miles/"
rsync -a --delete "${rsync_exclude[@]}" \
  "${REPO_ROOT}/polar-pkg/" "${REMOTE_TARGET}:${REMOTE_STAGE}/polar-pkg/"
rsync -a --delete "${rsync_exclude[@]}" \
  "${REPO_ROOT}/polar/" "${REMOTE_TARGET}:${REMOTE_STAGE}/polar/"
rsync -a --delete "${rsync_exclude[@]}" \
  "${REPO_ROOT}/configs/" "${REMOTE_TARGET}:${REMOTE_STAGE}/configs/"
rsync -a --delete "${rsync_exclude[@]}" \
  "${REPO_ROOT}/runs/" "${REMOTE_TARGET}:${REMOTE_STAGE}/runs/"
rsync -a --delete "${rsync_exclude[@]}" \
  "${REPO_ROOT}/scripts/" "${REMOTE_TARGET}:${REMOTE_STAGE}/scripts/"
rsync -a --delete "${rsync_exclude[@]}" \
  "${REPO_ROOT}/tests/" "${REMOTE_TARGET}:${REMOTE_STAGE}/tests/"
rsync -a --delete "${rsync_exclude[@]}" \
  "${REPO_ROOT}/tools/" "${REMOTE_TARGET}:${REMOTE_STAGE}/tools/"
rsync -a "${REPO_ROOT}/docker/miles-overlay.Dockerfile" \
  "${REMOTE_TARGET}:${REMOTE_STAGE}/docker/miles-overlay.Dockerfile"
rsync -a \
  "${REPO_ROOT}/pyproject.toml" \
  "${REPO_ROOT}/README.md" \
  "${REPO_ROOT}/AGENTS.md" \
  "${REMOTE_TARGET}:${REMOTE_STAGE}/"

echo "== Building Miles overlay image remotely =="
ssh "${REMOTE_TARGET}" env \
  REMOTE_STAGE="${REMOTE_STAGE}" \
  BASE_IMAGE="${BASE_IMAGE}" \
  IMAGE_TAG="${IMAGE_TAG}" \
  PULL_BASE_IMAGE="${PULL_BASE_IMAGE}" \
  bash -s <<'REMOTE_BUILD'
set -euo pipefail

if command -v docker >/dev/null 2>&1; then
  :
else
  echo "Docker is unavailable on the remote host" >&2
  exit 2
fi

if [[ "${PULL_BASE_IMAGE}" == "1" ]]; then
  docker pull "${BASE_IMAGE}"
else
  docker image inspect "${BASE_IMAGE}" >/dev/null
fi

docker build \
  --file "${REMOTE_STAGE}/docker/miles-overlay.Dockerfile" \
  --build-arg BASE_IMAGE="${BASE_IMAGE}" \
  --tag "${IMAGE_TAG}" \
  "${REMOTE_STAGE}"
REMOTE_BUILD

if [[ "${START_CONTAINER}" != "1" ]]; then
  echo
  echo "Image built without starting a container:"
  echo "  ${REMOTE_TARGET}:${IMAGE_TAG}"
  echo "Start manually with:"
  echo "  ssh ${REMOTE_TARGET} docker run -d --name ${CONTAINER_NAME} --gpus '\"device=${GPU_DEVICES}\"' --network host --ipc host --shm-size ${SHM_SIZE} ${IMAGE_TAG} sleep infinity"
  exit 0
fi

echo "== Starting new idle Miles container =="
ssh "${REMOTE_TARGET}" env \
  REMOTE_STAGE="${REMOTE_STAGE}" \
  IMAGE_TAG="${IMAGE_TAG}" \
  CONTAINER_NAME="${CONTAINER_NAME}" \
  GPU_DEVICES="${GPU_DEVICES}" \
  SHM_SIZE="${SHM_SIZE}" \
  REPLACE_CONTAINER="${REPLACE_CONTAINER}" \
  POLAR_ROLLOUT_URL="${POLAR_ROLLOUT_URL}" \
  POLAR_GATEWAY_URL="${POLAR_GATEWAY_URL}" \
  XYNE_BASE_URL="${XYNE_BASE_URL}" \
  SESSION_PROXY_URL="${SESSION_PROXY_URL}" \
  SGLANG_BASE_URL="${SGLANG_BASE_URL}" \
  RAY_HEAD_IP="${RAY_HEAD_IP}" \
  bash -s <<'REMOTE_START'
set -euo pipefail

if docker container inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
  if [[ "${REPLACE_CONTAINER}" == "1" ]]; then
    echo "Removing existing named container ${CONTAINER_NAME}"
    docker rm -f "${CONTAINER_NAME}"
  else
    echo "Container ${CONTAINER_NAME} already exists. Set REPLACE_CONTAINER=1 to replace only this container." >&2
    exit 2
  fi
fi

docker run -d \
  --name "${CONTAINER_NAME}" \
  --gpus "\"device=${GPU_DEVICES}\"" \
  --network host \
  --ipc host \
  --shm-size "${SHM_SIZE}" \
  --restart no \
  --volume /data:/data \
  "${IMAGE_TAG}" \
  sleep infinity

cat > "${REMOTE_STAGE}/topology.env" <<EOF
# Intended cross-node topology. Services remain owned by their existing nodes.
POLAR_ROLLOUT_URL=${POLAR_ROLLOUT_URL}
POLAR_GATEWAY_URL=${POLAR_GATEWAY_URL}
XYNE_BASE_URL=${XYNE_BASE_URL}
SESSION_PROXY_URL=${SESSION_PROXY_URL}
SGLANG_BASE_URL=${SGLANG_BASE_URL}
RAY_HEAD_IP=${RAY_HEAD_IP}
EOF

docker exec "${CONTAINER_NAME}" mkdir -p /root/.agentic-rl
docker cp "${REMOTE_STAGE}/topology.env" "${CONTAINER_NAME}:/root/.agentic-rl/topology.env"
docker exec "${CONTAINER_NAME}" bash -lc 'chmod 600 /root/.agentic-rl/topology.env'
REMOTE_START

echo "== Validating container setup =="
ssh "${REMOTE_TARGET}" env \
  CONTAINER_NAME="${CONTAINER_NAME}" \
  RUN_TESTS="${RUN_TESTS}" \
  bash -s <<'REMOTE_VALIDATE'
set -euo pipefail

docker exec "${CONTAINER_NAME}" bash -lc '
set -euo pipefail
export PYTHONPATH=/root/miles:/opt/agentic-rl/polar-pkg

echo "-- Python/package locations --"
python - <<'"'"'PY'"'"'
import miles
import polar
import ray

assert miles.__file__.startswith("/root/miles"), miles.__file__
assert polar.__file__.startswith("/opt/agentic-rl/polar-pkg"), polar.__file__
print("miles:", miles.__file__)
print("polar:", polar.__file__)
print("ray:", ray.__version__)
PY

echo "-- Polar CLI --"
polar --help >/dev/null

echo "-- Training scripts --"
test -f /root/miles/train_async_microbatch_v2.py
test -f /root/miles/miles/rollout/polar_rollout.py
test -f /root/miles/miles/rollout/polar_reward.py
test -f /opt/agentic-rl/runs/launch_xyne_v34_current.sh
test -f /root/.agentic-rl/topology.env

echo "-- GPU visibility --"
nvidia-smi -L
'

if [[ "${RUN_TESTS}" == "1" ]]; then
  docker exec "${CONTAINER_NAME}" bash -lc '
set -euo pipefail
export PYTHONPATH=/root/miles:/opt/agentic-rl/polar-pkg

echo "-- Focused Polar/Miles integration tests --"
python -m pytest /opt/agentic-rl/tests/fast/rollout/test_polar_integrations.py -q

echo "-- Current v34 reproducibility contract --"
python -m pytest /opt/agentic-rl/tests/test_current_v34_repro.py -q
'
fi
REMOTE_VALIDATE

if [[ "${CHECK_ENDPOINTS}" == "1" ]]; then
  echo "== Checking intended external endpoints =="
  endpoint_failed=0
  check_endpoint() {
    local name="$1"
    local url="$2"
    if ssh "${REMOTE_TARGET}" "curl -fsS --max-time 5 '${url}' >/dev/null"; then
      echo "UP   ${name} ${url}"
    else
      echo "WARN ${name} ${url} is unreachable from ${REMOTE_TARGET}" >&2
      endpoint_failed=1
    fi
  }
  check_endpoint "Polar rollout" "${POLAR_ROLLOUT_URL}/health"
  check_endpoint "Polar gateway" "${POLAR_GATEWAY_URL}/health"
  check_endpoint "Xyne backend" "${XYNE_BASE_URL}/v2/health"
  check_endpoint "Session proxy" "${SESSION_PROXY_URL}/health"
  check_endpoint "SGLang" "${SGLANG_BASE_URL}/health"

  if [[ "${STRICT_ENDPOINTS}" == "1" && "${endpoint_failed}" != "0" ]]; then
    echo "One or more external endpoints are unreachable." >&2
    exit 1
  fi
fi

if [[ "${START_RAY}" == "1" ]]; then
  echo "== Starting Ray head in the new container =="
  ssh "${REMOTE_TARGET}" env \
    CONTAINER_NAME="${CONTAINER_NAME}" \
    RAY_HEAD_IP="${RAY_HEAD_IP}" \
    RAY_PORT="${RAY_PORT}" \
    RAY_DASHBOARD_PORT="${RAY_DASHBOARD_PORT}" \
    GPU_DEVICES="${GPU_DEVICES}" \
    bash -s <<'REMOTE_RAY'
set -euo pipefail
docker exec \
  -e RAY_HEAD_IP="${RAY_HEAD_IP}" \
  -e RAY_PORT="${RAY_PORT}" \
  -e RAY_DASHBOARD_PORT="${RAY_DASHBOARD_PORT}" \
  -e GPU_DEVICES="${GPU_DEVICES}" \
  "${CONTAINER_NAME}" bash -lc '
    set -euo pipefail
    CUDA_VISIBLE_DEVICES="${GPU_DEVICES}" ray start --head \
      --node-ip-address="${RAY_HEAD_IP}" \
      --port="${RAY_PORT}" \
      --dashboard-host=0.0.0.0 \
      --dashboard-port="${RAY_DASHBOARD_PORT}" \
      --num-gpus=4 \
      --disable-usage-stats
  '
REMOTE_RAY
fi

echo
echo "== Setup complete =="
echo "Host:        ${REMOTE_TARGET}"
echo "Container:   ${CONTAINER_NAME}"
echo "Image:       ${IMAGE_TAG}"
echo "GPUs:        ${GPU_DEVICES}"
echo "Source:      ${REMOTE_STAGE}"
echo "Topology:    docker exec ${CONTAINER_NAME} cat /root/.agentic-rl/topology.env"
echo "Shell:       ssh ${REMOTE_TARGET} docker exec -it ${CONTAINER_NAME} bash"
if [[ "${START_RAY}" != "1" ]]; then
  echo "Ray:         not started (use START_RAY=1 or start it manually)"
fi
