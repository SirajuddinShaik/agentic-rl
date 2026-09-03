# How to Start the RTX2-Lane Polar/Xyne GRPO Training (Verified 2026-08-26)

This handout is the step-by-step, verified procedure to start the multi-GPU GRPO
training run that produces **real multi-turn trajectories with citations and
nonzero rewards**. It captures the three root-cause fixes, how to verify each is
live, the exact launch command, and how to confirm the run is healthy.

Throughout: `node` means `ssh rtx1`. All lane services run on RTX1. Rollout
inference runs on RTX2 **GPUs 0-3** (the other agent's e3 lane owns RTX2 4-7).

## 1. Topology (what the run uses)

| Component | Where | Address |
| --- | --- | --- |
| Polar rollout | RTX1 | http://127.0.0.1:8081 |
| Polar gateway | RTX1 | http://127.0.0.1:8101 |
| Session proxy | RTX1 | http://127.0.0.1:18114 |
| Xyne lane backend | RTX1 | http://localhost:3103 |
| Vespa (query/feed) | RTX1 | 127.0.0.1:18081 / 18080 |
| Trainer SGLang router + engines | RTX1 router / RTX2 0-3 | 192.168.111.7:30100 |
| Actor (Megatron, 8 GPUs) | RTX1 | GPUs 0-7 |
| Rollout engines (2x TP2) | RTX2 | GPUs 0-3 |

The trainer spawns its own SGLang engine + router on 192.168.111.7:30100 when it
launches, so the lane must NOT already have an engine on :30100 (stop any
standalone engine / leave the port free). The polar gateway and judge are
configured to point at that router, so they serve the current policy during
rollouts.

## 2. The three root-cause fixes (must all be live)

These are why rollouts were collapsing to a single turn with reward 0.

### Fix 1 - Max-token cap (generation length)
The SEBI agent's generation was truncated before it could emit tool_calls.

Files / expected values:
- Gateway engine:
  /data/siraj/ARL/ProRL-Agent-Server/src/polar/gateway/engine.py
  _DEFAULT_MAX_TOKENS = 8192, _MAX_MAX_TOKENS = 16384
- Session proxy /tmp/_sess_proxy_v2lane18114.py: no hard cap, missing max_tokens
  defaults to 8192 (search for "No capping"). NOTE: this file lives in /tmp -
  re-apply the fix from remote_knowledge/rtx1/fixes/_sess_proxy_v2lane18114.py
  if the process is ever restarted.

After editing, restart the gateway and proxy:
```
ssh rtx1
# gateway (:8101)
cd /data/siraj/ARL && ./.venv/bin/polar serve_gateway \
  -c configs/polar_topology_rtx2lane.yaml --node-id rtx2-lane-node &
# proxy (:18114)
python3 /tmp/_sess_proxy_v2lane18114.py &
```
Old value is preserved in .bak-2048-<ts> files on the node.

### Fix 2 - Vespa port (retrieval / citations)
xyne-search-test was defaulting the query port to 8081 (the polar rollout port),
so vespaSearch 404'd and no chunks were retrieved.

File: /data/siraj/xyne_s/xyne-search-test/server/config.ts
Defaults must be: VESPA_HOST=127.0.0.1 (or env), VESPA_FEED_PORT=18080,
VESPA_QUERY_PORT=18081.

Restart :3103 with the corrected env (dotenv does NOT override pre-set env):
```
cd /data/siraj/xyne_s/xyne-search-test/server
BACKENDV2_PORT=3103 PORT=3103 HOST=http://localhost:3103 \
LITELLM_API_KEY=dummy-polar-gateway \
LITELLM_BASE_URL=http://127.0.0.1:18114 \
LITELLM_MODEL_INFO_URL= \
setsid nohup /home/gpu-burner/.bun/bin/bun run app/server.ts \
  >> /data/siraj/ARL/logs/rtx2lane_xyne3103.log 2>&1 < /dev/null &
```

### Fix 3 - Lane / router addressing
Old launch attempts pointed POLAR_INFERENCE_ADMIN_URL at :8100 (the other lane's
gateway) and the wrong router. The v2lane launcher is the correct one: gateway
:8101, xyne :3103, proxy :18114, judge + agent at 192.168.111.7:30100.

Also hardcode nemotron in the xyne model catalog so getAvailableModels never
returns [] (file server/platform/ai/fetchModels.ts). This prevents "No models
are available" 400s.

### Verify all three are live
```
ssh rtx1
grep -nE '_DEFAULT_MAX_TOKENS|_MAX_MAX_TOKENS' \
  /data/siraj/ARL/ProRL-Agent-Server/src/polar/gateway/engine.py
P=$(pgrep -f 'bun run app/server.ts' | head -1)
tr '\0' '\n' < /proc/$P/environ | grep -E 'VESPA|LITELLM'
```
Expect 127.0.0.1, 18080, 18081, and LITELLM_BASE_URL=http://127.0.0.1:18114.

## 3. Pre-flight checks before launching

```
ssh rtx1
ss -ltnp | grep -E ':(8081|8101|18114|3103|18080|18081)'
docker exec miles-never-delete bash -lc 'ray status'   # expect 0.0/12.0 GPU
ss -ltn | grep ':30100' || echo "30100 free"
ssh -o StrictHostKeyChecking=no 192.168.111.8 'nvidia-smi --query-gpu=index,memory.used --format=csv,noheader'
```

Required files exist inside the container miles-never-delete:
- /root/miles/runs/run_xyne_qa_megatron_peft64_lora128_e3_v2lane_train_async.sh
- /data/siraj/ARL/logs/rtx2lane_grpo_2x8/polar_config_v2lane.yaml
- /data/siraj/ARL/data/sebi_pranav_metadata_graph_train.jsonl
- /data/siraj/hf_models/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16/config.json
- /root/miles/train_async_microbatch.py
- /root/miles/miles/examples/polar_swegym_grpo/polar_credentials.env

Python for the trainer is /data/siraj/ARL/.venv/bin/python (has sglang);
srlab/bin/python does NOT and will crash the run.

## 4. Launch command (one shot)

```
ssh rtx1 'LOG=/data/siraj/ARL/logs/v2lane_train_launch_$(date +%Y%m%d_%H%M%S).log; \
docker exec miles-never-delete bash -lc "
  cd /root/miles &&
  set -a &&
  source /root/miles/miles/examples/polar_swegym_grpo/polar_credentials.env &&
  set +a &&
  export XYNE_BASE_URL=http://localhost:3103 \
      XYNE_JUDGE_BASE_URL=http://192.168.111.7:30100/v1 \
      SGLANG_MAX_RUNNING_REQUESTS=64 \
      POLAR_INFERENCE_ADMIN_URL=http://127.0.0.1:8101 &&
  bash /root/miles/runs/run_xyne_qa_megatron_peft64_lora128_e3_v2lane_train_async.sh
" > $LOG 2>&1; echo "EXIT=$? LOG=$LOG"; tail -30 $LOG'
```

The launcher sources credentials, renders polar_config_custom.yaml into a fresh
timestamped run dir, and submits a Ray job via `ray job submit --no-wait`.
Confirm "Job 'raysubmit_XXX' submitted successfully".

## 5. Verify the run is healthy (~3-5 min after launch)

```
ssh rtx1
docker exec miles-never-delete bash -lc 'ray job status raysubmit_XXX'   # RUNNING
docker exec miles-never-delete bash -lc 'ray job logs raysubmit_XXX --tail 60'
```

Healthy signals in the logs:
- "Router launched at 192.168.111.7:30100"
- 2 SGLang engines on RTX2 (host=192.168.111.8, base_gpu_id=0 and 2) with
  context_length=100000, max_running_requests=64, tool_call_parser=qwen3_coder,
  served_model_name=nemotron
- Megatron actor ranks on RTX1 (MegatronTrainRayActor rank0..7)
- "Start load Lora adapter from distributed" (current policy pushed to engines)
- "[polar-debug] submit task_id=polar-xyne-qa-test-N-N-... status=200" for the
  whole batch (32 groups)

GPU layout after init: RTX1 0-7 ~21.6GB each (actor); RTX2 0-3 my rollout
engines; RTX2 4-7 other agent (leave alone).

## 6. Confirming the fixes actually worked (rollout results)

After the first rollout round finishes, check the trajectory dumps:
```
ssh rtx1
DUMP=/root/miles/tmp/xyne_qa_tp2cp4ep8/sebi-pranav-tp2cp4ep8-lora128-*/trajectory_dumps
docker exec miles-never-delete bash -lc "ls -la '$DUMP'"
```
Signals the run is producing the right data (vs broken single-turn):
- prompt_messages contains assistant AND tool roles (multi-turn)
- retrieved_chunks > 0 (Vespa fix - was 0 before)
- citation markers like [clf-...] present (citation scorers fire)
- reward mean > 0 (validated ~0.4, e.g. run 11: reward 0.405, 155/177 records
  with chunks, group means 0.27-0.60)

Reference validation runs (via run_grpo.py, same lane/entrypoint):
- Run 9 (proxy fix only, gateway still 2048): reward 0.179, citations 0
- Run 10 (gateway cap lifted): reward 0.178, citations 0 (Vespa still 404)
- Run 11 (Vespa fixed): reward 0.405, citations firing

## 7. Gotchas

- Never `pkill -f "bun run app/server.ts"` globally - it kills BOTH :3000 and
  :3100. Kill by exact pid/port.
- Two concurrent runs on the same polar lane collide. Stop any previous
  run_grpo.py / training job before firing a new one.
- Session proxy /tmp/_sess_proxy_v2lane18114.py is scratch - re-apply the
  max_tokens fix on restart.
- Don't test 192.168.111.x from the laptop - only from inside the nodes.
- Reserve RTX2 0-3 for this lane; never allocate 4-7 (other agent's e3 lane).
- Trainer must use /data/siraj/ARL/.venv/bin/python (srlab lacks sglang).

## 8. Key files / references

- Launcher (node): /data/siraj/ARL/miles/runs/run_xyne_qa_megatron_peft64_lora128_e3_v2lane_train_async.sh
- Lane config template: /data/siraj/ARL/logs/rtx2lane_grpo_2x8/polar_config_v2lane.yaml
- Topology (gateway inference -> engine): /data/siraj/ARL/configs/polar_topology_rtx2lane.yaml
- Fixes mirrored locally: remote_knowledge/rtx1/fixes/
  (_sess_proxy_v2lane18114.py, xyne_search_test_config.ts)
- Related context: remote_knowledge/rtx1/RTX2LANE_POLAR_XYNE_GRPO_HANDOFF.md,
  remote_knowledge/rtx1/rtx2lane_grpo_4/E3_CLONE_STATUS.md
- Workspace node memory / rules: RTX_MEMORY.md
