# Setup from Zero

This guide reconstructs the Xyne + Polar + Miles agentic GRPO stack from a clean
environment.

## 1. Prerequisites

- Linux host with NVIDIA GPUs
- Docker with NVIDIA Container Toolkit
- Python 3.10+ (RTX1 currently uses 3.12)
- Bun for the Xyne backend
- Compatible PyTorch, Ray, Megatron, Transformer Engine, and SGLang versions
- Access to the Nemotron 30B checkpoint and SEBI training JSONL
- Network access between RTX1 and RTX2 on `192.168.111.7` and `192.168.111.8`

The audited runtime versions are recorded in
[REPRODUCIBILITY.md](REPRODUCIBILITY.md).

## 2. Clone and configure

```bash
git clone <repo-url> agentic-rl
cd agentic-rl
git switch xyne-rl

python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e '.[dev]'

cp .env.example .env
```

Fill `.env` with local credentials. Never commit it.

## 3. Prepare external artifacts

The repository does not store private runtime artifacts. Provide:

- Nemotron checkpoint path
- training JSONL path
- Vespa and Postgres data volumes
- W&B credentials
- Xyne access token and secrets

Use `configs/polar/polar_credentials.env.example` as the credential template.

## 4. Start the service stack

```bash
set -a
source .runtime/servers.env
set +a

./scripts/servers/start_xyne_backend.sh
./scripts/servers/start_polar.sh
./scripts/servers/check_stack.sh
```

For trainer-managed inference, let Miles own SGLang. For an isolated wiring
smoke test, start SGLang separately with `scripts/servers/start_sglang.sh`.

## 5. Start the Ray cluster

On RTX1:

```bash
ALLOW_RAY_RESTART=1 bash scripts/cluster/start_ray_head_rtx1.sh
```

On RTX2:

```bash
ALLOW_RAY_RESTART=1 bash scripts/cluster/start_ray_worker_rtx2.sh
```

Confirm the cluster advertises all 12 GPUs:

```bash
bash scripts/cluster/check_ray_12gpu.sh
```

## 6. Run the smoke tests

```bash
./scripts/preflight_training.sh
python -m pytest tests/fast/rollout/test_polar_integrations.py -q
bash tools/test_without_polar.sh
```

For a Polar end-to-end smoke test:

```bash
python tools/test_with_polar.py
```

## 7. Launch training

The recommended multinode launcher is:

```bash
XYNE_RL_CREDENTIALS_FILE=/secure/polar_credentials.env   bash runs/launch_xyne_tp2cp4ep8_multinode.sh
```

Current production-style settings:

- 32 prompts per rollout
- 8 GRPO samples per prompt
- 8 optimizer steps per rollout
- TP2 / CP4 / EP8 / PP1
- LoRA rank 128
- 60k prompt/response limits
- 80k SGLang context
- 16k judge output tokens
- 8-hour actor-train timeout

## 8. Verify the first rollout

1. Confirm Polar tasks reach `completed`.
2. Confirm Xyne `/dump` contains tool calls, citations, and reasoning.
3. Confirm reward components are non-empty.
4. Confirm Miles receives masked trajectories.
5. Confirm the first optimizer step and checkpoint save.
6. Confirm SGLang receives updated LoRA weights.

## 9. Troubleshooting

- Empty tool calls: check SGLang tool-call parser and Xyne tool registry.
- No model load: verify the model name is exactly `nemotron`.
- Missing citations: inspect the raw `/dump`, not only the final answer.
- Zero rewards: inspect the reward components and judge I/O.
- Trainer stall: inspect Ray job status, actor-train timer, and GPU utilization.
- Wrong run in dashboard: repoint `DASH_DUMP_ROOT` to the active trajectory dir.
