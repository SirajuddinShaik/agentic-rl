#!/usr/bin/env bash
set -euo pipefail

set -a
source /root/miles/miles/examples/polar_swegym_grpo/polar_credentials.env
set +a

export NUM_ROLLOUT=1
export EVAL_PROMPT_DATA=/root/miles/tmp/eval/rollout0_matched_4.jsonl
export EVAL_SAMPLES_PER_PROMPT=1
export LORA_ADAPTER_PATH=
export ROLLOUT_BATCH_SIZE=1
export N_SAMPLES_PER_PROMPT=1
export GLOBAL_BATCH_SIZE=1
export NUM_STEPS_PER_ROLLOUT=1
export SAVE_INTERVAL=1
export WANDB_MODE=offline
export RUN_ID=base-newreward-matched-eval-20260815

exec bash /root/miles/runs/run_xyne_qa_megatron_peft64_tp2cp4ep8_multinode.sh
