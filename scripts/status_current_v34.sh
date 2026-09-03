#!/usr/bin/env bash
# Read-only status for the current Xyne/Polar/Miles lane. Run on RTX1 or
# inside miles-never-delete.
set -euo pipefail

RAY_JOB_ID="${RAY_JOB_ID:-04000000}"
RAY_DASHBOARD_ADDRESS="${RAY_DASHBOARD_ADDRESS:-http://192.168.111.7:8265}"
TRAINER_LOG="${TRAINER_LOG:-/root/miles/tmp/v34_submit.log}"
DUMP_ROOT="${DUMP_ROOT:-/root/miles/tmp/xyne_qa_tp2cp4ep8/sebi-pranav-tp2cp4ep8-lora128-qv-fc1fc2-b32-gbs64-spr16-80k-e3-v34-v30base-8h-60k-runid-20260903_104829/trajectory_dumps}"
CHECKPOINT_ROOT="${CHECKPOINT_ROOT:-/root/miles/tmp/ckpt/xyne_qa_tp2cp4ep8/sebi-pranav-tp2cp4ep8-lora128-qv-fc1fc2-b32-gbs64-spr16-80k-e3-v34-v30base-8h-60k-runid-20260903_104829}"

echo "=== Ray job ${RAY_JOB_ID} ==="
if command -v ray >/dev/null 2>&1; then
  ray job status "${RAY_JOB_ID}" --address "${RAY_DASHBOARD_ADDRESS}" 2>&1 | tail -n 8
else
  echo "ray CLI unavailable; run inside miles-never-delete or install Ray" >&2
fi

echo
echo "=== Latest training events ==="
if [[ -r "${TRAINER_LOG}" ]]; then
  grep -E "micro-batch trained|Timer actor_train|Saving LoRA checkpoint|rollout_id=[0-9]+ trained" \
    "${TRAINER_LOG}" | tail -n 30 || true
  echo
  echo "--- last 15 log lines ---"
  tail -n 15 "${TRAINER_LOG}" || true
else
  echo "Log not readable: ${TRAINER_LOG}" >&2
fi

echo
echo "=== Dump inventory ==="
if [[ -d "${DUMP_ROOT}" ]]; then
  printf 'group files: '
  find "${DUMP_ROOT}" -maxdepth 1 -type f -name 'rollout_*_group_*.jsonl.gz' | wc -l
  printf 'full-rollout files: '
  find "${DUMP_ROOT}" -maxdepth 1 -type f -name 'rollout_*.jsonl.gz' ! -name 'rollout_*_group_*.jsonl.gz' | wc -l
  printf 'compressed bytes: '
  find "${DUMP_ROOT}" -maxdepth 1 -type f -name '*.jsonl.gz' -printf '%s\n' | awk '{s+=$1} END {print s+0}'
  echo "latest files:"
  find "${DUMP_ROOT}" -maxdepth 1 -type f -name '*.jsonl.gz' -printf '%TY-%Tm-%Td %TH:%TM:%TS %s %f\n' \
    | sort | tail -n 10
else
  echo "Dump directory not found: ${DUMP_ROOT}" >&2
fi

echo
echo "=== Checkpoint inventory ==="
if [[ -d "${CHECKPOINT_ROOT}" ]]; then
  find "${CHECKPOINT_ROOT}" -maxdepth 2 -type d -name 'iter_*' -printf '%TY-%Tm-%Td %TH:%TM:%TS %p\n' | sort
else
  echo "Checkpoint directory not found: ${CHECKPOINT_ROOT}" >&2
fi

echo
echo "=== GPU utilization ==="
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=index,utilization.gpu,memory.used --format=csv,noheader,nounits
else
  echo "nvidia-smi unavailable in this environment"
fi
