# Megatron-Bridge Plan for HF MoE -> Megatron 5D

Created 2026-06-29 after cloning `NVIDIA-NeMo/Megatron-Bridge`.

Local clone:

- `third_party/Megatron-Bridge`

Reference repo:

- https://github.com/NVIDIA-NeMo/Megatron-Bridge

## Why Use Bridge

Megatron-Bridge is the right layer for Hugging Face to Megatron conversion because it has:

- `AutoBridge` for HF architecture detection.
- Bidirectional HF/Megatron weight streaming.
- Parallelism-aware conversion including TP, PP, CP, EP, and ETP.
- Built-in model bridges for Qwen MoE, OLMoE, Nemotron, Mixtral/Mistral-family, DeepSeek, Gemma MoE, and others.

This is better than hand-writing a one-off converter unless the model is unsupported.

## Two Workflows

### 1. Architecture-Only Test

Use this first. It reads HF config/model architecture and initializes Megatron weights randomly:

```python
from megatron.bridge import AutoBridge

bridge = AutoBridge.from_hf_pretrained("Qwen/Qwen3-30B-A3B", trust_remote_code=True)
provider = bridge.to_megatron_provider(load_weights=False)
provider.tensor_model_parallel_size = 2
provider.pipeline_model_parallel_size = 2
provider.context_parallel_size = 2
provider.expert_model_parallel_size = 4
provider.expert_tensor_parallel_size = 1
provider.finalize()
```

This avoids downloading the full checkpoint and is the best first test for 5D plumbing.

### 2. Pretrained Checkpoint Conversion

Use this after architecture-only training works. It downloads/loads HF weights and writes a Megatron checkpoint. This needs much more disk, RAM/CPU memory, and time.

Bridge examples to study:

- `third_party/Megatron-Bridge/examples/conversion/convert_checkpoints.py`
- `third_party/Megatron-Bridge/examples/conversion/convert_checkpoints_multi_gpu.py`
- `third_party/Megatron-Bridge/examples/conversion/hf_megatron_roundtrip.py`
- `third_party/Megatron-Bridge/examples/conversion/hf_megatron_roundtrip_multi_gpu.py`

## EP / ETP / DP / CP Mental Model

Dense layers:

```text
world_size = TP * PP * CP * DP
```

Expert layers:

```text
world_size = ETP * EP * EDP * PP
```

`EP` chooses how many ranks split the expert set. `num_experts` must be divisible by `EP`.

`ETP` chooses whether each individual expert's matrices are tensor-sharded. If `ETP=1`, each local expert is stored fully on one rank.

`CP` does not make another independent copy of expert weights. CP splits sequence/context for dense attention, while expert routing has its own expert-parallel/data-parallel mapping.

For 16 GPUs with `TP=2, PP=2, CP=2, DP=2`:

```text
dense world = 2 * 2 * 2 * 2 = 16
```

If `ETP=1, EP=4, EDP=2, PP=2`:

```text
expert world = 1 * 4 * 2 * 2 = 16
```

If a model has 128 experts and `EP=4`, each EP rank owns:

```text
128 / 4 = 32 local full experts
```

With `ETP=1`, each of those 32 experts is local/full, not tensor-sharded.

## Practical Recommendation

Do not download a full 30B MoE checkpoint while the GPUs are occupied unless explicitly needed. First run architecture-only with `load_weights=False`, then convert/download weights later when disks/GPUs are free.

For our RTX Blackwell setup, keep using:

- `--moe-token-dispatcher-type allgather` unless all-to-all is verified fixed.
- NCCL `2.30.7+`.
- `NCCL_SOCKET_IFNAME=enp193s0f0np0`
- `GLOO_SOCKET_IFNAME=enp193s0f0np0`
