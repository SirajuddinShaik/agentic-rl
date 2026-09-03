#!/usr/bin/env bash
# Preflight the current v34 Xyne/Polar/Miles lane. Run this on RTX1 (normally
# inside miles-never-delete) after exporting credentials.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-${REPO_ROOT}/miles}"

HF_CHECKPOINT="${HF_CHECKPOINT:-/data/siraj/hf_models/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16}"
PROMPT_DATA="${PROMPT_DATA:-/data/siraj/ARL/data/sebi_pranav_metadata_graph_train.jsonl}"
AGENT_CLI_DIR="${AGENT_CLI_DIR:-/data/siraj/ARL/miles/tmp/swegym_agent_cli/opt_node}"
XYNE_SERVER_DIR="${XYNE_SERVER_DIR:-/data/siraj/xyne_s/xyne-search-test}"
XYNE_RUNTIME_IMAGE="${XYNE_RUNTIME_IMAGE:-polar-xyne-runtime:base-e1c2e69e}"
SGLANG_BASE_URL="${SGLANG_BASE_URL:-http://192.168.111.7:30100}"
XYNE_BASE_URL="${XYNE_BASE_URL:-http://127.0.0.1:3103}"
POLAR_ROLLOUT_URL="${POLAR_ROLLOUT_URL:-http://127.0.0.1:8081}"
POLAR_GATEWAY_URL="${POLAR_GATEWAY_URL:-http://127.0.0.1:8101}"
SESSION_PROXY_URL="${SESSION_PROXY_URL:-http://127.0.0.1:18114}"
POSTGRES_HOST="${POSTGRES_HOST:-127.0.0.1}"
POSTGRES_PORT="${POSTGRES_PORT:-15432}"
POSTGRES_DB="${POSTGRES_DB:-xyne}"
POSTGRES_USER="${POSTGRES_USER:-xyne}"
VESPA_QUERY_URL="${VESPA_QUERY_URL:-http://127.0.0.1:18081/state/v1/health}"
VESPA_FEED_URL="${VESPA_FEED_URL:-http://127.0.0.1:18080}"
EXPECTED_RAY_GPUS="${EXPECTED_RAY_GPUS:-12}"

failed=0
need_command() {
  command -v "$1" >/dev/null 2>&1 || { echo "MISSING command: $1" >&2; failed=1; }
}
need_path() {
  test -e "$1" || { echo "MISSING path: $1" >&2; failed=1; }
}
need_env() {
  test -n "${!1:-}" || { echo "MISSING environment: $1" >&2; failed=1; }
}
probe() {
  local name="$1" url="$2"
  if curl -fsS --max-time 5 "$url" >/dev/null; then
    echo "UP   ${name} ${url}"
  else
    echo "DOWN ${name} ${url}" >&2
    failed=1
  fi
}
probe_tcp() {
  local name="$1" host="$2" port="$3"
  if python3 - "$host" "$port" <<'PY'
import socket
import sys

with socket.socket() as sock:
    sock.settimeout(3)
    sock.connect((sys.argv[1], int(sys.argv[2])))
PY
  then
    echo "UP   ${name} ${host}:${port}"
  else
    echo "DOWN ${name} ${host}:${port}" >&2
    failed=1
  fi
}

for command in envsubst python3 curl ray; do need_command "${command}"; done
for variable in \
  XYNE_API_KEY XYNE_ACCESS_TOKEN XYNE_AUTH_WORKSPACE ACCESS_TOKEN_SECRET \
  JWT_SECRET DATABASE_URL JUSPAY_API_KEY WANDB_API_KEY; do need_env "${variable}"; done

need_path "${PROJECT_ROOT}/train_async_microbatch_v2.py"
need_path "${REPO_ROOT}/configs/polar/polar_config_v34.yaml"
need_path "${REPO_ROOT}/runs/launch_xyne_v34_current.sh"
need_path "${HF_CHECKPOINT}/config.json"
need_path "${HF_CHECKPOINT}/chat_template.jinja"
need_path "${PROMPT_DATA}"
need_path "${AGENT_CLI_DIR}"
need_path "${XYNE_SERVER_DIR}"

if [[ -n "${LOAD_DIR:-}" ]]; then
  need_path "${LOAD_DIR}/adapter/adapter_config.json"
else
  echo "SKIP resume checkpoint: LOAD_DIR is not set"
fi

if command -v docker >/dev/null 2>&1; then
  docker image inspect "${XYNE_RUNTIME_IMAGE}" >/dev/null 2>&1 || {
    echo "MISSING Docker image: ${XYNE_RUNTIME_IMAGE}" >&2
    failed=1
  }
else
  echo "SKIP Docker image check: no Docker CLI in this environment"
fi

ray_status="$(ray status 2>&1 || true)"
printf '%s\n' "${ray_status}" | head -n 30
grep -Eq "[0-9.]+/${EXPECTED_RAY_GPUS}\.0 GPU" <<<"${ray_status}" || {
  echo "Ray does not expose ${EXPECTED_RAY_GPUS} GPUs" >&2
  failed=1
}

probe "SGLang" "${SGLANG_BASE_URL}/health"
probe "Xyne test backend" "${XYNE_BASE_URL}/v2/health"
probe "Polar rollout" "${POLAR_ROLLOUT_URL}/health"
probe "Polar gateway" "${POLAR_GATEWAY_URL}/health"
probe "Session proxy" "${SESSION_PROXY_URL}/health"
probe_tcp "Postgres TCP" "${POSTGRES_HOST}" "${POSTGRES_PORT}"
probe "Vespa query" "${VESPA_QUERY_URL}"
probe "Vespa feed" "${VESPA_FEED_URL}"

if command -v pg_isready >/dev/null 2>&1; then
  if pg_isready -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT}" \
      -d "${POSTGRES_DB}" -U "${POSTGRES_USER}" >/dev/null; then
    echo "Postgres readiness: OK"
  else
    echo "Postgres readiness: failed" >&2
    failed=1
  fi
else
  echo "SKIP pg_isready: command unavailable; TCP probe above still applies"
fi

if curl -fsS --max-time 5 "${SGLANG_BASE_URL}/v1/models" | python3 -c \
  'import json,sys; assert any(m.get("id") == "nemotron" for m in json.load(sys.stdin).get("data", []))'; then
  echo "MODEL nemotron: OK"
else
  echo "MODEL nemotron: missing from ${SGLANG_BASE_URL}/v1/models" >&2
  failed=1
fi

if curl -fsS --max-time 5 "${SESSION_PROXY_URL}/v1/models" | python3 -c \
  'import json,sys; assert any(m.get("id") == "nemotron" for m in json.load(sys.stdin).get("data", []))'; then
  echo "MODEL nemotron through session proxy: OK"
else
  echo "MODEL nemotron is not reachable through ${SESSION_PROXY_URL}" >&2
  failed=1
fi

rendered="$(mktemp)"
trap 'rm -f "${rendered}"' EXIT
envsubst < "${REPO_ROOT}/configs/polar/polar_config_v34.yaml" > "${rendered}"
if grep -q '${' "${rendered}"; then
  echo "Rendered Polar config has unresolved placeholders" >&2
  failed=1
else
  python3 - "${rendered}" <<'PY' || failed=1
from pathlib import Path
import sys
import yaml

class StrictLoader(yaml.SafeLoader):
    pass

def construct(loader, node, deep=False):
    value = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in value:
            raise ValueError(f"duplicate YAML key: {key}")
        value[key] = loader.construct_object(value_node, deep=deep)
    return value

StrictLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, construct)
config = yaml.load(Path(sys.argv[1]).read_text(), Loader=StrictLoader)
expected = {
    "polar_max_async_level": 32,
    "polar_microbatch_idle_timeout": 1800,
    "polar_request_timeout": 7200,
    "polar_min_complete_accept_fraction": 0.125,
}
for key, want in expected.items():
    got = config.get(key)
    if got != want:
        raise SystemExit(f"{key}={got!r}, expected {want!r}")
if config["polar_task_template"]["evaluator"]["config"]["judge"]["max_tokens"] != 16384:
    raise SystemExit("judge max_tokens must be 16384")
print("Polar v34 config: OK")
PY
fi

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
            raise SystemExit(f"row {line_number} missing keys: {sorted(missing)}")
        metadata = row["metadata"]
        instance_id = metadata.get("instance_id")
        if not instance_id or instance_id in seen:
            raise SystemExit(f"row {line_number} has missing/duplicate instance_id")
        seen.add(instance_id)
        for key in ("answer", "doc_ids", "chunk_ids"):
            if not metadata.get(key):
                raise SystemExit(f"row {line_number} has empty metadata.{key}")
if rows == 0:
    raise SystemExit("dataset is empty")
print(f"Dataset schema: OK ({rows} unique rows)")
PY

if ((failed)); then
  echo "v34 preflight failed" >&2
  exit 1
fi
echo "v34 preflight passed"
