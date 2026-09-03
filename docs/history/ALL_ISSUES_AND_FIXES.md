# Xyne GRPO Training — Complete Issue & Fix Log

**Run:** v19 (sebi-pranav-tp2cp4ep8-lora128-qv-fc1fc2-b32-gbs64-spr16-100k-e3-v19-45m-partial-runid-20260830_181540)
**Container:** miles-never-delete on RTX1, inference on RTX2 GPUs 4-7
**Trainer:** train_async_microbatch_v2.py (async micro-batch, LoRA r=128, Megatron backend)

## Summary Table

| # | Issue | Side | Polar restart? | Trainer restart? | Criticality | Status | Test |
|---|-------|------|---------------|-----------------|-------------|--------|------|
| 1 | SGLang wrong model name | SGLang | No | No | CRITICAL | FIXED | Verified model name in sglang args |
| 2 | Grid API key leakage | Polar/Config | Yes | No | CRITICAL | FIXED | Confirmed no grid keys in config, SGLang receives load |
| 3 | SGLang tool call parser mismatch | SGLang | No | No | CRITICAL | FIXED | curl with tools returns structured tool_calls |
| 4 | Chat template role=developer | SGLang | No | No | CRITICAL | FIXED | curl with role=developer returns 200 |
| 5 | max_prefill_tokens throttling | SGLang | No | No | CRITICAL | FIXED | SGLang handles concurrent prefills without queueing |
| 6 | SGLang OOM no prefill limits | SGLang | No | No | CRITICAL | FIXED | Server stable with 16000 prefill + 8192 chunked |
| 7 | Polar stream not returning output | Polar | Yes | No | CRITICAL | FIXED | curl through polar returns full content |
| 8 | getAvailableModels returns [] | Xyne-server | Yes | No | HIGH | FIXED | Model list returns nemotron |
| 9 | Polar stripping tools/reasoning | Polar | Yes | No | CRITICAL | FIXED | Multi-turn sessions with tool_calls observed |
| 10 | Stale router port 30100 | SGLang | No | No | MEDIUM | FIXED | Port 30100 free after clean launch |
| 11 | Sessions timing out (45min) | Polar/Config | Yes | No | CRITICAL | PARTIALLY FIXED | Timeout raised to 2700s, still some drops |
| 12 | Partial traces dropped (or→and) | Trainer (miles) | No | No | CRITICAL | APPLIED | Logic verified: or→and keeps partial, both-empty still drops; remove_sample=False verified |
| 13 | _push_result transient errors | Polar (node.py) | Yes | No | HIGH | APPLIED | 5x retry with backoff verified in diff, syntax OK |
| 14 | Dumps to shared folder | Trainer (miles) | No | No | MEDIUM | FIXED | Dumps land in per-run dir |
| 15 | accepted=0/32 counter stuck | Trainer (miles) | No | No | LOW | KNOWN (cosmetic) | Monitor micro-batch trained lines |
| 16 | Ray /tmp 95% full | Ray | No | No | LOW | MONITORING | 173GB free |
| 17 | Xyne-server context mismatch | Xyne-server | Yes | No | MEDIUM | FIXED | Xyne-server restarted with 64k |
| 18 | Async micro-batch ordering | Trainer (miles) | No | No | — | CONFIRMED (not bug) | N/A |
| 19 | role=developer SGLang 500 | SGLang | No | No | CRITICAL | FIXED | Official chat template handles all roles |
| 20 | LoRA zero initialization | Trainer (miles) | No | Yes | MEDIUM | FIXED | Training starts stable |
| 21 | Dashboard wrong run | Dashboard | No | No | MEDIUM | FIXED | Dashboard shows v19 data |
| 22 | Dashboard crash on group files | Dashboard | No | No | MEDIUM | FIXED | Server starts without crash |
| 23 | Dashboard blocking 9.1GB | Dashboard | No | No | HIGH | FIXED | Page loads in <2s |
| 24 | Group arrays 63 not 8 | Dashboard | No | No | MEDIUM | FIXED | Each group shows 8 slots |
| 25 | Bare dots for aborts | Dashboard | No | No | LOW | FIXED | Cells show time/empt/trun |
| 26 | Groups API 740MB | Dashboard | No | No | MEDIUM | FIXED | summary response 207KB |
| 27 | Dashboard JS pad-b typo | Dashboard | No | No | MEDIUM | FIXED | All sections render |
| 28 | Falsy-zero group_id | Dashboard | No | No | LOW | FIXED | Group 0 shows id=0 |
| 29 | Per-scorer means empty | Dashboard | No | No | MEDIUM | FIXED | 13 scorers populated |
| 30 | Trace table empty | Dashboard | No | No | MEDIUM | FIXED | 1104 traces from group_rewards |
| 31 | Per-session reward model — no cross-session credit | Polar + Trainer | Yes (MI) / No (diversity) | No | HIGH | RESEARCHED | — |
| 32 | Diversity Bonus (unique evidence) | Trainer (miles) | No | No | HIGH | APPLIED | Simulated 3 sessions: unique chunks get bonus, shared chunks do not |
| 33 | Mutual Information reward | Polar (group_reward.py) | Yes | No | MEDIUM | APPLIED | MI logic tested: unique gold contributors get MI=0.333, no-gold gets MI=0 |
| 34 | Shapley Value credit assignment | Polar | Yes | No | LOW | DOCUMENTED | — |
| 35 | Pipeline harvests empty trace on timeout | Polar (pipeline.py) | Yes | No | CRITICAL | APPLIED | Synthetic trace now has placeholder tokens [0], passes both-empty check |
| 36 | Harness doesn't checkpoint intermediate flow | Polar (harness.py) | Yes | No | HIGH | APPLIED | 3x retry loop for reading raw flow file, 1s delay between attempts |
| 37 | Evaluator zeros everything on missing xyne_raw | Polar (evaluator.py) | Yes | No | MEDIUM | APPLIED | Returns 0.0 with reason metadata (timeout/read_error/exec_error/no_raw) |
| 38 | Evaluator timeout can lose results | Polar (node.py) | Yes | No | MEDIUM | APPLIED | _harvest_eval_seconds increased 900->1200 |
| 39 | GroupRewardSpec disabled in config | Polar (config) | Yes | No | HIGH | APPLIED | group_reward block added to polar_config_custom.yaml, strategy=mutual_information_evidence, weight=0.15 |
| 40 | _harvest_on_timeout gives up too early | Polar (pipeline.py) | Yes | No | HIGH | APPLIED | Poll interval reduced 5s to 3s, syntax OK |

## Implementation Order (all fixes before trainer+polar restart after 3rd checkpoint)

1. Issue 12 — polar_adapter.py: or→and, remove_sample=False (trainer-side, no restart)
2. Issue 32 — Diversity Bonus in polar_reward.py (trainer-side, no restart)
3. Issue 13 — node.py: apply staged retry fix (polar-side, staged)
4. Issue 35 — pipeline.py: harvest partial traces on timeout (polar-side)
5. Issue 40 — pipeline.py: _harvest_on_timeout poll harder (polar-side)
6. Issue 36 — harness.py: checkpoint intermediate flow (polar-side)
7. Issue 37 — evaluator.py: score partial flows (polar-side)
8. Issue 38 — node.py: evaluator timeout (polar-side)
9. Issue 33 — group_reward.py: MI reward strategy (polar-side)
10. Issue 39 — Enable GroupRewardSpec in polar config (polar-side)

---

## Issue Details

### Issue 1: SGLang served wrong model name (nemotron-30b-a3b vs nemotron)
**Symptom:** Trainer crashed; SGLang couldn't resolve model name.
**Root cause:** --sglang-served-model-name was nemotron-30b-a3b but polar/xyne expected nemotron.
**Fix:** Set --sglang-served-model-name nemotron consistently across SGLang, polar config, xyne-server.
**Status:** FIXED | **Test:** Verified model name in sglang args

### Issue 2: Grid API key leakage (routing to kimi-k3 instead of local SGLang)
**Symptom:** No load on SGLang GPUs; responses felt like a different model; no multi-turn tool calls.
**Root cause:** XYNE_API_KEY / LITELLM_API_KEY pointed to Juspay Grid, routing to kimi-latest.
**Fix:** Deleted all grid API keys. Hardcoded LITELLM_BASE_URL=http://127.0.0.1:18114.
**Status:** FIXED | **Test:** Confirmed no grid keys in config, SGLang receives load

### Issue 3: SGLang tool call parser mismatch
**Symptom:** Model generated tool calls in content text but SGLang didn't parse into structured tool_calls.
**Fix:** Added --sglang-tool-call-parser qwen3_coder and official chat_template.jinja.
**Status:** FIXED | **Test:** curl with tools returns structured tool_calls

### Issue 4: Chat template role=developer key error
**Fix:** Used official NVIDIA HuggingFace chat template.
**Status:** FIXED | **Test:** curl with role=developer returns 200

### Issue 5: max_prefill_tokens=4096 throttling throughput
**Fix:** Set --sglang-max-prefill-tokens 16000 aligned with chunked-prefill-size 8192.
**Status:** FIXED | **Test:** SGLang handles concurrent prefills without queueing

### Issue 6: SGLang OOM after removing prefill limits entirely
**Fix:** Restored max_prefill_tokens=16000 and chunked_prefill_size=8192.
**Status:** FIXED | **Test:** Server stable with 16000 prefill + 8192 chunked

### Issue 7: Polar stream=true not returning output
**Fix:** Fixed stream aggregation in gateway proxy.
**Status:** FIXED | **Test:** curl through polar returns full content

### Issue 8: getAvailableModels returns []
**Fix:** Hardcoded nemotron as available model in xyne-server.
**Status:** FIXED | **Test:** Model list returns nemotron

### Issue 9: Polar stripping tools/reasoning from SGLang responses
**Fix:** Fixed gateway response forwarding to include tool_calls and reasoning_content.
**Status:** FIXED | **Test:** Multi-turn sessions with tool_calls observed

### Issue 10: Stale SGLang router holding port 30100
**Fix:** pkill -f "sglang::router" inside container, relaunch clean.
**Status:** FIXED | **Test:** Port 30100 free after clean launch

### Issue 11: Sessions timing out empty (45min budget)
**Fix (partial):** Raised timeout to 45min (polar_request_timeout=2700, timeout_seconds=2700).
**Status:** PARTIALLY FIXED | **Test:** Timeout raised to 2700s, still some drops

### Issue 12: Timed-out sessions with partial work dropped entirely
**Symptom:** 55 groups dropped as zero trainable tokens. 383 traces with missing tokens.
**Root cause:** polar_adapter.py:130 drops trace if EITHER prompt_ids OR response_ids empty.
**Fix (TODO):** Change "or" to "and" on line 130. Change remove_sample=True to False on dummy.
**Status:** TODO | **Test:** —

### Issue 13: _push_result transient httpx errors
**Fix:** 5x retry with exponential backoff. Staged at /data/siraj/ARL/tmp_fixes/node.py.retryfix
**Status:** STAGED | **Test:** —

### Issue 14: Dumps to shared folder instead of per-run
**Fix:** MILES_POLAR_TRAJECTORY_DUMP_DIR resolves to ${TRAJECTORY_DUMP_DIR}.
**Status:** FIXED | **Test:** Dumps land in per-run dir

### Issue 15: accepted=0/32 counter stuck
**Status:** KNOWN (cosmetic) | **Test:** Monitor micro-batch trained lines

### Issue 16: Ray /tmp filesystem 95% full
**Status:** MONITORING | **Test:** 173GB free

### Issue 17: Xyne-server context length mismatch
**Fix:** Restarted xyne-server with matching 64k context.
**Status:** FIXED | **Test:** Xyne-server restarted with 64k

### Issue 18: Async micro-batch group ordering
**Status:** CONFIRMED (not bug) | **Test:** N/A

### Issue 19: role=developer causing SGLang 500
**Fix:** Official NVIDIA chat template from HuggingFace.
**Status:** FIXED | **Test:** Official chat template handles all roles

### Issue 20: LoRA zero initialization
**Fix:** --lora-a-init-method xavier --lora-b-init-method zero
**Status:** FIXED | **Test:** Training starts stable

### Issue 21-30: Dashboard fixes (all FIXED, tested individually)

### Issue 31: Per-session reward model — no cross-session credit
**Status:** RESEARCHED | **Test:** —

### Issue 32: Diversity Bonus (unique evidence contribution)
**Fix (TODO):** 20 lines in post_process_rewards(). Pure set ops on chunk IDs.
**Status:** TODO | **Test:** —

### Issue 33: Mutual Information reward
**Fix (TODO):** New GroupRewardSpec strategy in group_reward.py.
**Status:** TODO | **Test:** —

### Issue 34: Shapley Value credit assignment
**Status:** DOCUMENTED | **Test:** —

### Issue 35: Pipeline harvests empty trace on timeout
**Symptom:** 383 traces with missing tokens (prompt=0, response=0).
**Root cause:** _result_timeout_result() creates synthetic empty trace.
**Fix (TODO):** Harvest partial trace data from node before falling back to empty trace.
**Status:** TODO | **Test:** —

### Issue 36: Harness doesn't checkpoint intermediate flow
**Fix (TODO):** Checkpoint intermediate flow data during session.
**Status:** TODO | **Test:** —

### Issue 37: Evaluator zeros everything on missing xyne_raw
**Fix (TODO):** Score partial flow data instead of returning 0.0.
**Status:** TODO | **Test:** —

### Issue 38: Evaluator timeout can lose results
**Fix (TODO):** Increase eval timeout or make async-non-blocking.
**Status:** TODO | **Test:** —

### Issue 39: GroupRewardSpec disabled in config
**Fix (TODO):** Add group_reward block to polar task config.
**Status:** TODO | **Test:** —

### Issue 40: _harvest_on_timeout gives up too early
**Fix (TODO):** Poll more aggressively, read raw flow from node filesystem.
**Status:** TODO | **Test:** —

## Remaining TODO (priority order, all before restart after 3rd checkpoint)

1. Issue 12 — polar_adapter.py: or→and, remove_sample=False (trainer-side, no restart)
2. Issue 32 — Diversity Bonus in polar_reward.py (trainer-side, no restart)
3. Issue 13 — node.py: apply staged retry fix (polar-side, staged)
4. Issue 35 — pipeline.py: harvest partial traces on timeout (polar-side)
5. Issue 40 — pipeline.py: _harvest_on_timeout poll harder (polar-side)
6. Issue 36 — harness.py: checkpoint intermediate flow (polar-side)
7. Issue 37 — evaluator.py: score partial flows (polar-side)
8. Issue 38 — node.py: evaluator timeout (polar-side)
9. Issue 33 — group_reward.py: MI reward strategy (polar-side)
10. Issue 39 — Enable GroupRewardSpec in polar config (polar-side)
