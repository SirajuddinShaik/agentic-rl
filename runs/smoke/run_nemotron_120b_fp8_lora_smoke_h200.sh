#!/usr/bin/env bash
set -euo pipefail

MILES_ROOT="${MILES_ROOT:-/root/miles}"
MODEL_DIR="${MODEL_DIR:-/data/aicloud/hf_models/NVIDIA-Nemotron-3-Super-120B-A12B-FP8}"
DATA_FILE="${DATA_FILE:-/root/miles/tmp/nemotron_120b_fp8_smoke_data.jsonl}"
RAY_ADDRESS="${RAY_ADDRESS:-http://127.0.0.1:8265}"
RUN_ID="${RUN_ID:-nemotron-120b-fp8-lora-smoke-$(date +%Y%m%d_%H%M%S)}"
EXPECTED_SHARDS="${EXPECTED_SHARDS:-26}"
LORA_RANK="${LORA_RANK:-32}"
LORA_ALPHA="${LORA_ALPHA:-64}"
SGLANG_MEM_FRACTION="${SGLANG_MEM_FRACTION:-0.78}"
SGLANG_MAX_RUNNING_REQUESTS="${SGLANG_MAX_RUNNING_REQUESTS:-1}"

export PYTHONPATH="/root/Megatron-LM:${MILES_ROOT}${PYTHONPATH:+:${PYTHONPATH}}"
export CUDA_DEVICE_MAX_CONNECTIONS=1
export NVTE_FP8_BLOCK_SCALING_FP32_SCALES=1
export TORCH_NCCL_ASYNC_ERROR_HANDLING=1
export NCCL_SOCKET_IFNAME="${NCCL_SOCKET_IFNAME:-tailscale0}"
export GLOO_SOCKET_IFNAME="${GLOO_SOCKET_IFNAME:-tailscale0}"
export NCCL_IB_DISABLE="${NCCL_IB_DISABLE:-1}"
export NCCL_INET_FAMILY="${NCCL_INET_FAMILY:-AF_INET}"
export NCCL_SOCKET_FAMILY="${NCCL_SOCKET_FAMILY:-AF_INET}"
export NCCL_CUMEM_ENABLE="${NCCL_CUMEM_ENABLE:-0}"
export TORCH_NCCL_AVOID_RECORD_STREAMS="${TORCH_NCCL_AVOID_RECORD_STREAMS:-1}"

test -d "${MODEL_DIR}"
test -f "${MODEL_DIR}/config.json"
test -f "${MODEL_DIR}/chat_template.jinja"
shard_count="$(find -L "${MODEL_DIR}" -maxdepth 1 -type f -name 'model-*.safetensors' | wc -l)"
[[ "${shard_count}" == "${EXPECTED_SHARDS}" ]] || {
  echo "Refusing to start: expected ${EXPECTED_SHARDS} shards, found ${shard_count}" >&2
  exit 2
}

mkdir -p "$(dirname "${DATA_FILE}")"
if [[ ! -s "${DATA_FILE}" ]]; then
  python3 - "${DATA_FILE}" <<'PY'
import json
import sys
from pathlib import Path
rows = [
    {"prompt": "What is 17 + 25? Reply with only the answer.", "label": "42"},
    {"prompt": "What is 9 * 6? Reply with only the answer.", "label": "54"},
]
with Path(sys.argv[1]).open("w", encoding="utf-8") as handle:
    for row in rows:
        handle.write(json.dumps(row, ensure_ascii=False) + "\n")
PY
fi

TP_SIZE="${TP_SIZE:-4}"
PP_SIZE="${PP_SIZE:-1}"
CP_SIZE="${CP_SIZE:-2}"
EP_SIZE="${EP_SIZE:-8}"
ETP_SIZE="${ETP_SIZE:-1}"
ACTOR_GPUS=8
(( TP_SIZE * PP_SIZE * CP_SIZE == ACTOR_GPUS )) || { echo "Invalid dense layout" >&2; exit 2; }
(( ETP_SIZE * EP_SIZE * PP_SIZE == ACTOR_GPUS )) || { echo "Invalid expert layout" >&2; exit 2; }

source "${MILES_ROOT}/scripts/models/nemotron-3-super-120b-a12b.sh"

CKPT_ARGS=(--hf-checkpoint "${MODEL_DIR}" --megatron-to-hf-mode bridge)
LORA_ARGS=(--lora-rank "${LORA_RANK}" --lora-alpha "${LORA_ALPHA}" --lora-dropout 0.0 --lora-a-init-method xavier --lora-b-init-method zero --target-modules q_proj,v_proj,gate_proj,up_proj,down_proj)
ROLLOUT_ARGS=(--prompt-data "${DATA_FILE}" --input-key prompt --label-key label --apply-chat-template --rm-type deepscaler --num-rollout 1 --rollout-batch-size 1 --n-samples-per-prompt 2 --rollout-max-prompt-len 512 --rollout-max-response-len 256 --rollout-max-context-len 1024 --rollout-temperature 1 --global-batch-size 2 --num-steps-per-rollout 1)
PERF_ARGS=(--moe-token-dispatcher-type allgather --tensor-model-parallel-size "${TP_SIZE}" --sequence-parallel --pipeline-model-parallel-size "${PP_SIZE}" --context-parallel-size "${CP_SIZE}" --expert-model-parallel-size "${EP_SIZE}" --expert-tensor-parallel-size "${ETP_SIZE}" --recompute-granularity full --recompute-method uniform --recompute-num-layers 1 --micro-batch-size 1 --log-probs-chunk-size 128)
GRPO_ARGS=(--advantage-estimator grpo --kl-loss-coef 0.0 --entropy-coef 0.001 --eps-clip 0.2 --eps-clip-high 0.28)
PRECISION_ARGS=(--transformer-impl transformer_engine --bf16 --fp8-format e4m3 --fp8-recipe blockwise --accumulate-allreduce-grads-in-fp32 --attention-softmax-in-fp32 --use-precision-aware-optimizer --main-grads-dtype fp32 --main-params-dtype fp16 --exp-avg-dtype fp16 --exp-avg-sq-dtype fp16)
OPTIMIZER_ARGS=(--optimizer adam --lr 1e-6 --lr-decay-style constant --weight-decay 0.0 --adam-beta1 0.9 --adam-beta2 0.98 --use-distributed-optimizer --optimizer-cpu-offload --overlap-cpu-optimizer-d2h-h2d)
SGLANG_ARGS=(--rollout-num-gpus 4 --rollout-num-gpus-per-engine 4 --sglang-served-model-name nemotron-120b-fp8 --sglang-chat-template "${MODEL_DIR}/chat_template.jinja" --sglang-context-length 8192 --sglang-mem-fraction-static "${SGLANG_MEM_FRACTION}" --sglang-max-running-requests "${SGLANG_MAX_RUNNING_REQUESTS}" --sglang-chunked-prefill-size 2048 --sglang-max-prefill-tokens 4096 --sglang-quantization modelopt_fp8 --sglang-moe-runner-backend triton --sglang-lora-backend triton --sglang-disable-cuda-graph --multi-lora-disable-service-mode --sglang-reasoning-parser nemotron_3 --sglang-tool-call-parser qwen3_coder --sglang-router-port 30100 --sglang-router-policy round_robin --use-rollout-routing-replay)
MISC_ARGS=(--distributed-timeout-minutes 480 --update-weight-transfer-mode broadcast --attention-dropout 0.0 --hidden-dropout 0.0 --attention-backend flash --qkv-format bshd --calculate-per-token-loss)

RUNTIME_ENV_JSON="$(python3 - <<'PY'
import json
import os
print(json.dumps({"env_vars": {
    "PYTHONPATH": os.environ.get("PYTHONPATH", ""),
    "CUDA_DEVICE_MAX_CONNECTIONS": "1",
    "NVTE_FP8_BLOCK_SCALING_FP32_SCALES": "1",
    "TORCH_NCCL_ASYNC_ERROR_HANDLING": "1",
    "NCCL_SOCKET_IFNAME": os.environ.get("NCCL_SOCKET_IFNAME", "tailscale0"),
    "GLOO_SOCKET_IFNAME": os.environ.get("GLOO_SOCKET_IFNAME", "tailscale0"),
    "NCCL_IB_DISABLE": os.environ.get("NCCL_IB_DISABLE", "1"),
    "NCCL_INET_FAMILY": os.environ.get("NCCL_INET_FAMILY", "AF_INET"),
    "NCCL_SOCKET_FAMILY": os.environ.get("NCCL_SOCKET_FAMILY", "AF_INET"),
    "NCCL_CUMEM_ENABLE": os.environ.get("NCCL_CUMEM_ENABLE", "0"),
    "TORCH_NCCL_AVOID_RECORD_STREAMS": os.environ.get("TORCH_NCCL_AVOID_RECORD_STREAMS", "1"),
    "NCCL_NVLS_ENABLE": "1",
}}))
PY
)"

TRAIN_ENV_VARS="$(python3 - <<'PY'
import json
import os
print(json.dumps({
    "NCCL_SOCKET_IFNAME": os.environ.get("NCCL_SOCKET_IFNAME", "tailscale0"),
    "GLOO_SOCKET_IFNAME": os.environ.get("GLOO_SOCKET_IFNAME", "tailscale0"),
    "NCCL_IB_DISABLE": os.environ.get("NCCL_IB_DISABLE", "1"),
    "NCCL_INET_FAMILY": os.environ.get("NCCL_INET_FAMILY", "AF_INET"),
    "NCCL_SOCKET_FAMILY": os.environ.get("NCCL_SOCKET_FAMILY", "AF_INET"),
    "NCCL_CUMEM_ENABLE": os.environ.get("NCCL_CUMEM_ENABLE", "0"),
    "TORCH_NCCL_AVOID_RECORD_STREAMS": os.environ.get("TORCH_NCCL_AVOID_RECORD_STREAMS", "1"),
    "TORCH_NCCL_ASYNC_ERROR_HANDLING": "1",
}))
PY
)"

cd "${MILES_ROOT}"
cat <<EOF
RUN_ID=${RUN_ID}
MODEL_DIR=${MODEL_DIR}
MODEL_SHARDS=${shard_count}
TOPOLOGY=TP${TP_SIZE}/PP${PP_SIZE}/CP${CP_SIZE}/EP${EP_SIZE}/ETP${ETP_SIZE}
LORA=rank${LORA_RANK}/alpha${LORA_ALPHA}
PRECISION=ModelOpt FP8 checkpoint + BF16 Megatron params + FP8-E4M3-blockwise GEMMs + FP32 scales
GRADIENTS=BF16 local -> FP32 accumulated/all-reduced
OPTIMIZER=FP16 master/moments, CPU offloaded
INFERENCE=RTX2 GPUs 4-7, SGLang TP4, ModelOpt FP8
EOF

ray job submit \
  --address "${RAY_ADDRESS}" \
  --runtime-env-json "${RUNTIME_ENV_JSON}" \
  -- python3 /root/miles/train.py \
    --actor-num-nodes 1 --actor-num-gpus-per-node 8 --train-backend megatron \
    "${MODEL_ARGS[@]}" "${CKPT_ARGS[@]}" "${LORA_ARGS[@]}" "${ROLLOUT_ARGS[@]}" \
    "${PRECISION_ARGS[@]}" "${PERF_ARGS[@]}" "${OPTIMIZER_ARGS[@]}" "${GRPO_ARGS[@]}" \
    "${SGLANG_ARGS[@]}" "${MISC_ARGS[@]}" --train-env-vars "${TRAIN_ENV_VARS}"
