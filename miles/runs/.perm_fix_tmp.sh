#!/usr/bin/env bash
# Multinode Polar/Xyne GRPO run with Megatron-Bridge PEFT.
# Topology: RTX1 has the 8-GPU actor (TP=2, CP=4, PP=1, EP=8); RTX2 GPUs 4-7
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
POLAR_CONFIG_TEMPLATE="/data/siraj/ARL/reward_fix_test/polar_config_xyne_qa.yaml"
TRAIN_PY="${TRAIN_PY:-${PROJECT_ROOT}/train_async_microbatch.py}"
MEGATRON_DIR="/root/Megatron-LM"
PYTHON_BIN="/usr/bin/python3"
RUNTIME_PYTHONPATH="${MEGATRON_DIR}:${PROJECT_ROOT}:/root/miles/polar-pkg"

ACTOR_NUM_GPUS_PER_NODE="${ACTOR_NUM_GPUS_PER_NODE:-8}"
ROLLOUT_NUM_GPUS="${ROLLOUT_NUM_GPUS:-4}"
ROLLOUT_NUM_GPUS_PER_ENGINE="${ROLLOUT_NUM_GPUS_PER_ENGINE:-2}"
SGLANG_CONTEXT_LENGTH="${SGLANG_CONTEXT_LENGTH:-100000}"
ROLLOUT_BATCH_SIZE="${ROLLOUT_BATCH_SIZE:-32}"
N_SAMPLES_PER_PROMPT="${N_SAMPLES_PER_PROMPT:-8}"
NUM_EPOCH="${NUM_EPOCH:-3}"
NUM_STEPS_PER_ROLLOUT="${NUM_STEPS_PER_ROLLOUT:-8}"
GLOBAL_BATCH_SIZE="${GLOBAL_BATCH_SIZE:-32}"
SAVE_INTERVAL="${SAVE_INTERVAL:-1}"
NUM_ROLLOUT="${NUM_ROLLOUT:-}"
EVAL_PROMPT_DATA="${EVAL_PROMPT_DATA:-}"
EVAL_SAMPLES_PER_PROMPT="${EVAL_SAMPLES_PER_PROMPT:-1}"
RECOMPUTE_NUM_LAYERS="${RECOMPUTE_NUM_LAYERS:-52}"
MICRO_BATCH_SIZE="${MICRO_BATCH_SIZE:-1}"
MAX_TOKENS_PER_GPU="${MAX_TOKENS_PER_GPU:-25000}"
ATTENTION_BACKEND="${ATTENTION_BACKEND:-flash}"
SGLANG_MAX_RUNNING_REQUESTS="${SGLANG_MAX_RUNNING_REQUESTS:-128}"
LORA_RANK="${LORA_RANK:-128}"
LORA_ALPHA="${LORA_ALPHA:-256}"
LR="${LR:-5e-6}"
DEBUG_SKIP_WEIGHT_UPDATE="${DEBUG_SKIP_WEIGHT_UPDATE:-0}"
MILES_POLAR_MAX_TRACES_PER_SESSION="${MILES_POLAR_MAX_TRACES_PER_SESSION:-128}"
WANDB_PROJECT="${WANDB_PROJECT:-xyne-polar-grpo}"
WANDB_GROUP="${WANDB_GROUP:-nemotron30b-a3b-sebi-pranav-multidoc}"
WANDB_MODE="${WANDB_MODE:-online}"
WANDB_DIR="${WANDB_DIR:-${PROJECT_ROOT}/tmp/wandb}"

RAY_DASHBOARD_ADDRESS="${RAY_DASHBOARD_ADDRESS:-http://192.168.111.7:8265}"
RUN_ID="${RUN_ID:-sebi-pranav-tp2cp4ep8-lora128-qv-fc1fc2-b32-gbs64-spr16-100k-e3-$(date +%Y%m%d_%H%M%S)}"
RUN_DIR="${PROJECT_ROOT}/tmp/xyne_qa_tp2cp4ep8/${RUN_ID}"
SAVE_DIR="${SAVE_DIR:-${PROJECT_ROOT}/tmp/ckpt/xyne_qa_tp2cp4ep8/${RUN_ID}}"
TRAJECTORY_DUMP_DIR="${TRAJECTORY_DUMP_DIR:-${RUN_DIR}/trajectory_dumps}"
mkdir -p "${RUN_DIR}" "${SAVE_DIR}" "${WANDB_DIR}" "${TRAJECTORY_DUMP_DIR}"

if [[ "${WANDB_MODE}" == "online" ]] \
  && [[ -z "${WANDB_API_KEY:-}" ]] \
  && ! grep -q 'machine api.wandb.ai' "${HOME}/.netrc" 2>/dev/null; then
  echo "W&B login missing: set WANDB_API_KEY or configure ${HOME}/.netrc." >&2
  exit 1
fi

HF_CHECKPOINT="${HF_CHECKPOINT:-/data/siraj/hf_models/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16}"
# Resume anchor: MUST be the iter_0000000 checkpoint from run 20260820_032658.
# Hardcoded (NOT env-dependent) because the launcher's tmux layer strips exported
# env vars, which silently dropped --lora-adapter-path and trained a fresh LoRA.
LORA_ADAPTER_PATH="${LORA_ADAPTER_PATH:-/root/miles/tmp/ckpt/xyne_qa_tp2cp4ep8/sebi-pranav-tp2cp4ep8-lora128-qv-fc1fc2-b32-gbs64-spr16-100k-e3-20260820_032658/iter_0000000/adapter}"
REF_LOAD="${REF_LOAD:-/data/siraj/ARL/checkpoints/nemotron_3_nano_30b_a3b_torch_dist}"
PROMPT_DATA="${PROMPT_DATA:-/data/siraj/ARL/data/sebi_pranav_metadata_graph_train.jsonl}"
AGENT_CLI_DIR="${AGENT_CLI_DIR:-/data/siraj/ARL/miles/tmp/swegym_agent_cli/opt_node}"
XYNE_SERVER_DIR="${XYNE_SERVER_DIR:-/data/siraj/xyne_s/xyne-search}"
XYNE_API_KEY="${XYNE_API_KEY:?Set XYNE_API_KEY or source the credentials file}"
XYNE_RUNTIME_IMAGE="${XYNE_RUNTIME_IMAGE:-polar-xyne-runtime:base-e1c2e69e}"
export AGENT_CLI_DIR XYNE_SERVER_DIR XYNE_API_KEY XYNE_RUNTIME_IMAGE

if ((ROLLOUT_BATCH_SIZE * N_SAMPLES_PER_PROMPT != GLOBAL_BATCH_SIZE * NUM_STEPS_PER_ROLLOUT)); then
  echo "Expected rollout_batch_size * group_size == global_batch_size * num_steps_per_rollout" >&2
  exit 1
fi
if ((ROLLOUT_NUM_GPUS % ROLLOUT_NUM_GPUS_PER_ENGINE != 0)); then
  echo "rollout_num_gpus must be divisible by rollout_num_gpus_per_engine" >&2
  exit 1
fi
if ((MAX_TOKENS_PER_GPU <= 0)); then
  echo "max_tokens_per_gpu must be positive" >&2
  exit 1
fi
for required_path in "${HF_CHECKPOINT}/config.json" "${PROMPT_DATA}" "${AGENT_CLI_DIR}" "${XYNE_SERVER_DIR}"; do
  test -e "${required_path}" || { echo "Missing required path: ${required_path}" >&2; exit 1; }
done

CUSTOM_CONFIG_PATH="${RUN_DIR}/polar_config_custom.yaml"
envsubst < "${POLAR_CONFIG_TEMPLATE}" > "${CUSTOM_CONFIG_PATH}"
# Enforce the 30-minute per-question deadline (XYNE_POLL_TIMEOUT_SECONDS=2700,
# timeout_seconds=2700) so partial answers still get dumped before teardown. The shared
# POLAR_CONFIG_TEMPLATE carries lower default values; patch only this run's copy.
sed -i "s/XYNE_POLL_TIMEOUT_SECONDS: '720'/XYNE_POLL_TIMEOUT_SECONDS: '2700'/; s/timeout_seconds: 900/timeout_seconds: 2700/" "${CUSTOM_CONFIG_PATH}"

export CUDA_VISIBLE_DEVICES=0,1,2,3,4,5,6,7
export PYTHONPATH="${RUNTIME_PYTHONPATH}"
export PYTHONUNBUFFERED=1
export CUDA_DEVICE_MAX_CONNECTIONS=1
export PYTORCH_CUDA_ALLOC_CONF="expandable_segments:True"
export MILES_POLAR_MAX_TRACES_PER_SESSION
export MILES_POLAR_TRAJECTORY_DUMP_DIR="${TRAJECTORY_DUMP_DIR}"
export MILES_SGLANG_DUMMY_LOAD=1
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
    \"MILES_SGLANG_DUMMY_LOAD\": \"1\",
    \"NCCL_SOCKET_IFNAME\": \"${NCCL_SOCKET_IFNAME}\",
    \"GLOO_SOCKET_IFNAME\": \"${GLOO_SOCKET_IFNAME}\",
    \"MILES_POLAR_MAX_TRACES_PER_SESSION\": \"${MILES_POLAR_MAX_TRACES_PER_SESSION}\",
    \"MILES_POLAR_TRAJECTORY_DUMP_DIR\": \"${TRAJECTORY_DUMP_DIR}\",
    \"WANDB_API_KEY\": \"${WANDB_API_KEY:-}\",
    \"WANDB_BASE_URL\": \"${WANDB_BASE_URL:-https://api.wandb.ai}\",
    \"WANDB_MODE\": \"${WANDB_MODE}\",
    \"WANDB_PROJECT\": \"${WANDB_PROJECT}\",
    \"WANDB_GROUP\": \"${WANDB_GROUP}\"
  }
}"

source "${EXAMPLE_DIR}/model_args.sh"

CKPT_ARGS=(
  --load "${SAVE_DIR}"
  --hf-checkpoint "${HF_CHECKPOINT}"
  --no-load-optim
  --no-load-rng
  --finetune
  --megatron-to-hf-mode bridge
  --save "${SAVE_DIR}"
  --save-interval "${SAVE_INTERVAL}"
)
if [[ -n "${LORA_ADAPTER_PATH}" ]]; then
  test -d "${LORA_ADAPTER_PATH}" || { echo "Missing LoRA adapter: ${LORA_ADAPTER_PATH}" >&2; exit 1; }
  CKPT_ARGS+=(--lora-adapter-path "${LORA_ADAPTER_PATH}")
fi

POLAR_ARGS=(
  --rollout-function-path miles.rollout.polar_rollout.generate_rollout_polar_async_microbatch
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
  --num-steps-per-rollout "${NUM_STEPS_PER_ROLLOUT}"
)
if [[ -n "${NUM_ROLLOUT}" ]]; then
  DATA_ARGS+=(--num-rollout "${NUM_ROLLOUT}")
fi
if [[ -n "${EVAL_PROMPT_DATA}" ]]; then
  test -f "${EVAL_PROMPT_DATA}" || { echo "Missing eval data: ${EVAL_PROMPT_DATA}" >&2; exit 1; }
  DATA_ARGS+=(
    --eval-interval 1
    --eval-prompt-data xyne-heldout "${EVAL_PROMPT_DATA}"
    --n-samples-per-eval-prompt "${EVAL_SAMPLES_PER_PROMPT}"
  )
fi

# Eight actor ranks: TP2 x CP4, with routed experts spanning EP8. CP4 shards
# each long cumulative trajectory across four ranks. PP stays 1 because Miles'
# native distributed LoRA weight sync does not support pipeline parallelism.
PARALLEL_ARGS=(
  --tensor-model-parallel-size 2
  --sequence-parallel
  --qkv-format bshd
  --pipeline-model-parallel-size 1
  --context-parallel-size 4
  --expert-model-parallel-size 8
  --expert-tensor-parallel-size 1
  --recompute-granularity full
  --recompute-method uniform
  --recompute-num-layers "${RECOMPUTE_NUM_LAYERS}"
  # Expert LoRA substantially increases MoE activation residency. Keep the
  # effective batch at GLOBAL_BATCH_SIZE through gradient accumulation while
  # using a single sample per forward/backward microbatch.
  --micro-batch-size "${MICRO_BATCH_SIZE}"
  # CP4 gives a 128K per-trace admission limit: 4 * 32,768 tokens.
  # The Polar adapter drops later cumulative traces above this boundary before
  # they reach Megatron's dynamic batcher, preventing trajectory-driven OOMs.
  --max-tokens-per-gpu "${MAX_TOKENS_PER_GPU}"
  --moe-token-dispatcher-type alltoall
  --log-probs-chunk-size 16
  --distributed-timeout-minutes 60
)

GRPO_ARGS=(
  --advantage-estimator grpo
  --normalize-advantages
  --use-rollout-logprobs
  --entropy-coef 0.001
  --eps-clip 0.2
  --eps-clip-high 0.28
  --use-kl-loss --kl-loss-coef 0.05 --kl-loss-type low_var_kl
  --ref-load "${REF_LOAD}"
  --dynamic-sampling-filter-path miles.rollout.filter_hub.dynamic_sampling_filters.check_reward_nonzero_std
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
  --attention-backend "${ATTENTION_BACKEND}"
  --update-weight-transfer-mode broadcast
)
if [[ "${DEBUG_SKIP_WEIGHT_UPDATE}" == "1" ]]; then
  OPTIMIZER_ARGS+=(--debug-skip-weight-update)
fi

# Keep Q/V attention adapters, remove K/O to make memory room, and add FC2.
# Bridge maps down_proj to linear_fc2, including routed experts.
LORA_ARGS=(
  --lora-rank "${LORA_RANK}"
  --lora-alpha "${LORA_ALPHA}"
  --lora-dropout 0.0
  --target-modules q_proj,v_proj,gate_proj,up_proj,down_proj
  --sglang-lora-backend triton
  --sglang-moe-runner-backend triton
  --sglang-mem-fraction-static 0.75
  --sglang-max-running-requests "${SGLANG_MAX_RUNNING_REQUESTS}"
  --sglang-context-length "${SGLANG_CONTEXT_LENGTH}"
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
echo "=== topology: RTX1 ${ACTOR_NUM_GPUS_PER_NODE} actor (TP2 CP4 PP1 EP8) + RTX2 ${ROLLOUT_NUM_GPUS} inference (2x TP2) ==="
echo "=== GRPO: rollout_batch=${ROLLOUT_BATCH_SIZE}, group_size=${N_SAMPLES_PER_PROMPT}, global_batch=${GLOBAL_BATCH_SIZE}, steps_per_rollout=${NUM_STEPS_PER_ROLLOUT}, epochs=${NUM_EPOCH} ==="
echo "=== Checkpoint cadence: every ${SAVE_INTERVAL} rollout rounds ($((SAVE_INTERVAL * NUM_STEPS_PER_ROLLOUT)) optimizer steps) ==="
echo "=== Dataset: ${PROMPT_DATA} (Pranav repaired multi-document graph QA) ==="
echo "=== LoRA: actor rank=${LORA_RANK}, alpha=${LORA_ALPHA}, targets=q_proj,v_proj,gate_proj,up_proj,down_proj(FC1+FC2) ==="
echo "=== Context: SGLang=${SGLANG_CONTEXT_LENGTH}, actor CP4 admission=$((4 * MAX_TOKENS_PER_GPU)) ==="
echo "=== Actor attention backend: ${ATTENTION_BACKEND} ==="
echo "=== Trajectory dumps: ${TRAJECTORY_DUMP_DIR} (compressed JSONL, every trace) ==="
echo "=== W&B: project=${WANDB_PROJECT}, group=${WANDB_GROUP}, mode=${WANDB_MODE} ==="

ray job submit --address="${RAY_DASHBOARD_ADDRESS}" \
  --no-wait \
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
