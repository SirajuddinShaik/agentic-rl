#!/usr/bin/env bash
set -euo pipefail

: "${SGLANG_MODEL_PATH:?Set SGLANG_MODEL_PATH}"
: "${SGLANG_SERVED_MODEL:?Set SGLANG_SERVED_MODEL}"
: "${SGLANG_HOST:?Set SGLANG_HOST}"
: "${SGLANG_PORT:?Set SGLANG_PORT}"
: "${SGLANG_TP_SIZE:?Set SGLANG_TP_SIZE}"
: "${SGLANG_LOG:?Set SGLANG_LOG}"

mkdir -p "$(dirname -- "$SGLANG_LOG")"
nohup python -m sglang.launch_server \
  --model-path "$SGLANG_MODEL_PATH" \
  --served-model-name "$SGLANG_SERVED_MODEL" \
  --host "$SGLANG_HOST" \
  --port "$SGLANG_PORT" \
  --tp-size "$SGLANG_TP_SIZE" \
  --mem-fraction-static "${SGLANG_MEM_FRACTION_STATIC:-0.90}" \
  --context-length "${SGLANG_CONTEXT_LENGTH:-262144}" \
  > "$SGLANG_LOG" 2>&1 &
sglang_pid=$!
echo "$sglang_pid" > "${SGLANG_LOG}.pid"
echo "SGLang launched with PID ${sglang_pid}; log: ${SGLANG_LOG}"
