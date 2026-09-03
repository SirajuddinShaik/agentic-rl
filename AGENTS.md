# Agent Instructions

- Work on the `xyne-rl` branch for Xyne/Polar/Miles agentic RL changes.
- Read `RTX_MEMORY.md` in the parent workspace before touching RTX nodes.
- Treat this repository as the durable source of truth for the training system.
- Never commit secrets, credentials, checkpoints, rollout dumps, datasets, logs,
  virtual environments, or node modules.
- Preserve the separation between Xyne, Polar, and Miles.
- Keep launch scripts and configs reproducible; prefer environment variables
  over hardcoded paths or tokens.
- After changes, run:
  - `python -m compileall -q polar-pkg miles tests tools`
  - `python -m pytest tests/fast/rollout/test_polar_integrations.py -q`
  - `bash -n scripts/*.sh runs/*.sh miles/examples/polar_swegym_grpo/*.sh`
- For runtime work, follow [docs/OPERATIONS.md](docs/OPERATIONS.md).
