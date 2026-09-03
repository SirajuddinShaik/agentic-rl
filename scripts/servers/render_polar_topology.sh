#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../.." && pwd)"
template="${repo_root}/configs/polar/topology.sglang.yaml.template"
output="${POLAR_TOPOLOGY:-${repo_root}/.runtime/topology.sglang.yaml}"

required=(
  POLAR_ROLLOUT_HOST POLAR_ROLLOUT_PORT POLAR_ROLLOUT_URL POLAR_SAVE_DIR
  POLAR_GATEWAY_HOST POLAR_GATEWAY_PORT POLAR_GATEWAY_URL
  POLAR_GATEWAY_NODE_ID POLAR_MODEL_SERVED POLAR_MAX_INIT_WORKERS
  POLAR_MAX_RUN_WORKERS POLAR_MAX_POSTRUN_WORKERS SGLANG_BASE_URL
)

for name in "${required[@]}"; do
  : "${!name:?Set $name before rendering the Polar topology}"
done

command -v envsubst >/dev/null || {
  echo "envsubst is required (install gettext)." >&2
  exit 1
}

mkdir -p "$(dirname -- "$output")"
envsubst < "$template" > "$output"
python -c 'from polar.config import TopologyConfig; import sys; TopologyConfig.load(sys.argv[1])' "$output"
echo "$output"
