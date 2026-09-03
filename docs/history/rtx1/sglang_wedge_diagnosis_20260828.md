# SEBI GRPO — Root-cause diagnosis 2026-08-28 (overrides earlier "polar abort" theory)

## TL;DR
- The SGLang WORKER scheduler WEDGES ~5 min into sustained multi-turn tool concurrency.
- Symptoms of the wedge: engine `/health` OK, `workers_count=1`, but **GPU → 0%**, no
  `/v1/chat/completions` responses returned, fresh requests queue forever.
- Every `finish_reason:abort` (prompt=0/completion=0) and the trainer's
  "Micro-batch: No progress... accepted=0/32" are DOWNSTREAM of this wedge
  (trainer/polar abort the stuck requests during weight-update / adapter retirement).
- The single-call path works end-to-end (harness -> proxy :18114 -> gateway :8101 ->
  engine) and returns tool_calls + usage. So Polar is NOT stripping tools, and the
  engine handles a single tool request fine.

## Evidence (run raysubmit_YE7G1wHe54qGiMRf, started 14:41)
- 14:43 single direct stream+tool request to 192.168.111.7:30100 -> returned
  vespaSearch tool_calls, finish_reason="tool_calls". Engine healthy.
- 14:42-14:47 engine served a tool burst fine (GPU 100%). Last 200 POST /v1/chat/completions = 14:47:08.
- ~14:47 the worker wedged: GPU 0%, no completions after that, only GET /health.
- Isolated fresh concurrency-40 direct burst ALSO would not complete (GPU 0%) ->
  the worker itself is deadlocked, independent of Polar/trainer.
- Engine log (job driver): torrents of
  `Abort request for rid=... not found in rid_to_state; likely already finished/removed`
  = trainer/polar multi-lora adapter retirement (/abort_request prefix) firing on stuck reqs.

## Wedged-run engine flags (exact)
context_length=100000, mem_fraction_static=0.88, max_running_requests=128,
max_queued_requests=None, max_total_tokens=None,
chunked_prefill_size=1024, max_prefill_tokens=90000, schedule_policy=fcfs,
disable_overlap_schedule=True, disable_cuda_graph=True,
chat_template=.../chat_template.jinja, default_chat_template_kwargs={'enable_thinking':False},
tool_call_parser=qwen3_coder, attention_backend=flashinfer,
mamba_backend=triton, uses_mamba_radix_cache=True, mamba_radix_cache_strategy=no_buffer,
mamba_full_memory_ratio=0.9, moe_runner_backend=triton, ep_size=1.

## Prime wedge suspects (SGLang scheduler starvation)
1. `--sglang-disable-overlap-schedule` (disable_overlap_schedule=True) — the classic
   cause of "GPU idle, requests stuck" scheduler starvation, esp. with Mamba hybrid.
2. Tiny `--sglang-chunked-prefill-size 1024` paired with `max_prefill_tokens 90000`.
3. Mamba radix cache (no_buffer) interaction.

## Polar hardening already applied (KEEP — correct, not the wedge fix)
- Gateway auto-unwedge monitor now OFF by default (POLAR_ENABLE_AUTO_UNWEDGE=0) and its
  probe targets the real engine (192.168.111.7:30100) instead of stale RTX2 :15000/:15003.
- Proxy patch: /data/siraj/ARL/ProRL-Agent-Server/src/polar/gateway/proxy.py
  (backup .bak-unwedge-off-20260828). Gateway restarted on :8101 (pid 1198583).
- Config: engine base_url=192.168.111.7:30100, served_model=nemotron, auto-unwedge OFF.

## Next step to try (verify cheaply before full relaunch)
1. Bring up ONE engine with the SAME flags but WITHOUT --sglang-disable-overlap-schedule
   (and drop the 1024 chunk / allow auto prefill), then run the concurrency-40 burst
   (/tmp/conc_test.py on rtx1). If it no longer wedges -> that flag was the cause.
2. Only then relaunch training with the corrected engine flags.

## Reference
- Conc test: /tmp/conc_test.py (fires N concurrent stream+tool /v1/chat/completions, tallies finish_reason).
- Trainer config: /root/miles/tmp/launch_c16_m128_nothink_v2.sh (inside miles-never-delete).
- Polar gateway logs: /data/siraj/ARL/logs/rtx2lane_gateway_restart_*.log.

## FINAL ROOT CAUSE (2026-08-28, confirmed across 4 relaunches)
It is a FLASHINFER HYBRID-PREFILL WORKSPACE SIZING BUG in this SGLang build, crashing
the worker under ANY sustained prefill batch for the Nemotron hybrid (Mamba+attention)
model. NOT polar, NOT concurrency, NOT the scheduler per se.

Exact crash (identical every run, incl. after 1GB workspace + max_prefill 16384):
  RuntimeError: Error in function 'aligned_alloc' at .../flashinfer/allocator.h:49:
  Buffer overflow when allocating memory for batch_prefill_tmp_s with size 16777216 ...
  but only 0 bytes available in AlignedAllocator. Increase the workspace buffer size.
then SIGQUIT -> worker dead -> router 503 "no available workers" -> trainer/polar
abort all in-flight -> finish_reason:abort (0 tokens) -> empty traces -> accepted=0 -> deadlock.

Sequence (reproduces every time, worker dies ~60-120s into serving):
14:43 single request OK -> 14:47+ (run1) / 15:22 (v5) worker SIGQUIT on prefill.

## What was tried (all relaunched, none escaped the crash)
- v2 (orig): disable_overlap_schedule=True, chunk 1024, max_prefill 90000
- v3: removed disable_overlap_schedule, chunk 8192, max_prefill 90000  -> same crash
- v4: + SGLANG_FLASHINFER_WORKSPACE_SIZE=1GB                          -> same crash
- v5: + max_prefill 16384                                             -> same crash
Conclusion: SGLANG_FLASHINFER_WORKSPACE_SIZE does NOT govern batch_prefill_tmp_s
(the flashinfer prefill-plan temp). This is a code-level sizing bug.

## Fix path (SGLang code) — /sgl-workspace/sglang/python/sglang/srt/layers/attention/
- flashinfer_backend.py `_full_cg_prefill_workspace_bytes()` (line ~1101) and the
  hybrid_linear_attn_backend.py -> flashinfer delegation: the prefill workspace for
  the Nemotron HYBRID (linear-attn) path is under/zero-sized.
- Check for an env like the trtllm_mha_backend's workspace setting, or patch the
  hybrid prefill wrapper to allocate batch_prefill_tmp_s workspace explicitly.
- Alternative: use the SGLang version/build + attention backend that "run 11" used
  (that config produced multi-turn + rewards and did NOT crash).

## Polar hardening applied and KEPT (correct regardless of engine bug)
- Auto-unwedge monitor OFF by default (POLAR_ENABLE_AUTO_UNWEDGE=0), probe targets
  real engine 192.168.111.7:30100. proxy.py backup .bak-unwedge-off-20260828.
  Gateway restarted on :8101.
- Config: engine base_url=192.168.111.7:30100, served_model=nemotron.
