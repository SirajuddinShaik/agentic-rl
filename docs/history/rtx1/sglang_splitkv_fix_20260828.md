# SEBI GRPO - SGLang split-KV prefill fix (2026-08-28) - engine crash resolved

## Bottom line
The recurring training deadlock (finish_reason:abort, empty traces, accepted=0/32)
was caused by the SGLang worker crashing on hybrid (Nemotron) prefill, not by Polar.
A FLASHinfer workspace-sizing defect on the split-KV prefill path overflowed the
float workspace and killed the engine worker every ~60-120s into sustained multi-turn
tool prefill. Fixed by disabling split-KV prefill for the hybrid path.

## Exact crash (reproduced across 4+ relaunches)
RuntimeError: ... flashinfer/allocator.h:49:
Buffer overflow when allocating memory for batch_prefill_tmp_s with size 16777216 ...
but only 0 bytes available in AlignedAllocator. Increase the workspace buffer size.
then SIGQUIT -> worker dead -> router 503 -> trainer/polar abort in-flight
-> finish_reason:abort (0 tokens) -> empty traces -> accepted=0 -> deadlock.

## Why
- Nemotron is hybrid (Mamba/linear-attn + flash attention). Long tool-context prefill
  activates flashinfer split-KV, which allocates batch_prefill_tmp_v then batch_prefill_tmp_s
  from the float workspace.
- sglang flashinfer_backend.call_begin_forward() did not pass disable_split_kv, so split-KV
  was enabled; on big prefills tmp_v consumed the workspace -> tmp_s got 0 bytes free.
- SGLANG_FLASHINFER_WORKSPACE_SIZE (tested up to 1GB) does NOT govern this per-plan temp;
  crash persisted regardless of flags.

## Fix (RTX2 engine container, miles-rtx2-never-delete)
- File: /sgl-workspace/sglang/python/sglang/srt/layers/attention/flashinfer_backend.py
  Backup: flashinfer_backend.py.bak-nosplitkv-20260828
- In wrapper_paged.begin_forward(...) (prefill path) added:
    disable_split_kv=( os.environ.get("SGLANG_FLASHINFER_DISABLE_SPLIT_KV","1")=="1" ),
  Default ON (split-kv disabled); toggle with env SGLANG_FLASHINFER_DISABLE_SPLIT_KV.
- Removes batch_prefill_tmp_s/v for this path; non-split prefill is correct (not split-parallel).

## Launch used (RTX1 / miles-never-delete)
- tmp/launch_c16_m128_nothink_v6_nosplitkv.sh (fresh, no checkpoint)
- RUN_ID: sebi-pranav-...-e3-fresh-nosplitkv-m128-<ts>
- RUN_DIR: /root/miles/tmp/xyne_qa_tp2cp4ep8/... ; ckpt: /root/miles/tmp/ckpt/xyne_qa_tp2cp4ep8/...

## Verified (~15:40-15:55 UTC)
- Router http://192.168.111.7:30100/health = OK
- Direct tool-call returns content + tool_calls(vespaSearch) + usage, finish=tool_calls
- No Buffer overflow / SIGQUIT past the old 60-120s crash window; engine computes
  continuously (RTX2 GPU ~82% util, 90GB on GPU 4/5)
- Polar gateway runs genuine multi-turn agent sessions; harness polls session state

## Topology (confirmed)
- Router: 192.168.111.7:30100 (RTX1) - what polar points at. Correct.
- Engine workers: RTX2 192.168.111.8, tp=2, GPU 4-5 (90GB), per-engine HTTP port.
- Polar lanes on RTX1: rollout :8081, gateway :8101, proxy :18114, xyne :3103.
- xyne/vespa/postgres all local to RTX1 (vespa 18080/18081, postgres 15432).

## Known remaining layer (NOT the engine crash)
- Trainer still "Micro-batch: No progress for 60s. Queue=0, accepted=0/32". Sessions
  run/complete at the gateway but tasks have not aggregated to "completed with 8 results",
  and/or cold-start all-zero-reward groups are dropped by check_reward_nonzero_std.
- Prior run (15:27) logged polar rollout server callback POST failing (ConnectError to
  trainer ephemeral 127.0.0.1:<port>/callback/task_result) -> fall back to polling (works,
  trainer GETs /rollout/task/{id} 200). accepted=0 is in the polar task/reward layer,
  independent of the engine.
