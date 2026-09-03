#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# COLOCATED GRPO training on the Xyne Q&A composite reward via Polar rollouts
# + Miles (Megatron backend), model = NVIDIA Nemotron-3-Nano-30B-A3B (BF16,
# hybrid MoE/Mamba).
#
# This mirrors the USER-PROVEN COLOCATED 6-GPU recipe:
#   --colocate  |  TP1 PP1 CP1 EP2 ETP1  |  --actor-num-gpus-per-node 6
#   --rollout-num-gpus 6  --rollout-num-gpus-per-engine 1  --num-gpus-per-node 6
#   LoRA rank 8 (q/k/v/o)  |  recompute full/uniform/1  |  max-tokens-per-gpu 512
#   sglang-mem-fraction-static 0.4  |  rollout-batch 1, n-samples 2, resp-len 128
#   global-batch 2 (auto from rollout_batch*n_samples/num_steps)  |  kl-loss-coef 0.0
#
# Reward = COMPOSITE (Polar-side XyneCompositeEvaluator, embedded as scalar
# `score` per trajectory): embedding_similarity(f1 vs reference_answer) +
# tool_call_efficiency + token_efficiency + completion + answer_format +
# retrieval_quality.  Miles just consumes the embedded Polar `score` via
# --reward-key score + the POLAR_ARGS bridge modules.
#
# Runs INSIDE the persistent container `miles-train-xyne` (radixark/miles:latest,
# GPUs 2-7).  Uses the container python3 (/usr/bin/python3) — NOT /root/miles/.venv.
# The Polar rollout server (:8080) + gateway (:8100) and the Xyne backend (:3000)
# are assumed ALREADY RUNNING on the host (network=host reaches them).
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── File-descriptor limit: Ray + Megatron colocated spawns MANY gRPC sockets.
#    The container default soft limit (1024) starves the raylet -> workers fail
#    with "Failed to get the system config from raylet because it is dead"
#    (raylet.err: "File descriptor limit reached"). Raise to the hard limit.
if [ "$(ulimit -n)" -lt 1048576 ]; then
    ulimit -n 1048576 2>/dev/null || ulimit -n 524288 2>/dev/null || true
fi
echo "=== File-descriptor soft limit: $(ulimit -n) ==="

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
PROJECT_ROOT=/root/miles                      # container repo root
RUN_DIR="${RUN_DIR:-${PROJECT_ROOT}/tmp/xyne_qa_colocate}"
mkdir -p "${RUN_DIR}" "${PROJECT_ROOT}/logs"

# ---- Python: use the CONTAINER python (dist-packages has miles+megatron+bridge).
PYTHON_BIN="${PYTHON_BIN:-/usr/bin/python3}"
PYTHON_BIN_DIR="$(dirname -- "${PYTHON_BIN}")"
export PATH="${PYTHON_BIN_DIR}:${PATH}"
MEGATRON_DIR="${MEGATRON_DIR:-/root/Megatron-LM}"
PROJECT_ROOT_PY="${PROJECT_ROOT}"
# PYTHONPATH must put the USER's miles tree first, then the image Megatron tree.
RUNTIME_PYTHONPATH="${MEGATRON_DIR}:${PROJECT_ROOT_PY}"

export PYTHONPATH="${RUNTIME_PYTHONPATH}"
export PYTHONUNBUFFERED=1
export CUDA_DEVICE_MAX_CONNECTIONS=1
export PYTORCH_CUDA_ALLOC_CONF="max_split_size_mb:2048"

detect_host_ip() {
    "${PYTHON_BIN}" - <<'PY'
import socket
try:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.connect(("8.8.8.8", 80))
    print(sock.getsockname()[0]); sock.close()
except Exception:
    try: print(socket.gethostbyname(socket.gethostname()))
    except Exception: print("127.0.0.1")
PY
}

# ── Model & checkpoint paths (container-mounted) ─────────────────────────────
HF_CHECKPOINT="${HF_CHECKPOINT:-/data/siraj/hf_models/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16}"
REF_LOAD="${REF_LOAD:-/data/siraj/ARL/checkpoints/nemotron_3_nano_30b_a3b_torch_dist}"
RUN_ID="${RUN_ID:-xyne-qa-colocate-$(date -u +%Y%m%dT%H%M%SZ)}"
SAVE_ROOT="${SAVE_ROOT:-${PROJECT_ROOT}/tmp/ckpt/xyne_qa_colocate_nemotron30bnano}"
SAVE_DIR="${SAVE_DIR:-${SAVE_ROOT}/${RUN_ID}}"
mkdir -p "$SAVE_DIR"
[ -d "$HF_CHECKPOINT" ] || { echo "ERROR: HF checkpoint missing $HF_CHECKPOINT"; exit 1; }
[ -f "$REF_LOAD/latest_checkpointed_iteration.txt" ] || \
    echo "WARNING: ref-load ckpt missing $REF_LOAD (only needed if --use-kl-loss)"

source "${SCRIPT_DIR}/model_args.sh"

# First run: empty SAVE_DIR → leave --load empty so actor inits from --hf-checkpoint.
if [ -f "$SAVE_DIR/latest_checkpointed_iteration.txt" ]; then
    LOAD_DIR="$SAVE_DIR"
else
    LOAD_DIR=""
fi

# ── Data ─────────────────────────────────────────────────────────────────────
PROMPT_DATA="${PROMPT_DATA:-/data/siraj/xyne_s/xyne_qa_train.jsonl}"
[ -f "$PROMPT_DATA" ] || { echo "ERROR: prompt data missing $PROMPT_DATA"; exit 1; }

# ── Runtime configs / Polar custom config rendering ──────────────────────────
# The Polar task pods are launched by the HOST docker daemon (docker.sock is
# mounted), so AGENT_CLI_DIR / XYNE_SERVER_DIR must be HOST absolute paths.
export AGENT_CLI_DIR="${AGENT_CLI_DIR:-/data/siraj/ARL/miles/tmp/swegym_agent_cli/opt_node}"
export XYNE_SERVER_DIR="${XYNE_SERVER_DIR:-/data/siraj/xyne_s/xyne-search}"
export XYNE_API_KEY="${XYNE_API_KEY:?Set XYNE_API_KEY}"
export XYNE_RUNTIME_IMAGE="${XYNE_RUNTIME_IMAGE:-polar-xyne-runtime:base-e1c2e69e}"

POLAR_CONFIG_TEMPLATE="${POLAR_CONFIG_TEMPLATE:-${SCRIPT_DIR}/polar_config_xyne_qa.yaml}"
CUSTOM_CONFIG_PATH="${CUSTOM_CONFIG_PATH:-${RUN_DIR}/polar_config_custom.yaml}"
mkdir -p "$(dirname "$CUSTOM_CONFIG_PATH")"
envsubst '${AGENT_CLI_DIR} ${XYNE_SERVER_DIR} ${XYNE_API_KEY} ${XYNE_RUNTIME_IMAGE}' \
    < "$POLAR_CONFIG_TEMPLATE" > "$CUSTOM_CONFIG_PATH"

echo "=== Polar custom config rendered to $CUSTOM_CONFIG_PATH ==="
echo "  AGENT_CLI_DIR=$AGENT_CLI_DIR"
echo "  XYNE_SERVER_DIR=$XYNE_SERVER_DIR"
echo "  XYNE_RUNTIME_IMAGE=$XYNE_RUNTIME_IMAGE"

# ── GPU split: COLOCATED — all 6 GPUs share train + sglang (alternating) ─────
ACTOR_NUM_GPUS_PER_NODE="${ACTOR_NUM_GPUS_PER_NODE:-6}"
ROLLOUT_NUM_GPUS="${ROLLOUT_NUM_GPUS:-6}"
ROLLOUT_NUM_GPUS_PER_ENGINE="${ROLLOUT_NUM_GPUS_PER_ENGINE:-1}"   # sglang TP size
NUM_GPUS_PER_NODE="${NUM_GPUS_PER_NODE:-6}"                       # <8 colocate overrides
ROLLOUT_BATCH_SIZE="${ROLLOUT_BATCH_SIZE:-1}"
N_SAMPLES_PER_PROMPT="${N_SAMPLES_PER_PROMPT:-2}"
MAX_TOKENS_PER_GPU="${MAX_TOKENS_PER_GPU:-512}"
NUM_STEPS_PER_ROLLOUT="${NUM_STEPS_PER_ROLLOUT:-1}"

RAY_NUM_GPUS="${RAY_NUM_GPUS:-$ACTOR_NUM_GPUS_PER_NODE}"
RAY_HEAD_IP="${RAY_HEAD_IP:-127.0.0.1}"

echo "=== Starting Ray head on ${RAY_HEAD_IP} (${RAY_NUM_GPUS} GPUs, colocated) ==="
ray stop --force 2>/dev/null || true
sleep 1
ray start --head --node-ip-address "$RAY_HEAD_IP" --num-gpus "$RAY_NUM_GPUS" --disable-usage-stats

RUNTIME_ENV_JSON="{
  \"env_vars\": {
    \"PYTHONPATH\": \"${RUNTIME_PYTHONPATH}\",
    \"PATH\": \"${PYTHON_BIN_DIR}:${PATH}\",
    \"VIRTUAL_ENV\": \"\",
    \"CUDA_DEVICE_MAX_CONNECTIONS\": \"1\",
    \"PYTORCH_CUDA_ALLOC_CONF\": \"max_split_size_mb:2048\",
    \"WANDB_DIR\": \"${PROJECT_ROOT}/logs\"
  }
}"

# ── Argument groups ──────────────────────────────────────────────────────────
CKPT_ARGS=(
    --hf-checkpoint "$HF_CHECKPOINT"
    --ref-load "$REF_LOAD"
    --save "$SAVE_DIR"
    --save-interval "${SAVE_INTERVAL:-1}"
)
if [ -n "$LOAD_DIR" ]; then
    CKPT_ARGS+=(--load "$LOAD_DIR")
fi

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
    --num-rollout "${NUM_ROLLOUT:-1}"
    --rollout-batch-size "$ROLLOUT_BATCH_SIZE"
    --n-samples-per-prompt "$N_SAMPLES_PER_PROMPT"
    --rollout-max-response-len "${ROLLOUT_MAX_RESPONSE_LEN:-128}"
    --rollout-max-prompt-len "${ROLLOUT_MAX_PROMPT_LEN:-2048}"
    --num-steps-per-rollout "$NUM_STEPS_PER_ROLLOUT"
)

# Actor parallelism — COLOCATED proven recipe: TP1 PP1 CP1 EP2 ETP1.
PERF_ARGS=(
    --tensor-model-parallel-size 1
    --pipeline-model-parallel-size 1
    --context-parallel-size 1
    --expert-model-parallel-size 2
    --expert-tensor-parallel-size 1
    --recompute-granularity full
    --recompute-method uniform
    --recompute-num-layers 1
    --use-dynamic-batch-size
    --max-tokens-per-gpu "$MAX_TOKENS_PER_GPU"
    --log-probs-chunk-size "${LOG_PROBS_CHUNK_SIZE:-64}"
    --distributed-timeout-minutes "${DISTRIBUTED_TIMEOUT_MINUTES:-60}"
)

GRPO_ARGS=(
    --advantage-estimator grpo
    --kl-loss-coef 0.0
    --entropy-coef 0.0
    --eps-clip 0.2
    --eps-clip-high 0.28
)

OPTIMIZER_ARGS=(
    --optimizer adam
    --lr "${LR:-1e-5}"
    --lr-decay-style constant
    --weight-decay 0.0
    --adam-beta1 0.9
    --adam-beta2 0.98
    --attention-dropout 0.0
    --hidden-dropout 0.0
    --accumulate-allreduce-grads-in-fp32
    --attention-softmax-in-fp32
    --attention-backend auto
)

# LoRA rank 8 (COLOCATED-proven) + SGLang colocated serving.
SGLANG_ARGS=(
    --lora-rank "${LORA_RANK:-8}"
    --lora-alpha "${LORA_ALPHA:-16}"
    --lora-dropout "${LORA_DROPOUT:-0.0}"
    --target-modules "${LORA_TARGET_MODULES:-q_proj,k_proj,v_proj,o_proj}"
    --sglang-lora-backend triton
    --sglang-mem-fraction-static "${SGLANG_MEM_FRACTION_STATIC:-0.4}"
    --use-rollout-routing-replay
)

# COLOCATE placement flags — these make it colocated (sync train.py, NOT fully-async).
COLOCATE_ARGS=(
    --colocate
)

echo "=== Launching COLOCATED train.py ==="
ray job submit --address="http://${RAY_HEAD_IP}:8265" \
    --runtime-env-json="${RUNTIME_ENV_JSON}" \
    -- "${PYTHON_BIN}" "${PROJECT_ROOT}/train.py" \
    --actor-num-nodes 1 \
    --actor-num-gpus-per-node "$ACTOR_NUM_GPUS_PER_NODE" \
    --rollout-num-gpus "$ROLLOUT_NUM_GPUS" \
    --rollout-num-gpus-per-engine "$ROLLOUT_NUM_GPUS_PER_ENGINE" \
    --num-gpus-per-node "$NUM_GPUS_PER_NODE" \
    "${COLOCATE_ARGS[@]}" \
    "${MODEL_ARGS[@]}" \
    "${CKPT_ARGS[@]}" \
    "${POLAR_ARGS[@]}" \
    "${DATA_ARGS[@]}" \
    "${PERF_ARGS[@]}" \
    "${GRPO_ARGS[@]}" \
    "${OPTIMIZER_ARGS[@]}" \
    "${SGLANG_ARGS[@]}"
