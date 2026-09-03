# RTX1 Runtime Manifest

Captured from RTX1 on 2026-08-14. This records the environment that produced
the current scripts; it is an inventory, not yet a fully locked build recipe.

## Source Revisions

| Component | Revision |
| --- | --- |
| Miles | `0113aa5ab88ed87f273f5ab1e19747731bfd2c44` plus the overlay in this repository |
| ProRL Agent Server | `3fa8553680619f0faddeb8214ef5be26adde760e` plus `polar-pkg/` here |
| Slime (legacy path) | `aaf5c2092b01219fa0d5c2d323741d409086ca32` |
| Megatron-LM inside the active Miles image | `37f91617b95c1ef4f01fc66210e502572ad97fda` |
| Host Megatron-LM development tree (not the active job) | `3e89f3c5304be32609613da2eade5956d461b73e` |
| XYNE Search | `e546619add7a76986714095f5b84b85bdd83b509` plus the route snapshot here |

Megatron Bridge was installed as an editable/package dependency but its RTX1
directory was not itself a Git checkout, so the package version below is the
only captured identifier.

## Active Miles Container Stack

| Package | Version |
| --- | --- |
| PyTorch | `2.11.0+cu130` |
| Ray | `2.56.1` |
| SGLang | `0.5.17.dev36+gcb05a44` |
| Transformer Engine | `2.17.0` |
| Megatron Core | `0.16.0rc0` |
| Megatron Bridge | `0.5.0+7f0fb345` |
| Transformers | `5.12.1` |
| NVIDIA ModelOpt | `0.45.0` |
| TorchAO | `0.17.0+cu130` |
| W&B | `0.28.1` |

The active training image is
`radixark/miles@sha256:08be00658cd24eaa364ca4ad0b1a3911dfbe4adc04fd0c148e4241402fb40812`,
created `2026-08-10T12:54:32.85602528Z`.

The separate `/data/siraj/ARL/.venv` is not the environment used by the active
container job. It currently reports PyTorch `2.13.0`, SGLang
`0.5.15.post2.dev510+gd7b942552`, Megatron Core `0.18.0+85bced0ae`, and
Megatron Bridge `0.6.0`; mixing those values into the container manifest would
be incorrect.

The active Polar runtime image was
`sha256:3dc40f6b6bead90e6778eb1f44664cf250abbe21db35f54f52c0db1e01585966`,
created `2026-08-11T13:27:53.847480766Z`.

ModelOpt warns that Transformers `5.12.1` is outside its tested compatibility
set. The current model loads, so this is not a demonstrated crash, but the pair
should be pinned and covered by checkpoint load/save tests.

## Reproducibility Warning

Miles, ProRL, and XYNE had local modifications at capture time. The relevant
Miles and ProRL integration files are consolidated here; the XYNE route/storage
snapshot is under `integrations/xyne-backend/`. A production image should be
built from committed upstream forks and pinned by image digest before a long
run. Do not assume that checking out only the base SHAs reproduces RTX1.
