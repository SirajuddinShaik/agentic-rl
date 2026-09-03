# Agentic RL

**Agentic RL** is the consolidated monorepo for the Xyne + Polar + Miles agentic
GRPO training system. It captures the live RTX1/RTX2 training stack, the custom
integration logic, the launch configurations, the reward pipeline, and the
operational handouts built during the recent training runs.

- **Default branch:** `xyne-rl`
- **Source snapshot:** current live RTX1 worktrees
- **Scope:** source, configs, scripts, tests, docs, and patches
- **Not included:** checkpoints, model weights, rollout dumps, logs, datasets,
  virtual environments, node modules, and secrets

## What this repo contains

| Path | Purpose |
| --- | --- |
| `xyne-search/` | Live Xyne backend source and deployment scripts |
| `polar/` | Live Polar/ProRL Agent Server source and tests |
| `polar-pkg/` | Packaged Polar runtime used by the monorepo |
| `miles/` | Live Miles training source, launch scripts, and tests |
| `miles-pr/` | Slim Miles PR overlay for upstream review |
| `configs/` | Environment templates and topology configs |
| `scripts/` | Setup, preflight, server, and cluster scripts |
| `runs/` | Launch scripts for single-node and multinode training |
| `tests/` | Focused integration and reward tests |
| `tools/` | Smoke tests, reward debugging, and conversion tools |
| `docs/` | Setup, architecture, custom logic, operations, and history |
| `patches/` | Reviewable diffs from the three live source trees |
| `data/` | Dataset builder and probes; private JSONL data is not committed |

## Quick start

```bash
git clone <repo-url> agentic-rl
cd agentic-rl
git switch xyne-rl

python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e '.[dev]'

cp .env.example .env
# Fill local credentials; never commit .env.
```

Run the lightweight checks:

```bash
./scripts/check_env.sh
python -m compileall -q polar-pkg miles tests tools
python -m pytest tests/fast/rollout/test_polar_integrations.py -q
bash -n scripts/*.sh runs/*.sh miles/examples/polar_swegym_grpo/*.sh tools/*.sh
```

The full GPU runtime also needs Docker, CUDA, PyTorch, Ray, Megatron,
Transformer Engine, SGLang, Bun, Vespa, and Postgres from the target RTX
environment.

## End-to-end training flow

```text
Miles / Megatron GRPO
        |
        | grouped rollout request
        v
Polar rollout server
        |
        | task + session orchestration
        v
Xyne backend
        |
        | agent loop + retrieval tools
        v
Vespa / Postgres
        |
        | full conversation dump
        v
Polar gateway + evaluator
        |
        | reward + masked trajectory
        v
Miles actor update
        |
        | LoRA weight sync
        v
SGLang inference
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Setup from zero](docs/SETUP_FROM_ZERO.md)
- [Custom logic and local changes](docs/CUSTOM_LOGIC.md)
- [Operations and monitoring](docs/OPERATIONS.md)
- [Reproducibility and provenance](docs/REPRODUCIBILITY.md)
- [Patch guide](patches/README.md)
- [Historical handouts](docs/history/)

## Safety

This repository is scrubbed for secrets. Do not commit `.env`, API keys, JWTs,
W&B keys, model checkpoints, rollout dumps, datasets, or private logs. Use the
provided environment templates and inject secrets at runtime.

## License

The consolidated source retains the upstream licenses in each component
directory. See `xyne-search/LICENSE`, `polar/LICENSE`, and `miles/LICENSE`.
