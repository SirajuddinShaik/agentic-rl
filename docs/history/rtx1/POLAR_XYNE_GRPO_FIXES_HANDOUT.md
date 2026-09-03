# Polar ↔ Xyne GRPO — Fixes & Results Handout

**Status date:** 2026-08-26
**Lane:** `rtx2lane` (disaggregated). Polar rollout/gateway/proxy/xyne/Postgres/Vespa run on RTX1; the Nemotron SGLang engine serves on GPUs 0–3 at `192.168.111.7:30100`.
**Net result:** reward-0 bug fixed, multi-turn restored, retrieval/citations fixed. Clean validation run 11 → reward mean **0.405**, distinct per-sample rewards, citations + evidence scorers active.

---

## 1. What was broken and what was fixed

There were **four** distinct root causes. The first two are why rewards were 0; the third and fourth are why citations never appeared even after multi-turn came back.

### Fix 1 — Session proxy hard-capped `max_tokens` at 2048 (REWARD=0 root cause, part 1)
- File: `ProRL-Agent-Server/src/polar/xyne/session_proxy.py`, and the standalone copy `/tmp/_sess_proxy_v2lane18114.py` (the live `:18114` proxy).
- Old behavior: every request's `max_tokens` forced to 2048. Under that cap the multi-turn agent truncated its reasoning before emitting a tool call → single-turn template echo → no tool calls, no citations, reward 0.
- Fix: pass the caller's `max_tokens` through; default to 8192 only when missing. Hard cap raised to 16384.
- Patched copies: `remote_knowledge/rtx1/fixes/_sess_proxy_polar_session_proxy.py` and `remote_knowledge/rtx1/fixes/_sess_proxy_v2lane18114.py`.
- Gotcha: the `:18114` proxy is a `/tmp` scratch — re-apply the fix if it is restarted.

### Fix 2 — Polar gateway engine capped `max_tokens` at 2048 (REWARD=0 root cause, part 2 — the live limiter)
- File: `ProRL-Agent-Server/src/polar/gateway/engine.py`, `ensure_max_tokens()`.
- `_DEFAULT_MAX_TOKENS = 2048` → **8192**; `_MAX_MAX_TOKENS = 2048` → **16384**.
- This was the actual live ceiling (even with the proxy fixed, the gateway clamped every engine request at 2048). Verify: a `max_tokens=4096` request now returns a 4096-token response (`finish: length`) instead of stopping at 2048.
- Requires restarting the `:8101` gateway to take effect.

### Fix 3 — Package `session_proxy.py` still had the 2048 cap (future-proofing)
- `polar/xyne/session_proxy.py`: default `pj["max_tokens"] = 8192`, hard cap `> 16384 → 16384` on the cap branch.

### Fix 4 — Vespa defaulted to the polar rollout port (NO-CITATIONS root cause)
- File: `xyne-search-test/server/config.ts`.
- Old defaults: `VESPA_HOST || "0.0.0.0"`, `VESPA_QUERY_PORT || "8081"`, `VESPA_FEED_PORT || "8080"`.
- Problem: port **8081 on RTX1 is the polar rollout server** (Uvicorn/FastAPI). Every `vespaSearch` POSTed `/search/` to `0.0.0.0:8081` → hit polar → **HTTP 404 `{"detail":"Not Found"}`** → `retrieved_chunks=0` → nothing to cite → all citation/evidence scorers 0.
- Fix: defaults → `VESPA_HOST || "127.0.0.1"`, `VESPA_QUERY_PORT || "18081"`, `VESPA_FEED_PORT || "18080"` (real Vespa on `18080/18081`, verified 14,449 `kb_items`).
- Also restart the `:3103` lane backend with `VESPA_HOST=127.0.0.1 VESPA_QUERY_PORT=18081 VESPA_FEED_PORT=18080`.
- Patched copy: `remote_knowledge/rtx1/fixes/xyne_search_test_config.ts`.

### Fix 5 — Engine relaunch (environment)
- Nemotron-H does **not** support the Triton attention backend (`AssertionError: NemotronHForCausalLM does not support triton attention backend`), and the ARL venv's flashinfer JIT failed on Blackwell (`FlashInfer requires GPUs with sm75 or higher`).
- Working engine: run inside the `miles-never-delete` container (flashinfer 0.6.14) on GPUs 0–3, default flashinfer attention, `tp-size 4`, `--tool-call-parser qwen3_coder`, `--disable-cuda-graph --disable-overlap-schedule`, `--context-length 100000`, `--mem-fraction-static 0.80`, `--served-model-name nemotron`.

---

## 2. Results (2 prompts × 8 GRPO)

| Run | status | records | reward mean | min | max | multi-turn? | citations |
|---|---|---|---|---|---|---|---|
| 4 | ✅ 2/2 | 115 | 0.2315 | 0.1625 | 0.3051 | yes | some |
| 5 | ✅ 2/2 | 48 | 0.0000 | 0.0000 | 0.0000 | **no (collapsed)** | no |
| 9 | ✅ 2/2 | 188 | 0.1793 | 0.1561 | 0.2775 | yes (743 tool+assistant) | no (Vespa 404) |
| 10 | ✅ 2/2 | 188 | 0.1779 | 0.1482 | 0.3197 | yes | no (Vespa 404) |
| **11** | ✅ 2/2 | 177 | **0.4048** | 0.2281 | **0.6032** | yes (775 tool+assistant) | **yes** |

Run 11 detail:
- retrieved_chunks > 0 for 155/177 records (up to 166 chunks); 20 responses contain `[clf-…]` citations.
- Per-sample rewards distinct per 8-group — group 0: 0.228→0.489; group 1: 0.249→0.603.

### Run 11 per-scorer (mean / max / samples>0)
| scorer | mean | max | n>0 |
|---|---:|---:|---:|
| completion | 1.000 | 1.000 | 177 |
| answer_format | 1.000 | 1.000 | 177 |
| retrieval_quality | 0.669 | 0.920 | 155 |
| citation_presence | 0.576 | 1.000 | 102 |
| gold_evidence_coverage | 0.514 | 0.827 | 155 |
| llm_judge | 0.394 | 1.000 | 129 |
| tool_evidence_utility | 0.384 | 0.616 | 155 |
| citation_relevance | 0.332 | 1.000 | 98 |
| citation_evidence_coverage | 0.313 | 0.712 | 98 |
| citation_accuracy | 0.214 | 0.667 | 72 |
| tool_call_efficiency | 0.495 | 1.000 | 177 |
| embedding_similarity | 0.035 | 0.161 | 177 |
| token_efficiency | 0.287 | 0.923 | 177 |

---

## 3. Training job: why it appeared "failing to multi-turn"
- The active training run (10:39–12:37) rolled out against the **old 2048-capped gateway**, so every training rollout collapsed: prompt roles only `system+user`, 0 tool calls, 0 retrieved chunks, 0 citations, reward 0.0 (iter 0: 730 traces all 0; iter 7: 660 all 0).
- Same Fix 1/2 bug, now corrected. A fresh training run through the fixed gateway/config should behave like run 11.
- The run was stopped 12:48. It is **recoverable** — 8 full checkpoints (`iter_0000000..7`, adapter weights + `training_state_rank*.pt` + dataloader state) ~14 GB/iter, 540 GB total at `/root/miles/tmp/ckpt/xyne_qa_tp2cp4ep8/...-e3-20260826_103953/`.

---

## 4. Reproduction

Lane services (RTX1):
```bash
cd /data/siraj/ARL && ./.venv/bin/polar serve_rollout  -c configs/polar_topology_rtx2lane.yaml &   # :8081
cd /data/siraj/ARL && ./.venv/bin/polar serve_gateway  -c configs/polar_topology_rtx2lane.yaml --node-id rtx2-lane-node &  # :8101 (engine caps = 16k)
python3 /tmp/_sess_proxy_v2lane18114.py &   # :18114 (no-cap proxy; re-apply fix on restart)
cd /data/siraj/xyne_s/xyne-search-test/server && BACKENDV2_PORT=3103 PORT=3103 HOST=http://localhost:3103 \
  LITELLM_API_KEY=dummy-polar-gateway LITELLM_BASE_URL=http://127.0.0.1:18114 LITELLM_MODEL_INFO_URL= \
  VESPA_HOST=127.0.0.1 VESPA_QUERY_PORT=18081 VESPA_FEED_PORT=18080 \
  setsid nohup /home/gpu-burner/.bun/bin/bun run app/server.ts >> ...xyne3103.log 2>&1 < /dev/null &
```
Engine (:30100, GPUs 0–3) — launch inside `miles-never-delete`:
```bash
docker exec -d miles-never-delete bash -lc 'cd /sgl-workspace && CUDA_VISIBLE_DEVICES=0,1,2,3 python3 -m sglang.launch_server \
  --model-path /data/siraj/hf_models/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16 \
  --host 0.0.0.0 --port 30100 --tp-size 4 --served-model-name nemotron \
  --context-length 100000 --mem-fraction-static 0.80 --tool-call-parser qwen3_coder \
  --disable-cuda-graph --disable-overlap-schedule'
```

Validation driver (2×8):
```bash
cd /data/siraj/ARL/logs/rtx2lane_grpo_2x8
MILES_POLAR_TRAJECTORY_DUMP_DIR=$PWD/trajectory_dumps/rollout_N \
setsid nohup /data/siraj/ARL/.venv/bin/python run_grpo.py \
  --config $PWD/polar_config_v2lane.yaml --data $PWD/prompts_2.jsonl \
  --n-prompts 2 --group-size 8 --rollout-id N --timeout-min 75 \
  --result-json $PWD/result_rolloutN.json > run_rolloutN.log 2>&1 < /dev/null &
```
Use a fresh `rollout-id` and dump dir each run.

---

## 5. Gotchas
1. Use `/data/siraj/ARL/.venv/bin/python`, not `srlab/bin/python` (needs sglang).
2. Two concurrent runs on one polar lane collide (identical task ids) — kill prior `run_grpo.py`, use a fresh rollout id.
3. Confirm cap removal: POST the gateway `:8101` with `max_tokens=4096`; a 4096-token completion (not a 2048 stop) proves the engine cap is gone.
4. Verify retrieval path: `curl -s -X POST http://127.0.0.1:18081/search/ -H 'Content-Type: application/json' -d '{"yql":"select * from kb_items where true;","hits":3}'` → totalCount 14449. `:8081` is polar, NOT Vespa.
5. `Callback 422` and `No progress for 60s` heartbeats are non-fatal.
6. Training spawns its own LoRA engine on `:30100` — free that port (stop the validation engine) before a training run, and use a LoRA-capable engine.
7. `[clf-…]` citations are model-driven: they appear only when the agent retrieves relevant chunks and chooses to cite (20/177 in run 11).
*** End Patch
