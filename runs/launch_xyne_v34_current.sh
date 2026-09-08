#!/usr/bin/env bash
# Reproduces the current v34 Xyne/Polar/Miles training lane without embedding
# credentials. Run inside the Miles container on RTX1 after exporting the
# required environment and confirming a healthy 12-GPU Ray cluster.
set -euo pipefail
umask 077

if [ "$(ulimit -n)" -lt 1048576 ]; then
  ulimit -n 1048576 2>/dev/null || ulimit -n 524288 2>/dev/null || true
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-${REPO_ROOT}/miles}"
POLAR_PKG_DIR="${POLAR_PKG_DIR:-${REPO_ROOT}/polar-pkg}"
MEGATRON_DIR="${MEGATRON_DIR:-/root/Megatron-LM}"
PYTHON_BIN="${PYTHON_BIN:-/usr/bin/python3}"

RUN_ID="${RUN_ID:-xyne-v34-tp2cp4ep8-lora128-60k-80k-$(date +%Y%m%d_%H%M%S)}"
RUN_DIR="${RUN_DIR:-${PROJECT_ROOT}/tmp/xyne_qa_tp2cp4ep8/${RUN_ID}}"
SAVE_DIR="${SAVE_DIR:-${PROJECT_ROOT}/tmp/ckpt/xyne_qa_tp2cp4ep8/${RUN_ID}}"
TRAJECTORY_DUMP_DIR="${TRAJECTORY_DUMP_DIR:-${RUN_DIR}/trajectory_dumps}"
POLAR_CONFIG_TEMPLATE="${POLAR_CONFIG_TEMPLATE:-${REPO_ROOT}/configs/polar/polar_config_v34.yaml}"
CUSTOM_CONFIG_PATH="${CUSTOM_CONFIG_PATH:-${RUN_DIR}/polar_config_custom.yaml}"
WANDB_DIR="${WANDB_DIR:-${PROJECT_ROOT}/tmp/wandb}"

LOAD_DIR="${LOAD_DIR:-}"
: "${HF_CHECKPOINT:?Set HF_CHECKPOINT}"
: "${PROMPT_DATA:?Set PROMPT_DATA}"
: "${AGENT_CLI_DIR:?Set AGENT_CLI_DIR}"
: "${XYNE_SERVER_DIR:?Set XYNE_SERVER_DIR}"
: "${XYNE_RUNTIME_IMAGE:?Set XYNE_RUNTIME_IMAGE}"
: "${XYNE_API_KEY:?Set XYNE_API_KEY}"
: "${JUSPAY_API_KEY:?Set JUSPAY_API_KEY}"
: "${WANDB_API_KEY:?Set WANDB_API_KEY}"
: "${ACCESS_TOKEN_SECRET:?Set ACCESS_TOKEN_SECRET}"
: "${XYNE_ACCESS_TOKEN:?Set XYNE_ACCESS_TOKEN}"
: "${XYNE_AUTH_WORKSPACE:?Set XYNE_AUTH_WORKSPACE}"
: "${DATABASE_URL:?Set DATABASE_URL}"
: "${JWT_SECRET:?Set JWT_SECRET}"

SGLANG_CHAT_TEMPLATE="${SGLANG_CHAT_TEMPLATE:-${HF_CHECKPOINT}/chat_template.jinja}"

export XYNE_BASE_URL="${XYNE_BASE_URL:-http://100.64.0.126:3103}"
export POLAR_ROLLOUT_URL="${POLAR_ROLLOUT_URL:-http://100.64.0.126:8081}"
export POLAR_GATEWAY_URL="${POLAR_GATEWAY_URL:-http://100.64.0.126:8101}"
export XYNE_JUDGE_BASE_URL="${XYNE_JUDGE_BASE_URL:-http://100.64.0.149:30100/v1}"
export XYNE_JUDGE_MODEL="${XYNE_JUDGE_MODEL:-nemotron}"
export XYNE_JUDGE_MAX_TOKENS="${XYNE_JUDGE_MAX_TOKENS:-16384}"
export XYNE_JUDGE_MAX_CONCURRENCY="${XYNE_JUDGE_MAX_CONCURRENCY:-32}"

mkdir -p "${RUN_DIR}" "${SAVE_DIR}" "${TRAJECTORY_DUMP_DIR}"
command -v envsubst >/dev/null || {
  echo "envsubst is required (install gettext)." >&2
  exit 2
}
envsubst < "${POLAR_CONFIG_TEMPLATE}" > "${CUSTOM_CONFIG_PATH}"
if grep -q '${' "${CUSTOM_CONFIG_PATH}"; then
  echo "Rendered Polar config still contains an unresolved \${VAR} placeholder." >&2
  exit 2
fi
"${PYTHON_BIN}" - "${CUSTOM_CONFIG_PATH}" <<'PY'
from pathlib import Path
import sys
import yaml

class StrictLoader(yaml.SafeLoader):
    pass

def no_duplicates(loader, node, deep=False):
    mapping = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise ValueError(f"duplicate YAML key: {key}")
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping

StrictLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, no_duplicates)
config = yaml.load(Path(sys.argv[1]).read_text(), Loader=StrictLoader)
required = {
    "polar_max_async_level": 32,
    "polar_microbatch_idle_timeout": 1800,
    "polar_request_timeout": 7200,
    "polar_min_complete_accept_fraction": 0.125,
}
for key, expected in required.items():
    actual = config.get(key)
    if actual != expected:
        raise SystemExit(f"{key}={actual!r}, expected {expected!r}")
print("Polar config: OK")
PY

export PYTHONPATH="${MEGATRON_DIR}:${PROJECT_ROOT}:${POLAR_PKG_DIR}"
export PATH="/usr/bin:/usr/local/nvidia/bin:/usr/local/cuda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export VIRTUAL_ENV=""
export CUDA_DEVICE_MAX_CONNECTIONS="1"
export PYTORCH_CUDA_ALLOC_CONF="expandable_segments:True"
export MILES_SGLANG_DUMMY_LOAD="0"
export SGLANG_FLASHINFER_WORKSPACE_SIZE="1073741824"
export SGLANG_FLASHINFER_DISABLE_SPLIT_KV="1"
export NCCL_SOCKET_IFNAME="${NCCL_SOCKET_IFNAME:-enp193s0f0np0,^veth,^docker,^lo,^br-,^tailscale}"
export GLOO_SOCKET_IFNAME="${GLOO_SOCKET_IFNAME:-enp193s0f0np0,^veth,^docker,^lo,^br-,^tailscale}"
export MILES_POLAR_MAX_TRACES_PER_SESSION="${MILES_POLAR_MAX_TRACES_PER_SESSION:-128}"
export MILES_POLAR_TRAJECTORY_DUMP_DIR="${TRAJECTORY_DUMP_DIR}"
export MILES_ACTOR_TRAIN_HANG_TIMEOUT_S="${MILES_ACTOR_TRAIN_HANG_TIMEOUT_S:-28800}"
export RAY_gcs_grpc_client_timeout_ms="1800000"
export RAY_grpc_keepalive_time_ms="60000"
export RAY_grpc_keepalive_timeout_ms="60000"
export RAY_grpc_client_keepalive_time_ms="60000"
export RAY_grpc_client_keepalive_timeout_ms="60000"
export RAY_gcs_server_request_timeout_seconds="3600"

export TRAIN_ENV_VARS="$("${PYTHON_BIN}" <<'PY'
import json
import os

print(json.dumps({
    "NCCL_SOCKET_IFNAME": os.environ["NCCL_SOCKET_IFNAME"],
    "GLOO_SOCKET_IFNAME": os.environ["GLOO_SOCKET_IFNAME"],
    "NCCL_IB_DISABLE": "1",
    "NCCL_INET_FAMILY": "AF_INET",
    "NCCL_SOCKET_FAMILY": "AF_INET",
    "NCCL_CUMEM_ENABLE": "0",
    "TORCH_NCCL_AVOID_RECORD_STREAMS": "1",
    "TORCH_NCCL_ASYNC_ERROR_HANDLING": "1",
    "PYTORCH_CUDA_ALLOC_CONF": os.environ["PYTORCH_CUDA_ALLOC_CONF"],
}))
PY
)"
export RAY_RUNTIME_ENV="$("${PYTHON_BIN}" <<'PY'
import json
import os

print(json.dumps({"env_vars": {
    "PYTHONPATH": os.environ["PYTHONPATH"],
    "NCCL_SOCKET_IFNAME": os.environ["NCCL_SOCKET_IFNAME"],
    "GLOO_SOCKET_IFNAME": os.environ["GLOO_SOCKET_IFNAME"],
    "NCCL_IB_DISABLE": "1",
    "NCCL_INET_FAMILY": "AF_INET",
    "NCCL_SOCKET_FAMILY": "AF_INET",
    "NCCL_DEBUG": "WARN",
    "NCCL_DEBUG_SUBSYS": "ALL",
    "WANDB_API_KEY": os.environ["WANDB_API_KEY"],
    "WANDB_BASE_URL": "https://api.wandb.ai",
    "WANDB_MODE": "online",
    "WANDB_ENTITY": "sirajuddin-shaik-007",
    "WANDB_PROJECT": "xyne-polar-grpo",
    "MILES_POLAR_MAX_TRACES_PER_SESSION": os.environ["MILES_POLAR_MAX_TRACES_PER_SESSION"],
    "MILES_POLAR_TRAJECTORY_DUMP_DIR": os.environ["MILES_POLAR_TRAJECTORY_DUMP_DIR"],
}}))
PY
)"

ray status | grep -q "0.0/12.0 GPU" || {
  echo "Expected a healthy 12-GPU Ray cluster." >&2
  ray status >&2 || true
  exit 2
}

echo "RUN_ID=${RUN_ID}"
echo "RUN_DIR=${RUN_DIR}"
echo "SAVE_DIR=${SAVE_DIR}"
echo "TRAJECTORY_DUMP_DIR=${TRAJECTORY_DUMP_DIR}"
echo "LOAD_DIR=${LOAD_DIR:-<fresh-base-from-HF>}"

LOAD_ARGS=()
if [[ -n "${LOAD_DIR}" ]]; then
  LOAD_ARGS+=(--load "${LOAD_DIR}")
fi

exec "${PYTHON_BIN}" "${PROJECT_ROOT}/train_async_microbatch_v2.py" \
  --actor-num-nodes 1 \
  --actor-num-gpus-per-node 8 \
  --rollout-num-gpus 4 \
  --rollout-num-gpus-per-engine 2 \
  --train-backend megatron \
  --disable-bias-linear --group-query-attention --num-attention-heads 32 --num-query-groups 2 \
  --kv-channels 128 --num-layers 52 --hidden-size 2688 --ffn-hidden-size 1856 --normalization RMSNorm \
  --position-embedding-type none --vocab-size 131072 --make-vocab-size-divisible-by 128 \
  --untie-embeddings-and-output-weights --num-experts 128 --moe-router-topk 6 --moe-ffn-hidden-size 1856 \
  --moe-shared-expert-intermediate-size 3712 --moe-router-score-function sigmoid --moe-router-enable-expert-bias \
  --moe-grouped-gemm --moe-router-dtype fp32 --moe-router-num-groups 1 --moe-router-group-topk 1 \
  --moe-router-topk-scaling-factor 2.5 --moe-router-pre-softmax --moe-router-load-balancing-type seq_aux_loss \
  --moe-router-bias-update-rate 0 --moe-aux-loss-coeff 0 \
  --hf-checkpoint "${HF_CHECKPOINT}" \
  --no-load-optim --no-load-rng --finetune --megatron-to-hf-mode bridge \
  --save "${SAVE_DIR}" --save-interval 1 \
  "${LOAD_ARGS[@]}" \
  --rollout-function-path miles.rollout.polar_rollout.generate_rollout_polar_async_microbatch \
  --custom-rm-path miles.rollout.polar_reward.custom_rm \
  --custom-reward-post-process-path miles.rollout.polar_reward.post_process_rewards \
  --custom-config-path "${CUSTOM_CONFIG_PATH}" \
  --data-source-path miles.rollout.polar_data_source.CeilEpochRolloutDataSourceWithBuffer \
  --prompt-data "${PROMPT_DATA}" \
  --input-key prompt --label-key label --metadata-key metadata --rollout-shuffle --reward-key score \
  --num-epoch 3 --rollout-batch-size 32 --n-samples-per-prompt 8 --global-batch-size 32 \
  --rollout-max-response-len 60000 --rollout-max-prompt-len 60000 --num-steps-per-rollout 8 \
  --tensor-model-parallel-size 2 --sequence-parallel --qkv-format bshd --pipeline-model-parallel-size 1 \
  --context-parallel-size 4 --expert-model-parallel-size 8 --expert-tensor-parallel-size 1 \
  --recompute-granularity full --recompute-method uniform --recompute-num-layers 52 --micro-batch-size 1 \
  --train-env-vars "${TRAIN_ENV_VARS}" \
  --max-tokens-per-gpu 20000 --moe-token-dispatcher-type allgather --log-probs-chunk-size 16 \
  --distributed-timeout-minutes 480 --advantage-estimator grpo --normalize-advantages --use-rollout-logprobs \
  --entropy-coef 0.001 --eps-clip 0.2 --eps-clip-high 0.28 \
  --dynamic-sampling-filter-path miles.rollout.filter_hub.dynamic_sampling_filters.check_reward_nonzero_std \
  --optimizer adam --lr 5e-6 --lr-decay-style constant --weight-decay 0.0 --adam-beta1 0.9 --adam-beta2 0.98 \
  --attention-dropout 0.0 --hidden-dropout 0.0 --accumulate-allreduce-grads-in-fp32 --attention-softmax-in-fp32 \
  --attention-backend flash --update-weight-transfer-mode broadcast \
  --lora-rank 128 --lora-alpha 256 --lora-dropout 0.0 --lora-a-init-method xavier --lora-b-init-method zero \
  --target-modules q_proj,v_proj,gate_proj,up_proj,down_proj \
  --sglang-lora-backend triton --multi-lora-disable-service-mode --sglang-moe-runner-backend triton \
  --sglang-mem-fraction-static 0.84 --sglang-max-running-requests 128 \
  --sglang-chunked-prefill-size 8192 --sglang-max-prefill-tokens 80000 \
  --sglang-context-length 80000 --sglang-router-port 30100 \
  --sglang-reasoning-parser nemotron_3 --sglang-tool-call-parser qwen3_coder \
  --sglang-chat-template "${SGLANG_CHAT_TEMPLATE}" \
  --sglang-served-model-name nemotron --sglang-router-policy round_robin \
  --use-wandb --wandb-mode online --wandb-team sirajuddin-shaik-007 \
  --wandb-project xyne-polar-grpo \
  --wandb-group nemotron30b-a3b-sebi-pranav-multidoc --wandb-dir "${WANDB_DIR}" \
  --wandb-always-use-train-step --disable-wandb-random-suffix
