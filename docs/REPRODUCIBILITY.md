# Reproducibility and Provenance

## Source snapshots

This repository captures the current live RTX1 worktrees:

- Xyne-search: `/data/siraj/xyne_s/xyne-search-test`
- Polar/ProRL Agent Server: `/data/siraj/ARL/ProRL-Agent-Server`
- Miles: `/data/siraj/ARL/miles`

The reviewable local diffs are stored under `patches/`.

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
