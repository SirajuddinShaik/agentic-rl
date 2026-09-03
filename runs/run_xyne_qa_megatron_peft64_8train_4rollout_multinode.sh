#!/usr/bin/env bash
# Multinode Polar/Xyne GRPO run with Megatron-Bridge PEFT.
# Topology: RTX1 has the 8-GPU actor (TP=8, PP=1, EP=8); RTX2 GPUs 4-7
# host two TP=2 SGLang rollout engines.
# Unlike the FSDP launcher, --lora-rank is applied to the actor by Bridge before
# DDP/optimizer construction, so Adam only owns adapter parameters.
set -euo pipefail
umask 077

if [ "$(ulimit -n)" -lt 1048576 ]; then
  ulimit -n 1048576 2>/dev/null || ulimit -n 524288 2>/dev/null || true
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="/root/miles"
EXAMPLE_DIR="${PROJECT_ROOT}/miles/examples/polar_swegym_grpo"
POLAR_CONFIG_TEMPLATE="${EXAMPLE_DIR}/polar_config_xyne_qa.yaml"
TRAIN_PY="${PROJECT_ROOT}/train.py"
MEGATRON_DIR="/root/Megatron-LM"
PYTHON_BIN="/usr/bin/python3"
RUNTIME_PYTHONPATH="${MEGATRON_DIR}:${PROJECT_ROOT}:/root/miles/polar-pkg"

ACTOR_NUM_GPUS_PER_NODE="${ACTOR_NUM_GPUS_PER_NODE:-8}"
ROLLOUT_NUM_GPUS="${ROLLOUT_NUM_GPUS:-4}"
ROLLOUT_NUM_GPUS_PER_ENGINE="${ROLLOUT_NUM_GPUS_PER_ENGINE:-2}"
ROLLOUT_BATCH_SIZE="${ROLLOUT_BATCH_SIZE:-32}"
N_SAMPLES_PER_PROMPT="${N_SAMPLES_PER_PROMPT:-8}"
NUM_EPOCH="${NUM_EPOCH:-1}"
GLOBAL_BATCH_SIZE="${GLOBAL_BATCH_SIZE:-256}"
MICRO_BATCH_SIZE="${MICRO_BATCH_SIZE:-1}"
LORA_RANK="${LORA_RANK:-64}"
LORA_ALPHA="${LORA_ALPHA:-128}"
LR="${LR:-1e-5}"
MILES_POLAR_MAX_TRACES_PER_SESSION="${MILES_POLAR_MAX_TRACES_PER_SESSION:-128}"
WANDB_PROJECT="${WANDB_PROJECT:-xyne-polar-grpo}"
WANDB_GROUP="${WANDB_GROUP:-nemotron30b-a3b-xyne-agentic}"
WANDB_MODE="${WANDB_MODE:-online}"
WANDB_DIR="${WANDB_DIR:-${PROJECT_ROOT}/tmp/wandb}"

RAY_DASHBOARD_ADDRESS="${RAY_DASHBOARD_ADDRESS:-http://192.168.111.7:8265}"
RUN_ID="${RUN_ID:-xyne-qa-8train-4rollout-lora64-$(date +%Y%m%d_%H%M%S)}"
RUN_DIR="${PROJECT_ROOT}/tmp/xyne_qa_8train_4rollout/${RUN_ID}"
SAVE_DIR="${SAVE_DIR:-${PROJECT_ROOT}/tmp/ckpt/xyne_qa_8train_4rollout/${RUN_ID}}"
mkdir -p "${RUN_DIR}" "${SAVE_DIR}" "${WANDB_DIR}"

if [[ "${WANDB_MODE}" == "online" ]] && ! grep -q 'machine api.wandb.ai' "${HOME}/.netrc" 2>/dev/null; then
  echo "W&B login missing. Run scripts/setup_wandb_credentials.sh first." >&2
  exit 1
fi

HF_CHECKPOINT="${HF_CHECKPOINT:-/data/siraj/hf_models/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16}"
PROMPT_DATA="${PROMPT_DATA:-/data/siraj/xyne_s/xyne_qa_train.jsonl}"
AGENT_CLI_DIR="${AGENT_CLI_DIR:-/data/siraj/ARL/miles/tmp/swegym_agent_cli/opt_node}"
XYNE_SERVER_DIR="${XYNE_SERVER_DIR:-/data/siraj/xyne_s/xyne-search}"
XYNE_API_KEY="${XYNE_API_KEY:?Set XYNE_API_KEY or source the credentials file}"
XYNE_RUNTIME_IMAGE="${XYNE_RUNTIME_IMAGE:-polar-xyne-runtime:withwait}"
export AGENT_CLI_DIR XYNE_SERVER_DIR XYNE_API_KEY XYNE_RUNTIME_IMAGE

if ((ROLLOUT_BATCH_SIZE * N_SAMPLES_PER_PROMPT != GLOBAL_BATCH_SIZE)); then
  echo "Expected rollout_batch_size * group_size == global_batch_size" >&2
  exit 1
fi
if ((ROLLOUT_NUM_GPUS % ROLLOUT_NUM_GPUS_PER_ENGINE != 0)); then
  echo "rollout_num_gpus must be divisible by rollout_num_gpus_per_engine" >&2
  exit 1
fi
for required_path in "${HF_CHECKPOINT}/config.json" "${PROMPT_DATA}" "${AGENT_CLI_DIR}" "${XYNE_SERVER_DIR}"; do
  test -e "${required_path}" || { echo "Missing required path: ${required_path}" >&2; exit 1; }
done

CUSTOM_CONFIG_PATH="${RUN_DIR}/polar_config_custom.yaml"
envsubst < "${POLAR_CONFIG_TEMPLATE}" > "${CUSTOM_CONFIG_PATH}"

export CUDA_VISIBLE_DEVICES=0,1,2,3,4,5,6,7
export PYTHONPATH="${RUNTIME_PYTHONPATH}"
export PYTHONUNBUFFERED=1
export CUDA_DEVICE_MAX_CONNECTIONS=1
export PYTORCH_CUDA_ALLOC_CONF="expandable_segments:True"
export MILES_POLAR_MAX_TRACES_PER_SESSION
export NCCL_SOCKET_IFNAME="${NCCL_SOCKET_IFNAME:-enp193s0f0np0}"
export GLOO_SOCKET_IFNAME="${GLOO_SOCKET_IFNAME:-enp193s0f0np0}"

# The 8+4 Ray cluster is managed outside this script. Restarting Ray here would
# disconnect RTX2 and silently collapse the run back to one node.
ray status | grep -q "0.0/12.0 GPU" || {
  echo "Expected a healthy 12-GPU Ray cluster at ${RAY_DASHBOARD_ADDRESS}" >&2
  ray status >&2 || true
  exit 1
}

RUNTIME_ENV_JSON="{
  \"env_vars\": {
    \"PYTHONPATH\": \"${RUNTIME_PYTHONPATH}\",
    \"PATH\": \"/usr/bin:${PATH}\",
    \"VIRTUAL_ENV\": \"\",
    \"CUDA_DEVICE_MAX_CONNECTIONS\": \"1\",
    \"PYTORCH_CUDA_ALLOC_CONF\": \"expandable_segments:True\",
    \"NCCL_SOCKET_IFNAME\": \"${NCCL_SOCKET_IFNAME}\",
    \"GLOO_SOCKET_IFNAME\": \"${GLOO_SOCKET_IFNAME}\",
    \"MILES_POLAR_MAX_TRACES_PER_SESSION\": \"${MILES_POLAR_MAX_TRACES_PER_SESSION}\",
    \"WANDB_MODE\": \"${WANDB_MODE}\",
    \"WANDB_PROJECT\": \"${WANDB_PROJECT}\",
    \"WANDB_GROUP\": \"${WANDB_GROUP}\"
  }
}"

source "${EXAMPLE_DIR}/model_args.sh"

CKPT_ARGS=(
  --hf-checkpoint "${HF_CHECKPOINT}"
  --no-load-optim
  --no-load-rng
  --finetune
  --megatron-to-hf-mode bridge
  --save "${SAVE_DIR}"
  --save-interval "${SAVE_INTERVAL:-50}"
)

POLAR_ARGS=(
  --rollout-function-path miles.rollout.polar_rollout.generate_rollout_polar_async
  --custom-rm-path miles.rollout.polar_reward.custom_rm
  --custom-reward-post-process-path miles.rollout.polar_reward.post_process_rewards
  --custom-config-path "${CUSTOM_CONFIG_PATH}"
  --data-source-path miles.rollout.polar_data_source.CeilEpochRolloutDataSourceWithBuffer
)

DATA_ARGS=(
  --prompt-data "${PROMPT_DATA}"
  --input-key prompt
  --label-key label
  --metadata-key metadata
  --rollout-shuffle
  --reward-key score
  --num-epoch "${NUM_EPOCH}"
  --rollout-batch-size "${ROLLOUT_BATCH_SIZE}"
  --n-samples-per-prompt "${N_SAMPLES_PER_PROMPT}"
  --global-batch-size "${GLOBAL_BATCH_SIZE}"
  --rollout-max-response-len 128
  --rollout-max-prompt-len 2048
  --num-steps-per-rollout 1
)

# Eight actor ranks: TP=8 with EP=8, so both dense tensors and routed experts
# span all eight ranks. PP must remain 1 because Miles'
# native distributed LoRA weight sync does not support pipeline parallelism.
PARALLEL_ARGS=(
  --tensor-model-parallel-size 8
  --sequence-parallel
  --qkv-format bshd
  --pipeline-model-parallel-size 1
  --context-parallel-size 1
  --expert-model-parallel-size 8
  --expert-tensor-parallel-size 1
  --recompute-granularity full
  --recompute-method uniform
  --recompute-num-layers 2
  # Expert LoRA substantially increases MoE activation residency. Keep the
  # effective batch at GLOBAL_BATCH_SIZE through gradient accumulation while
  # using a single sample per forward/backward microbatch.
  --micro-batch-size "${MICRO_BATCH_SIZE}"
  --moe-token-dispatcher-type alltoall
  --log-probs-chunk-size 16
  --distributed-timeout-minutes 60
)

GRPO_ARGS=(
  --advantage-estimator grpo
  --normalize-advantages
  --use-rollout-logprobs
  --entropy-coef 0.0
  --eps-clip 0.2
  --eps-clip-high 0.28
)

OPTIMIZER_ARGS=(
  --optimizer adam
  --lr "${LR}"
  --lr-decay-style constant
  --weight-decay 0.0
  --adam-beta1 0.9
  --adam-beta2 0.98
  --attention-dropout 0.0
  --hidden-dropout 0.0
  --accumulate-allreduce-grads-in-fp32
  --attention-softmax-in-fp32
  --attention-backend auto
  --update-weight-transfer-mode broadcast
)

# This is actor-side PEFT, not only SGLang serving configuration. The MLP
# projections also match Nemotron's routed expert leaves, so expert LoRA is
# enabled together with the dense attention projections.
LORA_ARGS=(
  --lora-rank "${LORA_RANK}"
  --lora-alpha "${LORA_ALPHA}"
  --lora-dropout 0.0
  --target-modules q_proj,k_proj,v_proj,o_proj,gate_proj,up_proj,down_proj
  --sglang-lora-backend triton
  --sglang-moe-runner-backend triton
  --sglang-mem-fraction-static 0.75
  --sglang-context-length 262144
  --sglang-kv-cache-dtype fp8_e4m3
  --sglang-reasoning-parser nemotron_3
  --sglang-tool-call-parser qwen3_coder
  --sglang-router-port 30100
  --sglang-router-policy round_robin
)

TRACKING_ARGS=(
  --use-wandb
  --wandb-mode "${WANDB_MODE}"
  --wandb-project "${WANDB_PROJECT}"
  --wandb-group "${WANDB_GROUP}"
  --wandb-dir "${WANDB_DIR}"
  --wandb-always-use-train-step
  --disable-wandb-random-suffix
)

echo "=== Megatron-Bridge PEFT GRPO real run ==="
echo "=== topology: RTX1 ${ACTOR_NUM_GPUS_PER_NODE} actor (TP8 PP1 EP8) + RTX2 ${ROLLOUT_NUM_GPUS} inference (2x TP2) ==="
echo "=== GRPO: rollout_batch=${ROLLOUT_BATCH_SIZE}, group_size=${N_SAMPLES_PER_PROMPT}, global_batch=${GLOBAL_BATCH_SIZE}, epochs=${NUM_EPOCH} ==="
echo "=== LoRA: actor rank=${LORA_RANK}, alpha=${LORA_ALPHA}, targets=attention+MLP/expert projections ==="
echo "=== W&B: project=${WANDB_PROJECT}, group=${WANDB_GROUP}, mode=${WANDB_MODE} ==="

ray job submit --address="${RAY_DASHBOARD_ADDRESS}" \
  --runtime-env-json="${RUNTIME_ENV_JSON}" \
  -- "${PYTHON_BIN}" "${TRAIN_PY}" \
  --actor-num-nodes 1 \
  --actor-num-gpus-per-node "${ACTOR_NUM_GPUS_PER_NODE}" \
  --rollout-num-gpus "${ROLLOUT_NUM_GPUS}" \
  --rollout-num-gpus-per-engine "${ROLLOUT_NUM_GPUS_PER_ENGINE}" \
  --train-backend megatron \
  "${MODEL_ARGS[@]}" \
  "${CKPT_ARGS[@]}" \
  "${POLAR_ARGS[@]}" \
  "${DATA_ARGS[@]}" \
  "${PARALLEL_ARGS[@]}" \
  "${GRPO_ARGS[@]}" \
  "${OPTIMIZER_ARGS[@]}" \
  "${LORA_ARGS[@]}" \
  "${TRACKING_ARGS[@]}"
