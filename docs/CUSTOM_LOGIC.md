# Custom Logic and Local Changes

This repository captures the current live training code, not just upstream
checkouts. The reviewable local diffs are in:

- `patches/xyne-search-current.patch`
- `patches/polar-current.patch`
- `patches/miles-current.patch`

## Xyne-search changes

The important custom logic is in `xyne-search/server/app/agent/pi-mono/` and the
platform/model configuration:

- Propagates the Polar session ID from the user message into:
  - main-agent LLM calls
  - Vespa per-document relevance-filter calls
  - sub-agent and tool LLM calls
  - RAG compaction summarizer calls
- Forwards `x-session-id` so compaction and sub-agent calls remain attached to
  the correct Polar session.
- Hardcodes the local `nemotron` model in the model catalog so Xyne does not
  fail model discovery.
- Aligns the model context window, reserve tokens, and compaction thresholds
  with the 64k training context.
- Fixes Vespa search and drill-down tools to preserve document/chunk IDs and
  avoid malformed citation payloads.
- Preserves reasoning content and structured tool calls in the raw dump.
- Keeps the backend stable under high-concurrency rollouts.

Key files:

- `server/app/agent/pi-mono/runner.ts`
- `server/app/agent/pi-mono/core/rag-agent.ts`
- `server/app/agent/pi-mono/core/types.ts`
- `server/app/agent/pi-mono/tools/vespa/searchCore.ts`
- `server/platform/ai/modelConfig.ts`
- `server/platform/ai/fetchModels.ts`

## Polar changes

The important custom logic is in `polar/src/polar/` and the packaged copy in
`polar-pkg/polar/`:

- Gateway streams and aggregates OpenAI-compatible responses without stripping
  `tool_calls` or `reasoning_content`.
- Session proxy uses deterministic Polar session markers and serialized startup.
- Session proxy is configurable for the current `:18114 -> :8101` lane, keeps
  tool-bearing requests streaming for the `qwen3_coder` parser, synthesizes SSE
  for tool-free streaming requests, and guards requests at 16,384 output tokens.
- The source, installable package, and Miles runtime package copies are kept
  synchronized and covered by `tests/test_current_v34_repro.py`.
- Xyne harness fetches the authoritative `/dump` flow and preserves:
  - messages
  - reasoning
  - tool calls and results
  - citations
  - retrieved chunks
  - sub-agent runs
  - token usage
  - final answer
- Evaluator gates incomplete sessions but preserves partial traces when usable.
- LLM judge:
  - uses local Nemotron
  - supports four dimensions
  - writes raw request/response I/O
  - clamps `max_tokens` to 16,384
  - avoids truncation before the final score
- Group reward computes mutual-information evidence and shared answer quality.
- Rollout pipeline harvests partial results on timeout and retries transient
  result-push failures.

Key files:

- `src/polar/gateway/proxy.py`
- `src/polar/gateway/node.py`
- `src/polar/xyne/harness.py`
- `src/polar/xyne/session_proxy.py`
- `src/polar/xyne/xyne_fetch_flow.py`
- `src/polar/xyne/evaluator.py`
- `src/polar/xyne/scorers/llm_judge.py`
- `src/polar/rollout/group_reward.py`
- `src/polar/rollout/pipeline.py`

## Miles changes

The important custom logic is in `miles/miles/` and the launch scripts:

- `train_async_microbatch_v2.py` schedules grouped rollouts and optimizer steps.
- Polar adapter converts Polar trajectories into Miles training samples.
- Reward post-processing computes group-relative efficiency and diversity.
- Group-relative efficiency normalizes:
  - token count
  - exploration distance
  - drill-down distance
  - query diversity
  - gold coverage
- LoRA initialization uses Xavier for A and zero for B.
- Actor updates and checkpoint save are stable for long sequences.
- SGLang engine integration supports LoRA weight synchronization.
- Launch scripts pin the model name, context lengths, parser, and topology.

Key files:

- `train_async_microbatch_v2.py`
- `miles/rollout/polar_adapter.py`
- `miles/rollout/polar_reward.py`
- `miles/rollout/group_relative_efficiency.py`
- `miles/backends/sglang_utils/sglang_engine.py`
- `runs/run_xyne_qa_megatron_peft64_tp2cp4ep8_lora128_e3.sh`

## Why the patches matter

The live RTX worktrees were dirty. A fresh upstream checkout does **not**
reproduce the working training system. The patch files and this repository
capture the exact source state that produced the successful runs.
