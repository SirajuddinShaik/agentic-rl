# Xyne + Polar Concurrency Fix

## Root causes

1. The shared session proxy used one fixed listener and was started concurrently by multiple runtime sessions. This caused `Address already in use` and completion attribution failures.
2. A container-local route registry under `/tmp` was invisible to the host proxy when Docker runtimes were used.
3. The ad-hoc smoke payload used `/polar/session/workspace`, which was not created by the Xyne runtime and produced exit code 127 before the harness ran.
4. `XyneHarness.postprocess()` stored `xyne_raw` on `AgentRunResult.metadata`, but the gateway did not merge that metadata into the trajectory before evaluation.

## Deployed fixes

- `remote_knowledge/rtx1/patches/ProRL-Agent-Server.polar.xyne.harness.py`
  - Uses a threaded shared proxy.
  - Embeds `[polar-session:<session_id>]` in each Xyne instruction.
  - The proxy extracts that marker directly from each completion request, removing the cross-container filesystem dependency.
  - Proxy startup is serialized and waits for readiness.
  - Failed step diagnostics are retained when available.
- `remote_knowledge/rtx1/patches/ProRL-Agent-Server.polar.gateway.node.py`
  - Merges `AgentRunResult.metadata` into trajectory metadata before evaluator execution.

Both files are synced to RTX1 under `/data/siraj/ARL/ProRL-Agent-Server/src/polar/` and the gateway/rollout services were restarted.

## Required Xyne task settings

- Runtime image: `polar-xyne-runtime:withwait` (contains `python3` and `wait-for-xyne.sh`).
- Runtime workdir: `/polar/session`.
- Persistent backend: `skip_boot: true`, with the correct `base_url` and access-token environment.
- Shared proxy must be listening on `127.0.0.1:18100` before a large burst, or be started by a single supervisor before submitting tasks.

Do not use the generic `polar.xyne.submit_tasks.build_payload()` defaults unchanged for this deployment: its default workdir is `/polar/session/workspace` and its default image may not contain the Xyne helper dependencies.

## Verification

Final RTX1 smoke: 8 concurrent correctly configured sessions.

- 8/8 completed.
- Each produced 4–5 reconstructed completions/traces.
- 8/8 persisted `xyne_raw`.
- 8/8 had no evaluator error.
- No new proxy bind error occurred during the final run.
