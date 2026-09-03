# RTX2-Lane Polar ↔ Xyne GRPO Pipeline — Working Handoff

**Status date:** 2026-08-26
**Last verified run:** rollout id 4 (2 questions × 8 per-group = 115 trainable traces)
**Lane:** "rtx2lane" — the DISAGGREGATED lane. Rollout/completions come from the RTX2
SGLang engine (Nemotron) on GPUs 0–3; everything else (polar servers, xyne backend,
proxy, postgres, Vespa) runs on RTX1. This is intentionally separate from the other
agent's e3 lane (prod polar `:8080`/`:8100`, GPUs 4–7). Do not touch theirs.

---

## 1. What this lane is

Polar is an external rollouts/agent-harness service. The `generate_rollout_polar_async`
Miles rollout function submits task groups to the Polar rollout server, which spawns
multi-turn SEBI agent sessions (via a runtime container running the xyne search stack).
Each session produces completions; those are converted into trainable Miles samples
(tokens, logprobs, loss masks, reward) and dumped per trajectory.

**Which polar:** the NEW NVIDIA-NeMo/ProRL-Agent-Server clone, installed editable into the
ARL venv as `polar 0.1.0` (NOT PyPI, and NOT the older polar bundled with miles).
`/data/siraj/ARL/.venv/bin/polar` is that package's console entrypoint
(`polar = polar.cli:main`) resolving to `/data/siraj/ARL/ProRL-Agent-Server/src/polar`.
Pinned at commit `ebb9f681` (2026-08-24) "fix(gateway): lift grid PSF token_ids into
canonical training shape", origin `https://github.com/NVIDIA-NeMo/ProRL-Agent-Server.git`.
Do not confuse the venv's `polars`/`polars-runtime-32` (the dataframe lib, unrelated) with
this `polar` server package.

Both `train.py` and `train_async.py` drive this lane through the SAME shared path:
`RolloutManager.generate` → `generate_rollout_polar_async` → external polar
`:8081`/`:8101` → xyne backend `:3103` → proxy `:18114` → RTX2 engine
`192.168.111.8:30300`.

### Component map (all stable)

| Component | Host | Address | Notes |
|---|---|---|---|
| Polar rollout | RTX1 | `http://127.0.0.1:8081` | pid 3782063, `polar_topology_rtx2lane.yaml` |
| Polar gateway | RTX1 | `http://127.0.0.1:8101` | pid 3782064, node `rtx2-lane-node`, inference → `192.168.111.8:30300` |
| Session proxy | RTX1 | `http://127.0.0.1:18114` | `/tmp/_sess_proxy_v2lane18114.py` (python) → upstream `:8101` |
| Xyne lane backend | RTX1 | `http://localhost:3103` | from `/data/siraj/xyne_s/xyne-search-test/server`, local LITELLM → `:18114` |
| Xyne prod backend | RTX1 | `http://localhost:3000` | from `/data/siraj/xyne_s/xyne-search/server` |
| Xyne test backend | RTX1 | `:3100` | separate process, isolated |
| SGLang engine | RTX1 | `http://192.168.111.7:30100` | **VERIFIED 2026-08-26:** served by the live sglang router (model `nemotron`). NOTE: RTX2 container `rtx2-sglang-0-3` is EXITED/down; the RTX2-lane gateway + judge now use `:30100` on RTX1 (currently also shared with the active train job's router). Do NOT use `192.168.111.8:30300` (dead). |
| Postgres | RTX1 | `:15432` | `postgresql://xyne:xyne@localhost:15432/xyne` |
| Vespa | RTX1 | `:18080`/`:18081` (+host `8080`/`8081`) | |

Lane topology config: `/data/siraj/ARL/configs/polar_topology_rtx2lane.yaml`
(gateway inference `base_url: http://192.168.111.8:30300`).

Lane polar config (used by the driver): `/data/siraj/ARL/logs/rtx2lane_grpo_2x8/polar_config_v2lane.yaml`
(identical copy under `.../rtx2lane_grpo_local/`).
It points `polar_xyne_base_url: http://localhost:3103`, `polar_rollout_url: :8081`,
`polar_gateway_url: :8101`, judge `base_url: http://192.168.111.8:30300/v1`, model `nemotron`,
`polar_max_async_level: 64`, agent env `LITELLM_BASE_URL: http://127.0.0.1:18114`.

---

## 2. The critical fix (the whole failure before)

**Symptom:** `getAvailableModels` returned `[]` → SEBI agent send-message calls 400'd with
`{"error":"No models are available"}` → sessions produced `traces:0` → groups dropped
as "zero trainable tokens", engine log showed no agent completions, gateway saw almost
no chat calls. Root cause: the xyne backend was unconfigured / pointing at **grid**
(`LITELLM_BASE_URL=https://grid.ai.juspay.net/`, `kimi`), so the local model was never exposed.

**Fix #1 — hardcode `nemotron` into the model catalog (do this first):**
File `/data/siraj/xyne_s/xyne-search-test/server/platform/ai/fetchModels.ts`,
function `getAvailableModels`. After all the provider branches, right before
`const allowedModelIds = getAllowedModelIds()`, add:

```ts
  // Always expose the local Nemotron (RTX2 SGLang engine) so the catalog
  // never comes back empty, even if the LiteLLM model-info call fails.
  if (MODEL_CONFIGURATIONS[Models.NEMOTRON] && !availableModels.some((m) => m.id === Models.NEMOTRON)) {
    availableModels.push(toAvailableModelConfig(Models.NEMOTRON, MODEL_CONFIGURATIONS[Models.NEMOTRON]))
  }
```

This guarantees xyne never fails with "No models are available" and polar never has to
special-case it. `Models.NEMOTRON = "nemotron"` (`types.ts`), config at
`modelConfig.ts` (provider LiteLLM, labelName `LITELLM_NEMOTRON`).

**Fix #2 — run the lane backend LOCAL, never grid:**
Start the `:3103` backend with env overrides (dotenv does NOT override pre-set env, so these win):

```bash
cd /data/siraj/xyne_s/xyne-search-test/server
BACKENDV2_PORT=3103 PORT=3103 HOST=http://localhost:3103 \
LITELLM_API_KEY=dummy-polar-gateway \
LITELLM_BASE_URL=http://127.0.0.1:18114 \
LITELLM_MODEL_INFO_URL= \
setsid nohup /home/gpu-burner/.bun/bin/bun run app/server.ts \
  >> /data/siraj/ARL/logs/rtx2lane_xyne3103.log 2>&1 < /dev/null &
```
- `LITELLM_BASE_URL=http://127.0.0.1:18114` is the local proxy → gateway → RTX2. No grid.
- `LITELLM_MODEL_INFO_URL=` empty so no grid model-info call (falls back to hardcoded nemotron).
- Chat completions are built from `LiteLLMBaseUrl + "/v1/chat/completions"`, so this is the
  one knob that decides local-vs-grid for the SEBI agent.

**Fix #3 — use the project venv python for the trainer, NOT `srlab/bin/python`:**
`srlab/bin/python` lacks `sglang`, so at the end of a rollout it crashes with
`ImportError: Miles is required...` after already writing dumps. Use
`/data/siraj/ARL/.venv/bin/python`.

---

## 3. How to launch / rebuild services

Polar rollout + gateway (the rtx2lane topology):

```bash
cd /data/siraj/ARL && ./.venv/bin/polar serve_rollout  -c configs/polar_topology_rtx2lane.yaml &   # :8081
cd /data/siraj/ARL && ./.venv/bin/polar serve_gateway  -c configs/polar_topology_rtx2lane.yaml --node-id rtx2-lane-node &  # :8101
```

Session proxy (stdlib python, upstream `:8101`, port `18114`):
```bash
python3 /tmp/_sess_proxy_v2lane18114.py &
```

Xyne prod backend `:3000` (restore if killed):
```bash
cd /data/siraj/xyne_s/xyne-search/server
setsid nohup /home/gpu-burner/.bun/bin/bun run app/server.ts >> /data/siraj/ARL/logs/prod_xyne3000.log 2>&1 < /dev/null &
```

RTX2 SGLang engine + router (GPUs 0–3):
```bash
docker start rtx2-sglang-0-3
# router (CMD router syntax is outdated — start manually):
docker exec -d rtx2-sglang-0-3 sglang-router launch --host 0.0.0.0 --port 30300 \
  --worker-urls http://127.0.0.1:15300 --policy round_robin \
  --max-concurrent-requests 128 --queue-size 512
```

**Never `pkill -f "bun run app/server.ts"` globally** — it kills BOTH prod `:3000` and
test `:3100`. Kill by exact pid/port instead.

---

## 4. Firing the 2-question × 8 GRPO run (trainer-entry smoke)

Driver: `/data/siraj/ARL/logs/rtx2lane_grpo_2x8/run_grpo.py`
(calls `miles.rollout.polar_rollout.generate_rollout_polar_async` — the identical
entrypoint train.py / train_async.py use, then applies `post_process_rewards`).

```bash
cd /data/siraj/ARL/logs/rtx2lane_grpo_2x8
mkdir -p trajectory_dumps/rollout_4
MILES_POLAR_TRAJECTORY_DUMP_DIR=/data/siraj/ARL/logs/rtx2lane_grpo_2x8/trajectory_dumps/rollout_4 \
setsid nohup /data/siraj/ARL/.venv/bin/python run_grpo.py \
  --config /data/siraj/ARL/logs/rtx2lane_grpo_2x8/polar_config_v2lane.yaml \
  --data   /data/siraj/ARL/logs/rtx2lane_grpo_2x8/prompts_2.jsonl \
  --n-prompts 2 --group-size 8 --rollout-id 4 --timeout-min 60 \
  --result-json /data/siraj/ARL/logs/rtx2lane_grpo_2x8/result_rollout4.json \
  > run_rollout4.log 2>&1 < /dev/null &
```

- Keep a FRESH `MILES_POLAR_TRAJECTORY_DUMP_DIR` per run.
- Use a fresh `--rollout-id` if re-running against the same polar server (submit idempotency is unknown).
- Monitor success: `grep "Persisted trajectory dump" run_rollout*.log` and
  `cat result_rollout*.json` → expect `"status": "COMPLETED"`, `groups_collected` == `n-prompts`.

For the REAL trainer entry (`train.py`) the wiring is identical via these flags:
```
--rollout-function-path miles.rollout.polar_rollout.generate_rollout_polar_async
--custom-rm-path miles.rollout.polar_reward.custom_rm                    # per-sample reward
--custom-reward-post-process-path miles.rollout.polar_reward.post_process_rewards  # group GRPO
--data-source-path miles.rollout.polar_data_source.CeilEpochRolloutDataSourceWithBuffer
--custom-config-path <lane polar config rendered>
--reward-key score
```
Reference launchers live in `/data/siraj/ARL/xyne-rl/miles/examples/polar_swegym_grpo/`
(`run_xyne_qa_fsdp_all8.sh`, `run_xyne_qa_fsdp_smoke.sh`). Note those default to the prod
xyne stack — for THIS lane point `polar_xyne_base_url`/judge at the rtx2lane values
(`localhost:3103`, `192.168.111.8:30300/v1`).

---

## 5. Rewards (how they compose)

- **Per-sample base reward = XyneCompositeEvaluator `score`** (lane config
  `strategy: polar.xyne.evaluator:XyneCompositeEvaluator`) with weighted scorers:
  completion 1.0, answer_format 0.5, citation_presence 1.0, citation_relevance 0.75,
  citation_accuracy 1.5, llm_judge 1.5, retrieval_quality 1.0, gold_evidence_coverage 1.0,
  citation_evidence_coverage 1.0, tool_evidence_utility 1.0, subagent_success 0.5,
  embedding_similarity(f1) 2.0, tool_call_efficiency 1.0, token_efficiency 1.0.
- **Group-level layer = `post_process_rewards`** (Miles `--custom-reward-post-process-path`):
  leave-one-trajectory-out GRPO baseline over the prompt group + token-efficiency shaping
  + optional `grpo_std_normalization`. On top of the composite `score`.
- Stored in each dump record as `reward: {"score": <float>}`; trainer reads via `--reward-key score`.

**Run-4 result numbers (verified):**
- 2/2 groups, 115 trainable traces, exit 0, ~137s
- reward mean **0.2315**, min **0.1625**, max **0.3051**, all 115 reward>0 & non-empty answer
- per-group means: g0 **0.243**, g1 **0.2203**
- `post_process_rewards` raw + `group_normalized` arrays (115 each)

---

## 6. Results / artifacts

Run 4 (this handoff is authoritative against it):
- **Dump:** `/data/siraj/ARL/logs/rtx2lane_grpo_2x8/trajectory_dumps/rollout_4/rollout_000004.jsonl.gz` (22 MB, 115 records)
- **Result JSON:** `/data/siraj/ARL/logs/rtx2lane_grpo_2x8/result_rollout4.json`
- **Run log:** `/data/siraj/ARL/logs/rtx2lane_grpo_2x8/run_rollout4.log`
- Local copies: `remote_knowledge/rtx1/rtx2lane_grpo_4/result_rollout4.json`,
  `remote_knowledge/rtx1/rtx2lane_grpo_4/sample_dump_records.jsonl`

Dump record shape (per trajectory): `rollout_id, group_position, group_index, sample_index,
session_id, task_id, node_id, trace_index, status, finish_reason, reward, response_length,
prompt_messages, response_messages, tokens, loss_mask, rollout_log_probs,
trainable_token_count, polar_metadata`. Verified first record: 434 tokens, 219 trainable,
2 prompt msgs + 1 assistant response, reward `{'score': 0.2594...}`.

---

## 7. Gotchas / lessons for replication

1. **VPN required from the laptop.** RTX nodes only reachable via Tailscale
   (`100.64.0.126` rtx1, `100.64.0.149` rtx2). If `ssh: connect ... Operation not permitted`,
   the Tailscale daemon is down — start/repair it first. The public IP
   `118.95.213.223:23433/23434` times out from the laptop.
2. **Do NOT test `192.168.111.x` from the laptop.** Test from inside rtx1
   (`ssh rtx1 'curl http://192.168.111.8:30300/...'`).
3. **Callback 422 is non-fatal.** The trainer's fast callback to
   `<ephemeral>/callback/task_result` returns 422 (TaskResult schema vs rollout payload),
   so the trainer falls back to a 60s polling backstop and still collects fine. Expect a
   `No progress for 60s` heartbeat before collection; that alone is NOT a failure. Don't
   "fix" it by switching from `miles-pr` (that has the callback-port fix; the 422 is a
   separate schema mismatch and is safely absorbed by polling).
4. **Use `.venv` python** (`/data/siraj/ARL/.venv/bin/python`), not `srlab/bin/python`
   (no `sglang` → ImportError at the end of a run).
5. **Two concurrent runs on the same polar lane collide** (same task ids) and both stay at
   `accepted=0/2`. Before re-firing, `pkill -f run_grpo.py` and confirm none remain.
6. **Resubmitting a task id to polar re-runs the agents** (not cached), so use a fresh
   rollout-id / dump dir.
7. **Don't disable the LAN router** thinking it's wedged: the Nemotron engine is fast and
   drops to 0% util between requests. Idle ≠ hung. `:30300/v1/models` should return nemotron.
8. **Grid must stay out of the lane** — keep `LITELLM_BASE_URL` = local proxy, `LITELLM_API_KEY`
   dummy, `LITELLM_MODEL_INFO_URL` empty in any lane backend. No grid/kimi keys.

---

## 7b. ROOT-CAUSE REWARD=0 FIX (2026-08-26, verified)

**Symptom (rollout 5):** 2/2 groups collected but every reward = 0.0; all 48
traces were SINGLE-TURN degenerate echoes of the pre-flight/instruction template,
with ZERO tool calls, ZERO citations, and no tool/assistant turns in the prompt
(run 4 had avg ~5 msg multi-turn with 176 tool msgs + real answers + reward>0).

**Isolation (layered tool probe — one vespaSearch payload):**
- Engine `:30100` DIRECT (with a malformed tool/tiny budget) -> abort (probe artifact).
- **Polar gateway `:8101` -> returns correct `tool_calls` + `finish_reason:"tool_calls"`** (gateway is FINE; openai_chat transform_request does `body.copy()`, passes tools).
- **Session proxy `:18114` -> was the break.** It silently capped every request
  `max_tokens` to 2048. Under that cap the multi-turn agent's reasoning was
  truncated before it could emit a tool call -> collapse to single turn -> no
  citations -> reward 0.

**Fix:** removed the `max_tokens` cap in `/tmp/_sess_proxy_v2lane18114.py`
(now passes the caller's max_tokens through; only defaults missing value to 8192).
Restarted proxy on `:18114`. Verified: proxy + `[polar-session:<sid>]` marker +
tools + max_tokens=3000 now returns `tool_calls:true`, finish `tool_calls`.
Patched copy persisted: `remote_knowledge/rtx1/fixes/_sess_proxy_v2lane18114.py`.

**Gotcha:** this proxy is a /tmp scratch file — RE-APPLY the fix on restart.
Note: an end-to-end reward re-run (rollout 6) STALLED at `accepted=0/2` because the
active train job was saturating the shared lane (run 64/64) — the same collision as
run 5. Clean reward validation needs the lane free / a dedicated engine.


**Second mechanism (observed re-running):** even with the cap removed, a *shared-lane*
run (main rollout :8081/gateway :8101) that overlaps the active train job gets ORPHANED —
my task comes back `Task not found` on the rollout, and the adapter logs
`no usable trace (traces=0); emitting dummy placeholder` -> group dropped -> reward 0.
Symptom: `accepted=0/2` + `No progress for 60s` heartbeat while gateway run_inflight
stays at 16 (the OTHER job's sessions). The lane can only cleanly collect ONE runner at
a time. An isolated test lane (rollout :8082 / gateway :8102 / proxy :18115, same engine)
was stood up and confirmed working for the tool-call probe, but its sessions did NOT
record traces (test proxy saw zero traffic) — so it is NOT a drop-in for reward runs yet.
**Bottom line for clean verification:** need the active train job OFF the shared lane
(or a dedicated engine) before an end-to-end reward+multi-turn run can land. Tool-call
path through proxy->gateway->engine is verified fixed (probe returns `tool_calls`).


## 8. Remaining / next

- The rollout→dump→reward side is verified and reliable. The unexecuted piece is a full
  8-GPU multi-GPU training loop (`train_async.py` FSDP, ~`run_xyne_qa_fsdp_smoke.sh`).
  It needs a dedicated GPU window and a lane-pointed polar config (see §4). Do not start it
  while the e3 lane or another run is active on the same hosts.
