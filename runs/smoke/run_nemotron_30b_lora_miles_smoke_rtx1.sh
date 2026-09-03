#!/usr/bin/env bash
set -euo pipefail

# Bounded Nemotron-3-Nano-30B-A3B LoRA smoke for RTX1 GPUs 4-7.
# This launcher deliberately does not kill existing services.

ARL_ROOT="${ARL_ROOT:-/data/siraj/ARL}"
MILES_ROOT="${MILES_ROOT:-$ARL_ROOT/miles}"
MODEL_DIR="${MODEL_DIR:-/data/siraj/hf_models/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16}"
DATA_FILE="${DATA_FILE:-/data/siraj/datasets/dapo_math_17k_slime_100.jsonl}"
OUT_DIR="${OUT_DIR:-/data/siraj/checkpoints/nemotron_30b_lora_miles_smoke_20260810}"
CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-4,5,6,7}"
GPUS_PER_NODE=4
RAY_BIN="$ARL_ROOT/.venv/bin/ray"
PYTHON="$ARL_ROOT/.venv/bin/python"
RAY_PORT="${RAY_PORT:-20001}"
DASHBOARD_PORT="${DASHBOARD_PORT:-8266}"

export ARL_ROOT MILES_ROOT MODEL_DIR DATA_FILE OUT_DIR CUDA_VISIBLE_DEVICES
export GPUS_PER_NODE
export PATH="$ARL_ROOT/.venv/bin:$PATH"
# Miles' current editable install expects the ARL Megatron source tree. The
# bridge-only development tree does not contain the legacy tokenizer module.
export PYTHONPATH="/data/siraj/ARL/Megatron-LM:/data/siraj/Megatron-Bridge/src:$MILES_ROOT:/data/siraj/ARL/slime${PYTHONPATH:+:$PYTHONPATH}"
export CUDA_DEVICE_MAX_CONNECTIONS=1

test -x "$RAY_BIN"
test -x "$PYTHON"
test -d "$MODEL_DIR"
test -s "$DATA_FILE"

source "$MILES_ROOT/scripts/models/nemotron-3-nano-30b-a3b.sh"
mkdir -p "$OUT_DIR"

started_ray=0
cleanup() {
  if [[ "$started_ray" == 1 ]]; then
    "$RAY_BIN" stop --force >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if ! "$RAY_BIN" status >/dev/null 2>&1; then
  "$RAY_BIN" start \
    --head \
    --node-ip-address 127.0.0.1 \
    --port "$RAY_PORT" \
    --dashboard-host 127.0.0.1 \
    --dashboard-port "$DASHBOARD_PORT" \
    --num-gpus "$GPUS_PER_NODE" \
    --disable-usage-stats
  started_ray=1
fi

CKPT_ARGS=(
  --hf-checkpoint "$MODEL_DIR"
  --save "$OUT_DIR"
  --save-interval 1
  --megatron-to-hf-mode bridge
)

LORA_ARGS=(
  --lora-rank 8
  --lora-alpha 16
  --lora-dropout 0.0
  --target-modules "q_proj,k_proj,v_proj,o_proj"
  --megatron-to-hf-mode bridge
)

ROLLOUT_ARGS=(
  --prompt-data "$DATA_FILE"
  --input-key prompt
  --label-key label
  --apply-chat-template
  --rollout-shuffle
  --rm-type deepscaler
  --num-rollout 1
  --rollout-batch-size 1
  --n-samples-per-prompt 2
  --rollout-max-response-len 128
  --rollout-temperature 0.7
  --global-batch-size 2
)

PERF_ARGS=(
  --tensor-model-parallel-size 1
  --pipeline-model-parallel-size 1
  --context-parallel-size 1
  --expert-model-parallel-size 4
  --expert-tensor-parallel-size 1
  --recompute-granularity full
  --recompute-method uniform
  --recompute-num-layers 1
  --use-dynamic-batch-size
  --max-tokens-per-gpu 512
  --log-probs-chunk-size 64
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
  --lr 1e-5
  --lr-decay-style constant
  --weight-decay 0.0
  --adam-beta1 0.9
  --adam-beta2 0.98
)

SGLANG_ARGS=(
  --rollout-num-gpus 4
  --rollout-num-gpus-per-engine 1
  --sglang-mem-fraction-static 0.4
  --use-rollout-routing-replay
)

MISC_ARGS=(
  --attention-dropout 0.0
  --hidden-dropout 0.0
  --accumulate-allreduce-grads-in-fp32
  --attention-softmax-in-fp32
  --attention-backend auto
)

RUNTIME_ENV_JSON=$(cat <<EOF
{"env_vars":{"PATH":"$ARL_ROOT/.venv/bin:/usr/local/bin:/usr/bin:/bin","PYTHONPATH":"$PYTHONPATH","CUDA_DEVICE_MAX_CONNECTIONS":"1","NCCL_ALGO":"Ring"}}
EOF
)

cd "$MILES_ROOT"
"$RAY_BIN" job submit \
  --address="http://127.0.0.1:$DASHBOARD_PORT" \
  --working-dir="$MILES_ROOT" \
  --runtime-env-json="$RUNTIME_ENV_JSON" \
  -- python3 train.py \
  --actor-num-nodes 1 \
  --actor-num-gpus-per-node "$GPUS_PER_NODE" \
  --colocate \
  --calculate-per-token-loss \
  "${MODEL_ARGS[@]}" \
  "${CKPT_ARGS[@]}" \
  "${LORA_ARGS[@]}" \
  "${ROLLOUT_ARGS[@]}" \
  "${OPTIMIZER_ARGS[@]}" \
  "${GRPO_ARGS[@]}" \
  "${PERF_ARGS[@]}" \
  "${SGLANG_ARGS[@]}" \
  "${MISC_ARGS[@]}"
