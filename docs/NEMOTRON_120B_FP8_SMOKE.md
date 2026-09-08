# Nemotron-3-Super-120B FP8 LoRA smoke

This is a bounded one-rollout GRPO smoke for a disaggregated 12-GPU lane. It
proves model load, remote SGLang rollout, FP8 Transformer Engine training,
rank-64 LoRA update, and one optimizer step without saving a checkpoint.

## Launch

Run inside the Miles container on the H200 Ray head:

```bash
bash /opt/agentic-rl/runs/smoke/run_nemotron_120b_fp8_lora_smoke_h200.sh
```

The defaults expect:

- Miles root: `/root/miles`
- Base checkpoint: `/data/aicloud/hf_models/NVIDIA-Nemotron-3-Super-120B-A12B-FP8`
- Ray dashboard: `http://127.0.0.1:8265`
- Eight free H200 training GPUs on Neysa03
- Four free RTX2 inference GPUs (4-7) joined to the same Ray cluster
- The same canonical model path must resolve on both Ray nodes

The smoke uses LoRA rank 64 / alpha 128. PP=1 avoids the pipeline-parallel
full-adapter assembly path; no separate adapter conversion or materialization
step is needed. The FP8 Hugging Face checkpoint is loaded by the Megatron bridge
for training and directly by SGLang for inference.

Do not set `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` for this lane:
SGLang's TorchMemorySaver rejects it before model load.

## Topology

| Group | Setting | Result |
|---|---:|---|
| Actor GPUs | 8 | One H200 node |
| Dense parallelism | TP=4, PP=1, CP=2 | `4 × 1 × 2 = 8` |
| Expert parallelism | ETP=1, EP=8, PP=1 | `1 × 8 × 1 = 8` |
| Rollout engine | SGLang TP=4 | RTX2 GPUs 4-7 |

The first 8-GPU attempt used EP=8 with PP=2. Megatron computed an expert
TP/EP/PP group of `1 × 8 × 2 = 16`, which cannot divide an 8-rank world. The
current layout keeps both dense and expert groups at eight ranks while using
PP=1. This also avoids `_pp_assemble_full_adapter`, whose full-adapter materialization
caused the rank-128 OOM and exposed the post-load CUDA-IPC cleanup crash in the
PP=2 lane.

## Precision contract

| Tensor or operation | Precision | Reason |
|---|---|---|
| HF checkpoint | ModelOpt FP8 | 26-shard official `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8` snapshot |
| Megatron parameters | BF16 | Bridge-loaded trainable parameters |
| Forward/backward GEMMs | FP8 E4M3, blockwise | H200 Transformer Engine path |
| FP8 scales | FP32 | `NVTE_FP8_BLOCK_SCALING_FP32_SCALES=1` |
| Local gradients | BF16 | Produced by BF16/FP8 TE modules |
| Main gradient accumulation/all-reduce | FP32 | Required for BF16 parameters; avoids losing small accumulated updates |
| Adam master weights | FP16 | Precision-aware CPU-offloaded optimizer |
| Adam first moment | FP16 | Precision-aware CPU-offloaded optimizer |
| Adam second moment | FP16 | Precision-aware CPU-offloaded optimizer |
| Router logits/softmax | FP32 | `--moe-router-dtype fp32` and `--attention-softmax-in-fp32` |

The main gradient buffer intentionally remains FP32. Reducing that accumulator
to BF16 with `--grad-reduce-in-bf16` is a separate memory/throughput experiment;
it is not part of this correctness smoke.

## Known failure modes already covered

1. `--optimizer-cpu-offload` without `--use-precision-aware-optimizer` is
   rejected by Megatron. The smoke passes both flags.
2. `--main-grads-dtype bf16` with
   `--accumulate-allreduce-grads-in-fp32` is rejected. The smoke uses FP32 main
   gradients.
3. SGLang CUDA graph capture hit a routed-expert shape bug on this hybrid
   model. The smoke passes `--sglang-disable-cuda-graph`; this costs performance
   but isolates the training path.

## Success criteria

- Ray job reaches `SUCCEEDED`.
- SGLang returns two smoke completions.
- Megatron logs a finite gradient norm and completes one actor update.
- No NaN/Inf is reported in loss or gradients.
- All eight H200 and four RTX2 GPUs are released after the job exits.
