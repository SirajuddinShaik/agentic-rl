#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../.." && pwd)"
runtime_dir="${repo_root}/.runtime"
mkdir -p "$runtime_dir"

topology="$(${script_dir}/render_polar_topology.sh)"
: "${POLAR_GATEWAY_NODE_ID:?Set POLAR_GATEWAY_NODE_ID}"

nohup polar serve_rollout -c "$topology" > "${runtime_dir}/polar-rollout.log" 2>&1 &
echo $! > "${runtime_dir}/polar-rollout.pid"

nohup polar serve_gateway -c "$topology" --node-id "$POLAR_GATEWAY_NODE_ID" \
  > "${runtime_dir}/polar-gateway.log" 2>&1 &
echo $! > "${runtime_dir}/polar-gateway.pid"

echo "Polar rollout and gateway launched."
echo "Logs: ${runtime_dir}/polar-rollout.log and ${runtime_dir}/polar-gateway.log"
