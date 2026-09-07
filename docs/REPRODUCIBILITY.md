# Reproducibility and Provenance

## Source snapshots

This repository captures the current live RTX1 worktrees:

- Xyne-search: `/data/siraj/xyne_s/xyne-search-test`
- Polar/ProRL Agent Server: `/data/siraj/ARL/ProRL-Agent-Server`
- Miles: `/data/siraj/ARL/miles`

The reviewable local diffs are stored under `patches/`.

The current v34 training lane is reproduced without credentials by:

- `configs/polar/polar_config_v34.yaml`
- `runs/launch_xyne_v34_current.sh`
- `scripts/servers/start_session_proxy_v34.sh`
- `configs/polar/session-proxy.env.example`
- [CURRENT_RUNBOOK.md](CURRENT_RUNBOOK.md)

The Polar source tree, installable `polar-pkg/` tree, and Miles runtime package
are synchronized for the Xyne harness, session proxy, evaluator, and local
Nemotron judge. `tests/test_current_v34_repro.py` fails if these copies drift.

## Audited runtime

The active Miles container used:

- PyTorch `2.11.0+cu130`
- Ray `2.56.1`
- SGLang `0.5.17.dev36+gcb05a44`
- Transformer Engine `2.17.0`
- Megatron Core `0.16.0rc0`
- Megatron Bridge `0.5.0+7f0fb345`
- Transformers `5.12.1`
- W&B `0.28.1`

The active training image was:

```text
radixark/miles@sha256:08be00658cd24eaa364ca4ad0b1a3911dfbe4adc04fd0c148e4241402fb40812
```

The active Polar runtime image was:

```text
sha256:3dc40f6b6bead90e6778eb1f44664cf250abbe21db35f54f52c0db1e01585966
```

## Local bootstrap

A clean checkout can be prepared with:

```bash
make bootstrap
```

This creates `.venv`, installs the lightweight development dependencies, and
copies `.env.example` to a private `.env`. GPU services still require the
pinned Miles image, external model/data artifacts, credentials, Docker with
the NVIDIA runtime, and the topology documented in `SETUP_FROM_ZERO.md`.

## Current dump validation

On 2026-09-03, the newest four v34 group dumps passed
`tools/reward/audit_current_dumps.py`: 642 records across 32 sessions, 535
completed and 107 truncated, 4,988 tool calls, 1,790 citations, 5,630 reasoning
blocks, 34,876 retrieved chunks, 458,835 trainable tokens, and 16,384 judge
max tokens for every judge record. The mean of the four group-file means was
0.702903.

## Reproduction warning

The live source trees had local modifications. Checking out only the upstream
base commits does **not** reproduce the working training system. Use this
repository or apply the patches in `patches/` to the matching upstream
checkouts.

## Not stored in Git

- model checkpoints
- training JSONL datasets
- rollout dumps
- logs
- W&B state
- virtual environments
- node modules
- secrets
