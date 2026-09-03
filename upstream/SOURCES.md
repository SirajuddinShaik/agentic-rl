# Source Provenance

This repository was assembled on 2026-08-14 from the active RTX1 development
state. It starts a new local Git history and does not retain the upstream Miles
repository's `.git` directory.

## Miles

- Source checkout: `rtx1:/data/siraj/ARL/miles`
- Upstream repository: `https://github.com/radixark/miles.git`
- Base commit: `0113aa5ab88ed87f273f5ab1e19747731bfd2c44`
- License copy: `upstream/MILES_LICENSE`

The following integration-owned paths were copied from that working tree:

- `polar-pkg/polar/`
- `miles/rollout/polar_*.py`
- `miles/rollout/__init__.py`
- `miles/backends/megatron_utils/actor.py`
- `miles/examples/polar_swegym_grpo/`
- `tests/fast/rollout/test_polar_integrations.py`

The four Miles-side Polar files that differed from the newer ProRL source are
preserved under `upstream/miles-runtime-variants/` for comparison. They are not
the canonical installed package.

## ProRL Agent Server

- Source checkout: `rtx1:/data/siraj/ARL/ProRL-Agent-Server`
- Upstream repository: `https://github.com/NVIDIA-NeMo/ProRL-Agent-Server.git`
- Base commit: `3fa8553680619f0faddeb8214ef5be26adde760e`
- License copy: `upstream/PRORL_LICENSE`

The canonical `polar-pkg/polar/` tree comes from the active ProRL worktree.
The complete `src/slime_bridge/` implementation is stored as `slime_bridge/`,
the XYNE test suite is under `tests/xyne/`, and the setup-only SWE-Gym example
is under `examples/swegym_slime_grpo/`. Example JSONL datasets were excluded.

## RTX Operational Material

- Current XYNE launchers: `/data/siraj/ARL/runs/`
- Smoke tools: `/data/siraj/test_*polar*`, `test_without_polar.sh`, and
  `polar_final_smoke.py`
- Handouts and incident notes: `/data/siraj/XYNE*.md`,
  `/data/siraj/ARL/XYNE*.md`, and `/data/siraj/xyne_s/XYNE*.md`
- Additional durable review notes were copied from the local MTronLM workspace.

Excluded material includes credentials, virtual environments, caches, logs,
flow dumps, datasets, checkpoints, model weights, W&B output, and temporary
runtime directories.
