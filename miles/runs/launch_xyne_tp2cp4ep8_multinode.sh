#!/usr/bin/env bash
set -euo pipefail
umask 077

SESSION="xyne_tp2cp4ep8"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CREDENTIALS="${XYNE_RL_CREDENTIALS_FILE:-/root/miles/miles/examples/polar_swegym_grpo/polar_credentials.env}"
TRAIN_SCRIPT="${TRAIN_SCRIPT:-${SCRIPT_DIR}/run_xyne_qa_megatron_peft64_tp2cp4ep8_multinode.sh}"

test -r "${CREDENTIALS}" || { echo "Missing credentials file: ${CREDENTIALS}" >&2; exit 1; }
if find "${CREDENTIALS}" -prune -perm /077 -print -quit | grep -q .; then
  echo "Credentials file must not be accessible by group or others: ${CREDENTIALS}" >&2
  exit 1
fi
source "${CREDENTIALS}"

RUN_ID="${RUN_ID:-sebi-pranav-tp2cp4ep8-lora64-qv-fc1fc2-b32-gbs32-spr8-100k-$(date +%Y%m%d_%H%M%S)}"
LOG="/root/miles/tmp/${RUN_ID}.launcher.log"

if tmux has-session -t "${SESSION}" 2>/dev/null; then
  echo "tmux session ${SESSION} already exists" >&2
  exit 1
fi

tmux new-session -d -s "${SESSION}" \
  "export RUN_ID='${RUN_ID}'; source '${CREDENTIALS}'; exec bash '${TRAIN_SCRIPT}' 2>&1 | tee '${LOG}'"

printf 'SESSION=%s\nRUN_ID=%s\nLOG=%s\n' "${SESSION}" "${RUN_ID}" "${LOG}"
