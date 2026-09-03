# v19 GRPO Training — Live Status & Replication Handoff

Last updated: 2026-08-30 ~19:45 UTC (RTX1 clock), by the monitoring agent.

## TL;DR

The polar/xyne GRPO generation+yield lane is **confirmed working end-to-end**. A real
weight-update step ran on accepted groups with real rewards, and the trainer is
sustaining more micro-batches. This is the milestone the whole effort was blocked on
("accepted=0/32", trainer not turning).

## Run identity

- Launch script: `/root/miles/tmp/launch_v19_45m_partial_runid.sh`
- Submit log: `/root/miles/tmp/v19_submit.log`
- Run id: `sebi-...-v19-45m-partial-runid-20260830_181540`
- Driver pid: `1444009` (train_async_microbatch_v2)
- Container: `miles-never-delete` on RTX1
- Trainer entry: `train_async_microbatch_v2.py` (async micro-batch lane)
- Rollout fn: `miles.rollout.polar_rollout.generate_rollout_polar_async_microbatch`
- Reward / post-process: `miles.rollout.polar_reward.custom_rm` / `post_process_rewards`
- GPUs: RTX1 0-7 = train, RTX2 4-7 = inference (never touch RTX2 0-3)

## Confirmed milestone (the "everything is fine" gate)

At `2026-08-30 19:30:38` (rtx1 UTC) the first real training step completed:

```
step 0: {'train/loss': -0.01838, 'train/pg_loss': -0.01825, 'train/entropy_loss': 0.12974,
         'train/pg_clipfrac': 0.008, 'train/ppo_kl': 0.00334, 'train/ess_ratio': 3.71,
         'train/grad_norm': 0.08455, 'train/lr-pg_0': 5e-06, 'train/step': 0}
train_async_microbatch_v2.py:156 - rollout_id=0 micro-batch trained: 4/32 groups (step 1, groups=4 samples=32)
```

The generator collected a full set of accepted groups (initial `num_samples=212,
num_rollouts=[32]` DP schedule) and the trainer trained the first available micro-batch.
`accepted` counter had moved off 0 (was 7/32 and climbing) and GPUs alternated between
~90-100% during training and 0% while waiting for more long sessions to finish.

## What was wrong before / the fix (v18 -> v19)

1. **Sessions timed out empty** and whole groups were dropped as "zero trainable tokens",
   so the trainer sat at `accepted=0/32` while engines burned. Fix: raised timeout to
   **45 min** (`polar_request_timeout: 2700`, `timeout_seconds: 2700`,
   `XYNE_POLL_TIMEOUT_SECONDS: '2700'`) plus a partial-salvage slack
   (`POLAR_SESSION_RESULT_TIMEOUT_MS=3900000`) and `node.py:97` `_harvest_eval_seconds`
   2700 -> 900 so eval-on-timeout doesn't blow the result window.
2. **Stale router port 30100** after a killed v18 left `sglang::router` holding the port;
   v19 relaunch died once on it. Fixed by killing the stale routers inside the container
   and relaunching clean.
3. **Dumps went to one shared folder.** Fix: `MILES_POLAR_TRAJECTORY_DUMP_DIR` now
   resolves to `${TRAJECTORY_DUMP_DIR}` (per-run), so dumps land in the run-specific
   `...181540/trajectory_dumps/` folder, NOT `trajectory_dumps_current/`.

## Evidence of reward health (from `<run>/trajectory_dumps/group_rewards/`)

Each group file is a JSON with `group_mean_raw`, `group_mean_normalized`, and per-trace
`reward_summary` sub-scores. Completed traces carry real values; aborted/empty traces are 0.

| group | n_samples | group_mean_raw | notes |
|-------|-----------|----------------|-------|
| 0 | 83 | 0.319 | mixed aborted/completed |
| 1 | 41 | 0.262 | mixed |
| 3 | 42 | 0.363 | completed trace: completion 1.0, answer_format 1.0, citation_presence 1.0, citation_relevance 1.0, citation_accuracy 0.0, llm_judge 1.0 |
| 4 | 46 | 0.417 | completed trace: llm_judge 1.0, citation_relevance 0.667, citation_accuracy 0.0 |

Sub-reward keys seen: `completion`, `answer_format`, `citation_presence`,
`citation_relevance`, `citation_accuracy`, `llm_judge`, `retrieval_qu...`.

## Monitoring (durable)

Codex-side heartbeat automations were **not available** in this runtime, so a node-side
watchdog was installed on RTX1:

- Script: `/root/miles/tmp/v19_monitor.sh` (host `/tmp/v19_monitor.sh`, copied via
  `docker cp` into `miles-never-delete`)
- Loop pid: `1568142`, runs the script every 1200 s
- Status file: `/root/miles/tmp/v19_monitor_status.log`
- One line per check: timestamp, driver pid, avg RTX1 GPU util, last rollout, last
  `update_weights` end, `accepted=x/32`, dropped-group count.

## Known bottleneck (not a bug)

Multi-turn sessions with tool calls legitimately take ~40-45 min each before their group
completes, so the trainer periodically sits at low/0% GPU between micro-batches. This is
expected throughput behaviour, not a stall. To gain speed later, lower per-session
latency (fewer/cheaper tool round-trips) or raise concurrent accepted-group capacity —
but the existing run must stay untouched for confirmation.

## Key commands

```bash
# Accepted / trained progress
ssh rtx1 'docker exec miles-never-delete sh -c "grep -aoE \"accepted=[0-9]+/[0-9]+\" /root/miles/tmp/v19_submit.log | tail; grep -aoE \"rollout_id=[0-9]+ micro-batch trained[^\n]*\" /root/miles/tmp/v19_submit.log | tail"'

# Live triage tail
ssh rtx1 'docker exec miles-never-delete sh -c "tail -40 /root/miles/tmp/v19_submit.log"'

# Polar host logs
ssh rtx1 'tail -40 /data/siraj/ARL/logs/polar_rollout_v19.log; tail -40 /data/siraj/ARL/logs/polar_gateway_v19.log'

# Watchdog status
ssh rtx1 'docker exec miles-never-delete sh -c "cat /root/miles/tmp/v19_monitor_status.log"'
```

## Follow-up diagnosis (monitor turn 2, ~20:05 UTC)

Status after ~2h: training IS confirmed working and continuing, but the run is ALSO
showing the v18 empty-session starvation. Concrete numbers as of 20:05:

- `accepted=7/32` (stalled), `dropped=16` groups.
- First real weight update DONE (step 0). A second training step (micro-batch 2) has
  been running ~30+ min on RTX1 GPUs at 100%, no `step` log yet — each training step is
  very slow (~25-30 min) with full recompute at 64k cap.
- Engines (RTX2 4-7) still generating next batch (~28 running, 0 queued).

### Starvation root cause (evidence-backed)

Groups 0-6 genuinely completed with real content at 19:05. Groups 8-31 ran the full
budget and auto-failed EMPTY at ~19:50 (`polar.rollout.manager: Task ...-17-... completed
with 8 results` for all of 17-31, where every member was
`No harvestable partial result ... auto-failing member`). The trainer then dropped them
as `zero trainable tokens` (16 total).

The gateway produced EMPTY trajectories (no traces AND no error) for those sessions —
so they are not a harvest-timing problem. Correlated gateway evidence:

- `polar.gateway.node: Node heartbeat failed` repeatedly (18:52, 19:09, 19:15, 19:19,
  19:26, 19:40, 19:43, 19:48).
- `polar.gateway.node: Failed to deliver callback for session ... to
  http://127.0.0.1:8081/callbacks/session_result` (`httpx.ReadError`) at 19:50:46 /
  19:50:51.

### Fix plan (deferred — NOT applied this turn)

The trainer lane itself works; do NOT restart it (it is currently confirmed-training and
the user wants the working lane kept running). The empty-session loss is on the polar
rollout (:8081) / gateway (:8101) side. Next run / safe window:

1. Restart the polar rollout + gateway servers cleanly (they currently show intermittent
   loopback delivery/timeout failures to each other).
2. Harden the gateway->rollout result push with retry/backoff (currently a bare
   `httpx.ReadError` is not retried, so results are dropped).
3. Review per-session budget: 45 min exec + 65 min result window is being exhausted by
   sessions that produce nothing; lower session concurrency-driven queue latency or trim
   the tool loop so a session reliably yields a harvestable partial before the deadline.
4. Consider treating a session with `traces` (even partial/aborted) as harvestable so the
   reward function runs on partials instead of dropping the whole group.

## Monitor turn 3 progress (~20:43 UTC)

- 8/32 groups trained across TWO confirmed weight-update steps (step 0 loss -0.0184;
  step 2 `8/32 groups`). step 3 (micro-batch 3) in progress ~27 min (GPUs 100%; megatron
  actors 62% CPU, R state — slow-at-64k-recompute, not hung). Driver pid 1444009 alive.
- accepted=7/32, dropped=16 (unchanged) — the empty-session starvation persists but does
  NOT block the trainer; it salvages partial batches and keeps running weight updates.

### Starvation fix STAGED (not yet live — deferred to safe window)

Root cause of the empty-group drops: polar gateway `node.py:943 _push_result` does a
SINGLE untried POST of the session result to the rollout server (:8081). A transient
loopback `httpx.ReadError` drops the result; the session then comes back to the trainer
as empty/zero-trainable and the group is dropped.

- Backed up original: `/data/siraj/ARL/tmp_fixes/node.py.orig`
- Hardened version staged: `/data/siraj/ARL/tmp_fixes/node.py.retryfix`
- Change: `_push_result` now retries 5x with 0.5->4s exponential backoff (cap ~7.5s).
  Syntax-checked; `asyncio` already imported.
- APPLY ONLY IN A SAFE WINDOW (mid-run the trainer + engines are actively generating; a
  polar rollout/gateway restart would drop the ~27 in-flight sessions). When safe:
  `cp /data/siraj/ARL/tmp_fixes/node.py.retryfix
     /data/siraj/ARL/ProRL-Agent-Server/src/polar/gateway/node.py` then restart polar
  rollout (:8081) + gateway (:8101).

## COMPLETE (verified ~06:23 UTC)

Run reached the healthy, self-sustaining end state:
- rollout 0 trained FULL 32/32 groups (8 micro-batch steps); rollout 1 at 28/32 (training
  last micro-batch). Real weight updates + post-training weight broadcast to engines
  confirmed (update_weights end 00:09:21, 71.6s).
- Per-run dumps verified: 64 group_rewards/*.jsonl + 65 rollout_*.gz in
  ...v19-45m-partial-runid-20260830_181540/trajectory_dumps (NOT the shared dir, whose
  newest file is stale from a prior run on Aug 30 16:09).
- Driver pid 1444009 alive continuously; RTX1 train GPUs 0-7 at ~100%.
- The empty-session starvation no longer blocks batches: the trainer fills complete
  32/32-group mini-batches and rolls between rollouts. Root cause (gateway _push_result
  single untried POST) diagnosed and hardened fix staged at
  /data/siraj/ARL/tmp_fixes/node.py.retryfix for a future safe-window restart.
