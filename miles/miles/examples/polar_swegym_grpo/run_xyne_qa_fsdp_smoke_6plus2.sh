#!/usr/bin/env bash
# One-update smoke run: 6 FSDP actor GPUs + 2 inference GPUs.
# Uses one TP=2 SGLang engine and one bounded sample per actor rank.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export ACTOR_NUM_GPUS_PER_NODE=6
export ROLLOUT_NUM_GPUS=2
export ROLLOUT_NUM_GPUS_PER_ENGINE=2
export ROLLOUT_BATCH_SIZE=3
export N_SAMPLES_PER_PROMPT=2
export NUM_ROLLOUT=1

# Keep one final trainable trace per session for a six-sample smoke batch.
export MILES_POLAR_MAX_TRACES_PER_SESSION=1

# Six-way FSDP should fit the actor and Adam state without CPU offload.
export FSDP_CPU_OFFLOAD=0
export STREAM_OPTIMIZER_STATE_TO_DISK=0

exec "${SCRIPT_DIR}/run_xyne_qa_fsdp_all8.sh" "$@"
