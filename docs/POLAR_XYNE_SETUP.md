# Polar + XYNE Setup

This is the setup guide for the standalone `xyne-rl` development repository.
It consolidates the Polar/XYNE runtime, Miles and Slime bridge code, tests,
launch scripts, and operational handouts copied from RTX1.

## Git

The repository has its own Git history and is independent of upstream Miles
and ProRL histories.

```bash
cd /path/to/xyne-rl
git remote -v
git status --short
git log --oneline --decorate -10
```

Source commits and copied paths are recorded in `upstream/SOURCES.md`.

Create a feature branch before making further changes:

```bash
git switch -c feature/my-change
```

Do not commit API keys, tokens, checkpoints, logs, or local environment files.

## Python Environment

Miles targets Python 3.10+. The RTX1 source environment used Python 3.12.3.
For an isolated local environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e '.[dev]'
```

The repository's `pyproject.toml` installs `polar-pkg/polar` and exposes the
`polar` and `xyne-submit` commands. For direct source execution, use:

```bash
export PYTHONPATH="$PWD/polar-pkg:$PWD:${PYTHONPATH:-}"
```

The full GPU runtime also needs the compatible CUDA, PyTorch, Megatron,
Transformer Engine, SGLang, and Ray versions used by the target Miles image or
RTX environment. Install those from the target environment's documented
runtime rather than mixing arbitrary system versions into this venv.

## Important Paths

- `miles/rollout/polar_adapter.py`: Miles-side Polar adapter
- `miles/rollout/polar_config.py`: Polar configuration
- `miles/rollout/polar_data_source.py`: Polar data-source bridge
- `miles/rollout/polar_reward.py`: reward extraction and scoring bridge
- `miles/rollout/polar_rollout.py`: rollout integration
- `miles/examples/polar_swegym_grpo/`: launchers and example configs
- `polar-pkg/polar/xyne/`: XYNE harness, flow, evaluator, reward, and tool helpers
- `tests/fast/rollout/test_polar_integrations.py`: focused integration tests
- `configs/servers/README.md`: service ordering, templates, and health checks
- `upstream/SOURCES.md`: copy provenance and upstream base commits

## Smoke Tests

Run the focused tests after activating the environment and exporting
`PYTHONPATH`:

```bash
python -m pytest tests/xyne -q
python -m pytest tests/fast/rollout/test_polar_integrations.py -q
python -m compileall -q miles polar-pkg tests/fast/rollout/test_polar_integrations.py
git diff --check
```

Some tests are optional and skip when SGLang or the external XYNE service is
unavailable. A passing local test does not prove that a multi-GPU rollout can
complete; run the target smoke launcher only on the intended RTX node.

## XYNE Configuration

The example configuration is under
`miles/examples/polar_swegym_grpo/polar_config_xyne_qa.yaml`. Keep credentials
in environment variables and inject them at runtime. Do not place secrets in
YAML files or shell scripts. Confirm the configured model allow-list, tool
profiles, phase timeouts, and XYNE endpoint before starting a live run.

The `polar-pkg/polar/xyne/` code expects the harness flow to return structured
tool calls, tool results, document/chunk identifiers, citations, and the final
answer. Preserve the full raw dump when diagnosing missing tools or incomplete
answers.

## Repository Scope

Excluded from this copy are `tmp/`, `logs/`, `checkpoints/`, `datasets/`,
virtual environments, `node_modules/`, Python caches, and W&B caches. This is
therefore a lightweight development repository, not a runnable copy of every
RTX runtime artifact. Apply the Miles overlay with
`scripts/apply_miles_overlay.sh` before launching from a full Miles checkout.
