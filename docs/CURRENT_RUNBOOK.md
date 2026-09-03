# Current Xyne/Polar/Miles Runbook

This is the sanitized, reproducible version of the current v34 training lane.
It is written for RTX1's Miles container and assumes the 12-GPU Ray cluster is
already healthy: RTX1 GPUs 0-7 for the actor and RTX2 GPUs 4-7 for inference.

## Runtime identity

As of 2026-09-03:

- Current Ray job: `04000000`
- Current run ID: `sebi-pranav-tp2cp4ep8-lora128-qv-fc1fc2-b32-gbs64-spr16-80k-e3-v34-v30base-8h-60k-runid-20260903_104829`
- Resume checkpoint: v33 `iter_0000001`
- Trainer: `train_async_microbatch_v2.py` (async micro-batch)
- Actor topology: TP2 / CP4 / EP8 / PP1 on RTX1
- Inference topology: two TP2 SGLang engines on RTX2 GPUs 4-7
- Model identity: served and trained as `nemotron`
- Reasoning parser: `nemotron_3`
- Tool-call parser: `qwen3_coder`

## Current service topology

```text
Miles trainer
  -> Polar rollout :8081
  -> Xyne backend :3103
  -> session proxy :18114
  -> Polar gateway :8101
  -> Miles SGLang router http://192.168.111.7:30100
  -> RTX2 GPUs 4-7 (two TP2 engines)

Xyne tools -> Postgres 127.0.0.1:15432 and Vespa 127.0.0.1:18080/18081
```

The session proxy is no longer a scratch-only `/tmp` dependency. The packaged
implementation is `polar/src/polar/xyne/session_proxy.py`, the installable copy
is `polar-pkg/polar/xyne/session_proxy.py`, and the Miles runtime copy is
`miles/polar-pkg/polar/xyne/session_proxy.py`; all three are kept byte-identical.
`make start-session-proxy-v34` starts an idempotent local instance on `:18114`.

Live-state note (2026-09-03): the running `:18114` process is still the older
instrumented `/tmp` copy. Its POST path works for training, but its GET
`/v1/models` path can return 502 because `tools_stream` is initialized only on
POST. The repository version initializes it for every method. The live process
was intentionally not restarted during this audit; after the next safe restart,
the preflight's model-through-proxy check should pass.

## Critical current settings

| Setting | Value |
| --- | ---: |
| Rollout prompts per round | 32 |
| GRPO samples per prompt | 8 |
| Optimizer steps per rollout | 8 |
| Rollout prompt/response limits | 60,000 / 60,000 |
| SGLang context | 80,000 |
| SGLang max prefill | 80,000 |
| SGLang chunked prefill | 8,192 |
| Max tokens per actor GPU | 20,000 |
| Actor distributed timeout | 480 minutes |
| Actor-train hang guard | 28,800 seconds |
| Polar request / Xyne poll timeout | 7,200 seconds |
| Polar microbatch idle timeout | 1,800 seconds |
| Judge output tokens | 16,384 |
| Judge concurrency | 32 |
| Minimum accepted complete fraction | 0.125 |
| Max async level | 32 |

The repository's v34 config intentionally contains one
`polar_microbatch_idle_timeout: 1800` key. The live tmp launcher inserted this
key into a source config that already had two `900` values, so YAML's last-key
wins behavior made the effective live value `900`. The repo launcher and config
remove the duplicate keys for the next restart. The currently running v34 job
was not modified.

## Environment

Use `configs/polar/polar_credentials.env.example` as the credential template.
At minimum, provide:

- `LOAD_DIR` — completed checkpoint to resume, for example v33 `iter_0000001`
- `HF_CHECKPOINT`
- `PROMPT_DATA`
- `AGENT_CLI_DIR`
- `XYNE_SERVER_DIR`
- `XYNE_RUNTIME_IMAGE`
- `XYNE_API_KEY`
- `XYNE_ACCESS_TOKEN`
- `XYNE_AUTH_WORKSPACE`
- `ACCESS_TOKEN_SECRET`
- `JWT_SECRET`
- `DATABASE_URL`
- `JUSPAY_API_KEY`
- `WANDB_API_KEY`

The defaults encode the current lane endpoints:

- Xyne test backend: `http://localhost:3103`
- Polar rollout: `http://127.0.0.1:8081`
- Polar gateway: `http://127.0.0.1:8101`
- Session proxy: `http://127.0.0.1:18114`
- Judge/model endpoint: `http://192.168.111.7:30100/v1`

Before launching, run:

```bash
make preflight-v34
```

The preflight checks the local commands, credentials, external artifacts,
dataset schema, 12-GPU Ray cluster, Postgres/Vespa/Xyne/Polar/session-proxy/SGLang
health, local `nemotron` model identity directly and through the session proxy,
and the rendered Polar YAML contract.

## Launch

From inside the Miles container:

Clone or sync this repository inside the container (for example,
`/root/miles/agentic-rl`) so the launcher defaults to its bundled Miles tree.
To reuse the existing live trainer checkout instead, export
`PROJECT_ROOT=/root/miles` and `POLAR_PKG_DIR=/root/miles/polar-pkg` before
launching.

```bash
set -a
source /secure/polar_credentials.env
set +a

LOAD_DIR=/root/miles/tmp/ckpt/xyne_qa_tp2cp4ep8/<previous-run>/iter_XXXXXXXX \
HF_CHECKPOINT=/data/siraj/hf_models/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16 \
PROMPT_DATA=/data/siraj/ARL/data/sebi_pranav_metadata_graph_train.jsonl \
bash runs/launch_xyne_v34_current.sh
```

The launcher renders `configs/polar/polar_config_v34.yaml`, rejects unresolved
placeholders and duplicate YAML keys, verifies the expected 12-GPU Ray cluster,
and then starts `train_async_microbatch_v2.py`.

For day-to-day operation:

```bash
make status-v34
make audit-dumps DUMP_ROOT=/root/miles/tmp/xyne_qa_tp2cp4ep8/<run-id>/trajectory_dumps
```

Use `--latest 8` to audit only the newest group files and `--strict` when you
want zero-token records to fail the audit.

## Verify

```bash
ray job status 04000000 --address http://192.168.111.7:8265
ray status
```

Training progress:

```bash
grep -E "micro-batch trained|Timer actor_train|Saving LoRA checkpoint" \
  /root/miles/tmp/v34_submit.log | tail -n 50
```

Current artifact roots:

```text
/root/miles/tmp/xyne_qa_tp2cp4ep8/<run-id>/trajectory_dumps
/root/miles/tmp/ckpt/xyne_qa_tp2cp4ep8/<run-id>
```

For each completed group, inspect these fields in the corresponding
`rollout_XXXXXXXX_group_XXX.jsonl.gz` file:

```text
reward.score
polar_metadata.trajectory_metadata.evaluation.per_scorer
polar_metadata.trajectory_metadata.evaluation.group_reward
polar_metadata.trajectory_metadata.evaluation.outcome_reward
polar_metadata.trajectory_metadata.xyne_raw
judge_io
```

The raw flow must contain tool calls, tool results, reasoning blocks, citations,
and retrieved chunks. The judge request body must show `max_tokens: 16384`; it
must not be truncated to 2,048 or 4,096.

### Latest read-only v34 dump audit

Audited on 2026-09-03 against the newest four group dumps:

| Metric | Result |
| --- | ---: |
| Group files | 4 |
| Records / sessions | 642 / 32 |
| Completed / truncated | 535 / 107 |
| Finish reasons | 531 `stop`, 107 `length`, 4 `tool_calls` |
| Mean of group-file means | 0.702903 |
| Trainable / response tokens | 458,835 / 836,954 |
| Tool calls / citations / reasoning blocks | 4,988 / 1,790 / 5,630 |
| Retrieved chunks | 34,876 |
| Judge max tokens | 16,384 for all 2,392 judge records |
| Validation | PASS |

The older v33 comparison still had 2,048-token judge records and failed the same
audit; the v34 restart is the lane that activated the 16k judge contract.
