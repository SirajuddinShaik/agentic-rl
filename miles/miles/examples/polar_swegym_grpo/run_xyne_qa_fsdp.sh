#!/usr/bin/env bash
# =============================================================================
# Disaggregated GRPO Launcher — Nemotron-3-Nano-30B-A3B, LoRA rank 8
# BACKEND: megatron-FSDP (--train-backend fsdp) — FSDP2 shards weights/grads/optimizer
#   across the 4 actor ranks (30B/4 ~ 7.5B/rank) to fix the bridge TP4/EP4 OOM
#   (bridge never sharded: each rank held the full 30B -> 130GB > 95GB).
#   -> Actor (worker): 4 GPUs (2,3,4,5)  FSDP2, world_size 4
#   -> Inference:      2 GPUs (6,7)      sglang engine TP=2
# Reward: Polar/Xyne composite (score) via XyneCompositeEvaluator
# =============================================================================
set -euo pipefail

# Container file-descriptor fix: raise soft ulimit so the raylet can serve all
# colocated/distributed workers (default container soft limit 1024 -> OOM/EADDR).
if [ "$(ulimit -n)" -lt 1048576 ]; then
  ulimit -n 1048576 2>/dev/null || ulimit -n 524288 2>/dev/null || true
fi
echo "=== File-descriptor soft limit: $(ulimit -n) ==="

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TRAIN_PY="${PROJECT_ROOT}/train.py"
MEGATRON_DIR="/root/Megatron-LM"
PYTHON_BIN="/usr/bin/python3"          # container python, NOT /root/miles/.venv
PYTHON_BIN_DIR="/usr/bin"
RUNTIME_PYTHONPATH="${MEGATRON_DIR}:${PROJECT_ROOT}:/root/miles/polar-pkg"

# ── GPU split (USER DIRECTIVE: 4 for actor, 2 for inference) ────────────────
ACTOR_NUM_GPUS_PER_NODE="${ACTOR_NUM_GPUS_PER_NODE:-4}"   # GPUs 2,3,4,5
ROLLOUT_NUM_GPUS="${ROLLOUT_NUM_GPUS:-2}"                 # GPUs 6,7
ROLLOUT_NUM_GPUS_PER_ENGINE="${ROLLOUT_NUM_GPUS_PER_ENGINE:-2}"  # TP=2 -> 1 engine
ROLLOUT_BATCH_SIZE="${ROLLOUT_BATCH_SIZE:-1}"
N_SAMPLES_PER_PROMPT="${N_SAMPLES_PER_PROMPT:-2}"
MAX_TOKENS_PER_GPU="${MAX_TOKENS_PER_GPU:-512}"
SGLANG_CONTEXT_LENGTH="${SGLANG_CONTEXT_LENGTH:-50000}"
SGLANG_MEM_FRACTION_STATIC="${SGLANG_MEM_FRACTION_STATIC:-0.4}"
LORA_RANK="${LORA_RANK:-8}"
LR="${LR:-1e-5}"
NUM_ROLLOUT="${NUM_ROLLOUT:-1}"

RAY_NUM_GPUS="$((ACTOR_NUM_GPUS_PER_NODE + ROLLOUT_NUM_GPUS))"
RUN_ID="$(date +%Y%m%d_%H%M%S)"
RUN_DIR="${PROJECT_ROOT}/tmp/xyne_fsdp/${RUN_ID}"
mkdir -p "$RUN_DIR"

CKPT_DIR="${CKPT_DIR:-${PROJECT_ROOT}/tmp/ckpt/xyne_qa_fsdp_nemotron30bnano}"
SAVE_DIR="${SAVE_DIR:-${CKPT_DIR}/${RUN_ID}}"

HF_CHECKPOINT="${HF_CHECKPOINT:-/data/siraj/hf_models/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16}"
REF_LOAD="${REF_LOAD:-/data/siraj/hf_models/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16}"
PROMPT_DATA="${PROMPT_DATA:-/data/siraj/xyne_s/xyne_qa_train.jsonl}"

# ── Polar config envsubst (4 vars) ──────────────────────────────────────────
AGENT_CLI_DIR="${AGENT_CLI_DIR:-/data/siraj/ARL/miles/tmp/swegym_agent_cli/opt_node}"
XYNE_SERVER_DIR="${XYNE_SERVER_DIR:-/data/siraj/xyne_s/xyne-search}"
XYNE_API_KEY="${XYNE_API_KEY:?Set XYNE_API_KEY}"
XYNE_RUNTIME_IMAGE="${XYNE_RUNTIME_IMAGE:-polar-xyne-runtime:withwait}"
export AGENT_CLI_DIR XYNE_SERVER_DIR XYNE_API_KEY XYNE_RUNTIME_IMAGE
CUSTOM_CONFIG_PATH="${RUN_DIR}/polar_config_custom.yaml"
envsubst < "${SCRIPT_DIR}/polar_config_xyne_qa.yaml" > "$CUSTOM_CONFIG_PATH"
echo "=== Rendered polar config: $CUSTOM_CONFIG_PATH ==="
sed -n 1,40p "$CUSTOM_CONFIG_PATH"

export CUDA_VISIBLE_DEVICES=2,3,4,5,6,7
echo "=== CUDA_VISIBLE_DEVICES=${CUDA_VISIBLE_DEVICES} (container sees all 8; pinned to our 6) ==="

# ── Ray ─────────────────────────────────────────────────────────────────────
echo "=== Starting Ray on 127.0.0.1 (${RAY_NUM_GPUS} GPUs; actor ${ACTOR_NUM_GPUS_PER_NODE} + rollout ${ROLLOUT_NUM_GPUS}) ==="
ray stop --force 2>/dev/null || true
sleep 1
ray start --head --node-ip-address 127.0.0.1 --num-gpus "$RAY_NUM_GPUS" --disable-usage-stats

RUNTIME_ENV_JSON="{
  \"env_vars\": {
    \"PYTHONPATH\": \"${RUNTIME_PYTHONPATH}\",
    \"PATH\": \"${PYTHON_BIN_DIR}:${PATH}\",
    \"VIRTUAL_ENV\": \"\",
    \"CUDA_VISIBLE_DEVICES\": \"2,3,4,5,6,7\",
    \"PYTORCH_CUDA_ALLOC_CONF\": \"expandable_segments:True\",
    \"LD_LIBRARY_PATH\": \"\"
  }
}"

# ── Argument groups ─────────────────────────────────────────────────────────
source "${SCRIPT_DIR}/model_args.sh"   # Nemotron MODEL_ARGS

CKPT_ARGS=(
    --hf-checkpoint "$HF_CHECKPOINT"
    --ref-load "$REF_LOAD"
    --save "$SAVE_DIR"
    --save-interval 1
)

POLAR_ARGS=(
    --rollout-function-path miles.rollout.polar_rollout.generate_rollout_polar_async
    --custom-rm-path miles.rollout.polar_reward.custom_rm
    --custom-reward-post-process-path miles.rollout.polar_reward.post_process_rewards
    --custom-config-path "$CUSTOM_CONFIG_PATH"
    --data-source-path miles.rollout.polar_data_source.CeilEpochRolloutDataSourceWithBuffer
)

DATA_ARGS=(
    --prompt-data "$PROMPT_DATA"
    --input-key prompt
    --label-key label
    --metadata-key metadata
    --rollout-shuffle
    --reward-key score
    --num-rollout "$NUM_ROLLOUT"
    --rollout-batch-size "$ROLLOUT_BATCH_SIZE"
    --n-samples-per-prompt "$N_SAMPLES_PER_PROMPT"
    --rollout-max-response-len 128
    --rollout-max-prompt-len 2048
    --num-steps-per-rollout 1
)

# FSDP2 backend: shard 30B across the 4 actor ranks. No TP/EP/recompute-megatron
# (megatron-only flags are rejected by the FSDP parser). FSDP shards weights+grads+optimizer.
FSDP_ARGS=(
    --train-backend fsdp
    --update-weight-buffer-size 536870912
    --gradient-checkpointing
    --attn-implementation flash_attention_2
)

PERF_ARGS=(
    --use-dynamic-batch-size
    --max-tokens-per-gpu "$MAX_TOKENS_PER_GPU"
    --log-probs-chunk-size 64
    --distributed-timeout-minutes 60
)

GRPO_ARGS=(
    --advantage-estimator grpo
    --normalize-advantages
    --use-tis
    --entropy-coef 0.0
    --eps-clip 0.2
    --eps-clip-high 0.28
    --kl-loss-coef 0.0
)

OPTIMIZER_ARGS=(
    --optimizer adam
    --lr "$LR"
    --lr-decay-style constant
    --weight-decay 0.0
    --adam-beta1 0.9
    --adam-beta2 0.98
)

SGLANG_ARGS=(
    --lora-rank "$LORA_RANK"
    --lora-alpha 16
    --lora-dropout 0.0
    --target-modules q_proj,k_proj,v_proj,o_proj
    --sglang-lora-backend triton
    --sglang-mem-fraction-static "$SGLANG_MEM_FRACTION_STATIC"
    --sglang-context-length "$SGLANG_CONTEXT_LENGTH"
    --sglang-router-port 30100
    --sglang-router-policy round_robin
)

echo "=== Launching train.py (megatron-FSDP | 4 actor + 2 inference | polar composite reward) ==="
ray job submit --address="http://127.0.0.1:8265" \
    --runtime-env-json="${RUNTIME_ENV_JSON}" \
    -- "${PYTHON_BIN}" "$TRAIN_PY" \
    --actor-num-nodes 1 \
    --actor-num-gpus-per-node "$ACTOR_NUM_GPUS_PER_NODE" \
    --rollout-num-gpus "$ROLLOUT_NUM_GPUS" \
    --rollout-num-gpus-per-engine "$ROLLOUT_NUM_GPUS_PER_ENGINE" \
    "${CKPT_ARGS[@]}" \
    "${POLAR_ARGS[@]}" \
    "${DATA_ARGS[@]}" \
    "${FSDP_ARGS[@]}" \
    "${PERF_ARGS[@]}" \
    "${GRPO_ARGS[@]}" \
    "${OPTIMIZER_ARGS[@]}" \
    "${SGLANG_ARGS[@]}"
