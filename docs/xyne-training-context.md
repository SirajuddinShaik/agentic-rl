# Xyne GRPO Training Context — Nemotron-3-Nano-30B-A3B

> Living reference document for the Xyne Q&A GRPO training run via Miles (megatron-FSDP).
> Status snapshot: **2026-08-11 ~20:20**. Update this file as the run progresses.

## Goal

Train `NVIDIA-Nemotron-3-Nano-30B-A3B` with GRPO on an Xyne SEBI Q&A dataset. Reward is the
Xyne composite `score` (`XyneCompositeEvaluator`, `--reward-key score`). Success criterion:
a training rollout that produces a **nonzero composite `score`** (proves the end-to-end
pipeline: prompt → sglang rollout → Xyne agentic answer → evaluator score → GRPO update).

## Hardware / Topology

- GPUs 2–7 inside the `miles-never-delete` container (`radixark/miles:latest`).
  - GPUs 2–5: FSDP actor (4 GPUs).
  - GPUs 6, 7: SGLang rollout engines (TP2, `--rollout-num-gpus 2 --rollout-num-gpus-per-engine 2`).
- Host networking everywhere. Rollout backend uses port **3001**; SGLang router uses **30100**.

## Key Containers / Services

| Name | Role | Notes |
|---|---|---|
| `miles-never-delete` | Training host container | NEVER delete. tmux at `/usr/bin/tmux` |
| `siraj-xyne-db` | Postgres (host port 15432) | DB schema already migrated (v2_chat_*, workflow.*, agents, sub_agents) |
| SGLang `:30100` | Rollout inference (TP2, GPUs 6–7) | Boots with the trainer |

## Standing Rules (operator constraints)

- **Never commit.**
- **NEVER edit `/data/siraj/xyne_s/xyne-search`** (the Xyne backend repo).
- **Never edit `xyne_fetch_flow.py`** — *overridden*: a cookie-auth fix was REQUIRED (see below),
  applied only in the `polar-pkg` helper copy (the fixed version already existed in ProRL source).
- Tell the user before changes. Do not touch `/data/polar` eval deployment.
- Poll with exponential backoff; keep running until training is done.

## Two Backend-Integration Fixes (both verified)

1. **Template mount** `polar_config_xyne_qa.yaml` line 77 changed `:ro` → `:rw` for
   `{args.polar_xyne_server_dir}:/workspace/xyne/server` (line 76 `/opt/node:ro` kept).
   The Xyne backend does `fs.mkdirSync('server/downloads',{recursive:true})` at boot against
   the mounted repo; `:ro` caused an EROFS crash. `:rw` + a pre-created world-writable
   `/data/siraj/xyne_s/xyne-search/server/downloads` (chmod 777, gitignored — the only host
   change ever made to the Xyne repo) lets the backend boot `/v2/health` → 200.

2. **EADDRINUSE** — the harness originally booted the backend via `nohup bun run dev:v2`
   (= `bun run --watch app/server.ts`). Bun `--watch`/HMR reload spawns a new process that
   rebinds the already-held host:port → `EADDRINUSE: Failed to start server. Is port 3001 in use?`
   → backend dies mid-rollout → no completions. Fixed by booting non-watch:
   `cd {server_dir} && nohup bun app/server.ts >{SERVER_LOG_PATH} 2>&1 &` (harness.py line ~158).

## Authentication Fix (the current active issue)

- The Xyne backend `/v2/chat/conversations` requires an **`access-token` cookie** (HYPHEN).
  The `x-api-key` header alone → **401 Unauthorized**.
- Cookie name constant: `ACCESS_COOKIE = "access-token"` (config `AccessTokenCookie`).
- JWT: HS256, signed with `ACCESS_TOKEN_SECRET`, payload
  `{sub, role, workspaceId, tokenType:"access", exp, authProvider}`.
  Secret: supplied through the `ACCESS_TOKEN_SECRET` environment variable.
  (source: `/workspace/xyne/server/server/.env`, also pinned in config agent env).
  User: `shaik.s@juspay.in`, role `SuperAdmin`, workspace `g0xufd0v4fcvjqa02x4uror1`.
- **FIX**: `xyne_fetch_flow.py` (the helper running inside the rollout runtime) now reads
  `XYNE_ACCESS_TOKEN` env and sends `Cookie: access-token=<token>` on every request.
  The fixed helper already existed at
  `/data/siraj/ARL/ProRL-Agent-Server/src/polar/xyne/xyne_fetch_flow.py` and was synced into
  `/data/siraj/ARL/miles/polar-pkg/polar/xyne/xyne_fetch_flow.py` (the copy the trainer imports).
- **VALIDATED in isolation**: with the cookie the helper produces a `conversation_id` +
  `run_id` (no more 401, no more `missing xyne_raw`). The `answer` came back empty in the
  standalone test only because sglang/gateway were not wired to that isolated backend.

## Rollout Failure Diagnosis (still active)

Rollouts return `status: ERROR, error: "no completions"` with
`evaluation.error: "missing xyne_raw"`, `outcome_reward: 0.0`, `traces: []`.

- `missing xyne_raw` is emitted by `evaluator.py` (`XyneCompositeEvaluator.evaluate`) when
  `trajectory.metadata["xyne_raw"] is None` — i.e. the harness `postprocess` did not inject the
  raw flow. Postprocess reads `/polar/session/xyne_raw.json` via `runtime.exec("cat ...")`;
  on failure/empty/invalid JSON it sets `xyne_raw_error` instead.
- Current hypothesis being tested (user directive m0131: *"hardcode the token"*): the runtime
  JWT mint (`harness.py` lines 217–234) is fragile (mint subprocess may not see
  `ACCESS_TOKEN_SECRET`, or token rejected). Hardcoding a long-lived `XYNE_ACCESS_TOKEN` into the
  config `agent.env` is being validated. **Do not declare training done until a rollout yields a
  nonzero `score`.**

## Harness / Helper Mechanics (polar-pkg)

- `polar.xyne.harness:XyneHarness` boot chain (per rollout task):
  set agent env → `cd {server_dir} && nohup bun app/server.ts ... &` →
  `wait-for-xyne.sh -H localhost -t 120 -i 2` → mint JWT → run
  `python3 xyne_fetch_flow.py --instruction <q> --output /polar/session/xyne_raw.json
  --base-url http://localhost:3001 --timeout 300` → `echo XYNE_RAW_PATH=...`.
- If `LITELLM_BASE_URL` is set, a python reverse-proxy on `127.0.0.1:18100` forwards to
  `127.0.0.1:8100`, injecting `x-session-id: $SESSION_ID` (GRPO session attribution).
  Config sets `LITELLM_BASE_URL=http://127.0.0.1:8100` + `LITELLM_API_KEY=dummy-polar-gateway`.
- Helper is **stdlib-only** (urllib/json/argparse) — runs inside the runtime image without Polar venv.

## Key Files

| Path | Purpose |
|---|---|
| `/data/siraj/ARL/ProRL-Agent-Server/src/polar/xyne/harness.py` | Harness (authoritative source) |
| `/data/siraj/ARL/ProRL-Agent-Server/src/polar/xyne/xyne_fetch_flow.py` | Helper (AUTHORITATIVE, fixed cookie-auth) |
| `/data/siraj/ARL/miles/polar-pkg/polar/xyne/harness.py` | Harness copy the trainer imports (== source) |
| `/data/siraj/ARL/miles/polar-pkg/polar/xyne/xyne_fetch_flow.py` | Helper copy the trainer imports (== source, sync it on edits) |
| `/data/siraj/ARL/miles/polar-pkg/polar/xyne/evaluator.py` | `XyneCompositeEvaluator`; `missing xyne_raw` at line 303 |
| `/data/siraj/ARL/miles/miles/examples/polar_swegym_grpo/polar_config_xyne_qa.yaml` | Source config template (line 77 `:rw`) |
| `polar_config_xyne_qa.yaml` → rendered `/root/miles/tmp/xyne_fsdp/<RUN_ID>/polar_config_custom.yaml` | Per-run rendered config |
| `/root/miles/miles/examples/polar_swegym_grpo/run_xyne_qa_fsdp.sh` | FSDP launcher (in container) |
| `/data/siraj/xyne_s/xyne_qa_train.jsonl` | Prompt data (`--input-key prompt --label-key label`) |
| `/data/siraj/xyne_s/xyne-search/server/app/server.ts` | Xyne backend (DO NOT EDIT) |
| `/data/siraj/logs/xyne_grpo/rollouts/task_polar-xyne-qa-grpo-*/ses_sk-polar-*.json` | Rollout session artifacts (verification target) |

> Note: `/root/miles` (container path) == `/data/siraj/ARL/miles` (host path, same bind mount).
> polar-pkg files are the ones actually imported — always sync edits there.

## Monitor / Verify Commands

```bash
# tmux running trainer
docker exec miles-never-delete bash -lc '/usr/bin/tmux capture-pane -t xyne_fsdp -p'
# ray jobs (no --tail flag in this ray version)
docker exec miles-never-delete bash -lc 'ray job list'
docker exec miles-never-delete bash -lc 'ray job logs <raysubmit_id>'
# sglang health
curl -s http://127.0.0.1:30100/health
# DB
docker exec siraj-xyne-db psql -U xyne -d xyne -c "SELECT ..."
# newest rollout artifact
ls -t /data/siraj/logs/xyne_grpo/rollouts/task_polar-xyne-qa-grpo-*/ses_sk-polar-*.json | head
```

## Run Launcher (relaunch command)

```bash
docker exec miles-never-delete bash -lc '/usr/bin/tmux new-session -d -s xyne_fsdp \
  "bash /root/miles/miles/examples/polar_swegym_grpo/run_xyne_qa_fsdp.sh 2>&1 | \
  tee /root/miles/tmp/xyne_fsdp/relaunch_fixed_$(date +%Y%m%d_%H%M%S).log"'
```

Key training flags: `--reward-key score --num-rollout 1 --rollout-batch-size 1
--n-samples-per-prompt 2 --rollout-max-response-len 128 --train-backend fsdp --lora-rank 8
--sglang-router-port 30100 --sglang-lora-backend triton --attn-implementation flash_attention_2
--gradient-checkpointing --advantage-estimator grpo`.

## Sample Prompt (first line of train jsonl)

> In SEBI Spl Case No.259/14, what consequence did the court prescribe if the convicted
> directors failed to pay the fine of Rs.5,00,000 imposed on each of them?
> (label: six months simple imprisonment; `--reward-key score`, composite via many scorers:
> completion/answer_format/retrieval_quality/embedding_similarity/tool_call_efficiency/token_efficiency)

## Current Run State

- Latest job: `raysubmit_jvVLthk3qZLDCFjB` (RUN_ID `20260811_201656`) — produced failing
  rollouts (missing xyne_raw); needs rework per the hardcoded-token fix, then re-launch.
- `:3001` freed after killing an orphaned test backend (PID 2340845, killed via a privileged
  `--pid host` container; user's own dev backend PID 70355 `backendv2/server.ts` left untouched).
- Diagnostic container `xyne_rt_diag` (image `polar-xyne-runtime:withwait`) reproducing the
  harness chain to confirm the real failure before re-launching.
