#!/usr/bin/env bash
# Small one-update smoke run for the Polar + FSDP GRPO pipeline.
# Keeps the production topology but uses 2 prompts x 2 samples = 4 samples,
# which gives one sample to each of the four FSDP actor ranks.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export ACTOR_NUM_GPUS_PER_NODE=4
export ROLLOUT_NUM_GPUS=4
export ROLLOUT_NUM_GPUS_PER_ENGINE=2
export ROLLOUT_BATCH_SIZE=2
export N_SAMPLES_PER_PROMPT=2
export NUM_ROLLOUT=1
# FSDP's AdamW state is created from the full sharded model and does not use
# the Megatron-only disk-streaming path. Keep params, grads, and optimizer on
# host memory for this one-update smoke so actor GPU 3 can reach optimizer.step.
export FSDP_CPU_OFFLOAD=1
# Keep one final trainable trace per session so the 4-sample smoke batch is
# evenly divisible across the four FSDP actor ranks. Production keeps all traces.
export MILES_POLAR_MAX_TRACES_PER_SESSION=1

exec "${SCRIPT_DIR}/run_xyne_qa_fsdp_all8.sh" "$@"
