#!/usr/bin/env bash
# One-update Polar/Xyne GRPO smoke run with real Megatron-Bridge PEFT.
# Topology: 4 Megatron actor GPUs (TP=4, EP=4) + 4 SGLang inference GPUs (2x TP=2).
# Unlike the FSDP launcher, --lora-rank is applied to the actor by Bridge before
# DDP/optimizer construction, so Adam only owns adapter parameters.
set -euo pipefail

if [ "$(ulimit -n)" -lt 1048576 ]; then
  ulimit -n 1048576 2>/dev/null || ulimit -n 524288 2>/dev/null || true
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
TRAIN_PY="${PROJECT_ROOT}/train.py"
MEGATRON_DIR="/root/Megatron-LM"
PYTHON_BIN="/usr/bin/python3"
RUNTIME_PYTHONPATH="${MEGATRON_DIR}:${PROJECT_ROOT}:/root/miles/polar-pkg"

ACTOR_NUM_GPUS_PER_NODE="${ACTOR_NUM_GPUS_PER_NODE:-4}"
ROLLOUT_NUM_GPUS="${ROLLOUT_NUM_GPUS:-4}"
ROLLOUT_NUM_GPUS_PER_ENGINE="${ROLLOUT_NUM_GPUS_PER_ENGINE:-2}"
ROLLOUT_BATCH_SIZE="${ROLLOUT_BATCH_SIZE:-1}"
N_SAMPLES_PER_PROMPT="${N_SAMPLES_PER_PROMPT:-2}"
NUM_ROLLOUT="${NUM_ROLLOUT:-1}"
LORA_RANK="${LORA_RANK:-128}"
LORA_ALPHA="${LORA_ALPHA:-256}"
LR="${LR:-1e-5}"
MILES_POLAR_MAX_TRACES_PER_SESSION="${MILES_POLAR_MAX_TRACES_PER_SESSION:-1}"

RAY_NUM_GPUS="$((ACTOR_NUM_GPUS_PER_NODE + ROLLOUT_NUM_GPUS))"
RUN_ID="${RUN_ID:-xyne-qa-megatron-peft128-$(date +%Y%m%d_%H%M%S)}"
RUN_DIR="${PROJECT_ROOT}/tmp/xyne_qa_megatron_peft128/${RUN_ID}"
SAVE_DIR="${SAVE_DIR:-${PROJECT_ROOT}/tmp/ckpt/xyne_qa_megatron_peft128/${RUN_ID}}"
mkdir -p "${RUN_DIR}" "${SAVE_DIR}"

HF_CHECKPOINT="${HF_CHECKPOINT:-/data/siraj/hf_models/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16}"
PROMPT_DATA="${PROMPT_DATA:-/data/siraj/xyne_s/xyne_qa_train.jsonl}"
AGENT_CLI_DIR="${AGENT_CLI_DIR:-/data/siraj/ARL/miles/tmp/swegym_agent_cli/opt_node}"
XYNE_SERVER_DIR="${XYNE_SERVER_DIR:-/data/siraj/xyne_s/xyne-search}"
XYNE_API_KEY="${XYNE_API_KEY:?Set XYNE_API_KEY}"
XYNE_RUNTIME_IMAGE="${XYNE_RUNTIME_IMAGE:-polar-xyne-runtime:withwait}"
export AGENT_CLI_DIR XYNE_SERVER_DIR XYNE_API_KEY XYNE_RUNTIME_IMAGE

CUSTOM_CONFIG_PATH="${RUN_DIR}/polar_config_custom.yaml"
envsubst < "${SCRIPT_DIR}/polar_config_xyne_qa.yaml" > "${CUSTOM_CONFIG_PATH}"

export CUDA_VISIBLE_DEVICES=0,1,2,3,4,5,6,7
export PYTHONPATH="${RUNTIME_PYTHONPATH}"
export PYTHONUNBUFFERED=1
export CUDA_DEVICE_MAX_CONNECTIONS=1
export PYTORCH_CUDA_ALLOC_CONF="expandable_segments:True"
export MILES_POLAR_MAX_TRACES_PER_SESSION

ray stop --force 2>/dev/null || true
sleep 1
ray start --head --node-ip-address 127.0.0.1 --num-gpus "${RAY_NUM_GPUS}" --disable-usage-stats

RUNTIME_ENV_JSON="{
  \"env_vars\": {
    \"PYTHONPATH\": \"${RUNTIME_PYTHONPATH}\",
    \"PATH\": \"/usr/bin:${PATH}\",
    \"VIRTUAL_ENV\": \"\",
    \"CUDA_VISIBLE_DEVICES\": \"0,1,2,3,4,5,6,7\",
    \"CUDA_DEVICE_MAX_CONNECTIONS\": \"1\",
    \"PYTORCH_CUDA_ALLOC_CONF\": \"expandable_segments:True\",
    \"MILES_POLAR_MAX_TRACES_PER_SESSION\": \"${MILES_POLAR_MAX_TRACES_PER_SESSION}\"
  }
}"

source "${SCRIPT_DIR}/model_args.sh"

CKPT_ARGS=(
  --hf-checkpoint "${HF_CHECKPOINT}"
  --megatron-to-hf-mode bridge
  --save "${SAVE_DIR}"
  --save-interval 1
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
  --num-rollout "${NUM_ROLLOUT}"
  --rollout-batch-size "${ROLLOUT_BATCH_SIZE}"
  --n-samples-per-prompt "${N_SAMPLES_PER_PROMPT}"
  --rollout-max-response-len 128
  --rollout-max-prompt-len 2048
  --num-steps-per-rollout 1
)

# Four actor ranks: TP=4 x EP=4, matching the validated Nemotron MoE layout.
PARALLEL_ARGS=(
  --tensor-model-parallel-size 4
  --sequence-parallel
  --qkv-format bshd
  --pipeline-model-parallel-size 1
  --context-parallel-size 1
  --expert-model-parallel-size 4
  --expert-tensor-parallel-size 1
  --recompute-granularity full
  --recompute-method uniform
  --recompute-num-layers 1
  --micro-batch-size 1
  --moe-token-dispatcher-type alltoall
  --log-probs-chunk-size 64
  --distributed-timeout-minutes 60
)

GRPO_ARGS=(
  --advantage-estimator grpo
  --normalize-advantages
  --use-rollout-logprobs
  --entropy-coef 0.0
  --eps-clip 0.2
  --eps-clip-high 0.28
  --kl-loss-coef 0.0
)

OPTIMIZER_ARGS=(
  --optimizer adam
  --use-distributed-optimizer
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

# This is actor-side PEFT, not only SGLang serving configuration.
LORA_ARGS=(
  --lora-rank "${LORA_RANK}"
  --lora-alpha "${LORA_ALPHA}"
  --lora-dropout 0.0
  --target-modules q_proj,k_proj,v_proj,o_proj
  --sglang-lora-backend triton
  --sglang-mem-fraction-static 0.75
  --sglang-context-length 50000
  --sglang-router-port 30100
  --sglang-router-policy round_robin
)

echo "=== Megatron-Bridge PEFT GRPO ==="
echo "=== topology: ${ACTOR_NUM_GPUS_PER_NODE} actor (TP4 EP4) + ${ROLLOUT_NUM_GPUS} inference (2x TP2) ==="
echo "=== LoRA: actor rank=${LORA_RANK}, alpha=${LORA_ALPHA}, targets=q/k/v/o ==="

ray job submit --address="http://127.0.0.1:8265" \
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
  "${LORA_ARGS[@]}"
