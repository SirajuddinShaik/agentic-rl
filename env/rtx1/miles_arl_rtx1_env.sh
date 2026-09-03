#!/usr/bin/env bash

# Source this file before launching Miles from /data/siraj/ARL on RTX1.
export ARL_ROOT="/data/siraj/ARL"
export MILES_ROOT="${ARL_ROOT}/miles"
export MEGATRON_ROOT="/data/siraj/Megatron-LM-dev-bridge"
export MEGATRON_BRIDGE_ROOT="/data/siraj/Megatron-Bridge"
export SLIME_ROOT="${ARL_ROOT}/slime"
export PYTHON="${ARL_ROOT}/.venv/bin/python"

export PYTHONPATH="${MEGATRON_BRIDGE_ROOT}/src:${MEGATRON_ROOT}:${SLIME_ROOT}:${MILES_ROOT}${PYTHONPATH:+:${PYTHONPATH}}"
export CUDA_DEVICE_MAX_CONNECTIONS="${CUDA_DEVICE_MAX_CONNECTIONS:-1}"

cd "${MILES_ROOT}"
