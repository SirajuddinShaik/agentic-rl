#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-/root/miles}"
HF_CHECKPOINT="${HF_CHECKPOINT:-/data/siraj/hf_models/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16}"
PROMPT_DATA="${PROMPT_DATA:-/data/siraj/xyne_s/xyne_qa_train.jsonl}"
AGENT_CLI_DIR="${AGENT_CLI_DIR:-/data/siraj/ARL/miles/tmp/swegym_agent_cli/opt_node}"
XYNE_SERVER_DIR="${XYNE_SERVER_DIR:-/data/siraj/xyne_s/xyne-search}"
XYNE_RUNTIME_IMAGE="${XYNE_RUNTIME_IMAGE:-polar-xyne-runtime:withwait}"
EXPECTED_RAY_GPUS="${EXPECTED_RAY_GPUS:-12}"
MILES_CONTAINER="${MILES_CONTAINER:-miles-never-delete}"

failed=0
need_command() {
  command -v "$1" >/dev/null 2>&1 || { echo "MISSING command: $1" >&2; failed=1; }
}
need_path() {
  test -e "$1" || { echo "MISSING path: $1" >&2; failed=1; }
}

for command in envsubst python3; do need_command "${command}"; done
need_path "${PROJECT_ROOT}/train.py"
need_path "${PROJECT_ROOT}/miles/examples/polar_swegym_grpo/model_args.sh"
need_path "${PROJECT_ROOT}/miles/examples/polar_swegym_grpo/polar_config_xyne_qa.yaml"
need_path "${HF_CHECKPOINT}/config.json"
need_path "${PROMPT_DATA}"
need_path "${AGENT_CLI_DIR}"
need_path "${XYNE_SERVER_DIR}"

for variable in \
  XYNE_API_KEY ACCESS_TOKEN_SECRET JWT_SECRET JUSPAY_API_KEY \
  XYNE_BASE_URL XYNE_JUDGE_BASE_URL XYNE_JUDGE_MODEL \
  XYNE_JUDGE_MAX_TOKENS XYNE_JUDGE_MAX_CONCURRENCY; do
  test -n "${!variable:-}" || { echo "MISSING environment: ${variable}" >&2; failed=1; }
done
if [[ "${WANDB_MODE:-online}" == "online" ]] && ! grep -q 'machine api.wandb.ai' "${HOME}/.netrc" 2>/dev/null; then
  echo "MISSING W&B login: run scripts/setup_wandb_credentials.sh" >&2
  failed=1
fi
if command -v docker >/dev/null 2>&1; then
  docker image inspect "${XYNE_RUNTIME_IMAGE}" >/dev/null 2>&1 || {
    echo "MISSING Docker image: ${XYNE_RUNTIME_IMAGE}" >&2
    failed=1
  }
else
  echo "SKIP Docker image check: this container has no Docker control socket/CLI"
fi

if command -v ray >/dev/null 2>&1; then
  ray_status="$(ray status 2>&1 || true)"
elif command -v docker >/dev/null 2>&1 && docker inspect "${MILES_CONTAINER}" >/dev/null 2>&1; then
  ray_status="$(docker exec "${MILES_CONTAINER}" ray status 2>&1 || true)"
else
  ray_status=""
  echo "Ray is unavailable and container ${MILES_CONTAINER} is not running" >&2
  failed=1
fi
if test -n "${ray_status}"; then
  grep -Eq "[0-9.]+/${EXPECTED_RAY_GPUS}\.0 GPU" <<<"${ray_status}" || {
    echo "Ray does not expose ${EXPECTED_RAY_GPUS} GPUs" >&2
    failed=1
  }
fi

if test -f "${PROMPT_DATA}" && command -v python3 >/dev/null 2>&1; then
  python3 - "${PROMPT_DATA}" <<'PY' || failed=1
import json
import sys

seen = set()
rows = 0
with open(sys.argv[1], encoding="utf-8") as stream:
    for line_number, line in enumerate(stream, 1):
        if not line.strip():
            continue
        rows += 1
        row = json.loads(line)
        missing = {"prompt", "label", "metadata"} - row.keys()
        if missing:
            raise SystemExit(f"dataset row {line_number} misses keys: {sorted(missing)}")
        metadata = row["metadata"]
        instance_id = metadata.get("instance_id")
        if not instance_id or instance_id in seen:
            raise SystemExit(f"dataset row {line_number} has missing/duplicate instance_id")
        seen.add(instance_id)
        for key in ("answer", "doc_ids", "chunk_ids"):
            if not metadata.get(key):
                raise SystemExit(f"dataset row {line_number} has empty metadata.{key}")
if rows == 0:
    raise SystemExit("dataset is empty")
print(f"Dataset schema: OK ({rows} unique rows)")
PY
fi

if ((failed)); then
  echo "Preflight failed" >&2
  exit 1
fi
echo "Preflight passed"
