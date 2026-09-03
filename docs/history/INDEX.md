# Remote RTX Knowledge Index

Copied back from the experimental RTX nodes on 2026-06-29.

This folder intentionally keeps only lightweight knowledge artifacts: README files, setup guides, scripts, small configs, metrics JSON, and patch files. It intentionally excludes checkpoints, datasets, Python virtualenvs, wheels, build products, logs, and full cloned repositories.

## What Was Copied

| Local path | Source | Contents |
| --- | --- | --- |
| `rtx1/root/` | `rtx1:/data/siraj/` | Top-level Blackwell issue and flag notes |
| `rtx1/scripts/` | `rtx1:/data/siraj/scripts/` | Training scripts, multinode tests, SFT scripts, reports, metrics |
| `rtx1/reinforce/` | `rtx1:/data/siraj/reinforce/` | Reinforce/RL notes, helper scripts, topology config |
| `rtx1/patches/` | `rtx1:/data/siraj/Megatron-LM` | Local Megatron-LM status and patch |
| `rtx2/scripts/` | `rtx2:/data3/siraj/scripts/` | Node-2 training scripts and multinode tests |
| `rtx2/reinforce/` | `rtx2:/data3/siraj/reinforce/` | Reinforce/RL notes and helper scripts |
| `rtx2/patches/` | `rtx2:/data3/siraj/Megatron-LM-patched` | Local patched Megatron-LM status and patch |
| `rtx2/te_build/` | `rtx2:/data3/siraj/te_build` | Transformer Engine README only |

See `MANIFEST.txt` for the exact copied file list.

## Most Important Files

- `rtx1/scripts/BLACKWELL_TRAINING_BOOK.md`: best end-to-end record of what worked, what failed, patches, and final working configs.
- `rtx1/scripts/COMPLETE_SETUP_GUIDE.md`: issue-by-issue setup guide for Blackwell SM120 Megatron/MoE training.
- `rtx1/scripts/MULTINODE_TRAINING_GUIDE.md`: 2-node launch procedure and network/NCCL/Gloo requirements.
- `rtx1/root/BLACKWELL_ISSUES_AND_FIXES.md`: earlier issue log with fixes and symptoms.
- `rtx1/scripts/multinode_tests/`: reusable NCCL and 5D parallelism test launchers.
- `micro5d_runs/`: successful tiny 16-GPU 5D smoke test logs and notes.
- `MEGATRON_BRIDGE_PLAN.md`: notes for using NVIDIA-NeMo/Megatron-Bridge for HF MoE architecture/checkpoint conversion.
- `rtx1/patches/Megatron-LM.local.patch`: local Megatron source changes from node 1.
- `rtx2/patches/Megatron-LM-patched.local.patch`: local Megatron source changes from node 2 patched tree.
- `rtx1/reinforce/docs/MUON_LEARNINGS.md`: distilled RL/Muon experiment lessons.

## Operational Lessons

- Treat both RTX nodes as experimental scratch nodes. Important durable material should be copied back here as docs, scripts, patches, or compact notes.
- The private internode IPs are `192.168.111.7` for RTX1 and `192.168.111.8` for RTX2. Test these only from inside the RTX nodes.
- For multinode runs, set both `NCCL_SOCKET_IFNAME` and `GLOO_SOCKET_IFNAME` to the physical internode interface. The copied guide says this cluster used `enp193s0f0np0`.
- Launch rank 1/node 2 first, then rank 0/node 1.
- Use the node-local Python envs:
  - RTX1: `/data/siraj/srlab/bin/python`
  - RTX2: `/data3/siraj/srlab/bin/python`
- Keep scripts in sync across nodes before multinode launches.

## Blackwell SM120 Training Lessons

- Upgrade NCCL to `nvidia-nccl-cu12==2.30.7` on Blackwell nodes. NCCL 2.26.2 caused multi-communicator crashes.
- Prefer `--moe-token-dispatcher-type allgather`; `alltoall`/`all_to_all_single` was broken on SM120 in these experiments.
- FP32 with `--transformer-impl local` was the most reliable path.
- BF16 local/cublas paths crashed in several configs; BF16 worked through Transformer Engine plus FlashAttention.
- FP8 can work with the `delayed` recipe. MXFP8 was blocked on RTX PRO 6000 SM120.
- Pipeline parallelism required patching `batch_p2p_comm = False` in Megatron runtime paths.
- Avoid regular distributed checkpoint saves on broken configs. Some later notes say NCCL 2.30.7 plus `fsdp_dtensor` made save/resume workable for Megatron-FSDP, but older guides still recommend high `--save-interval` to avoid checkpoint crashes.
- If using TP with EP, set `--expert-tensor-parallel-size 1` to decouple expert TP from dense TP.
- For long sequence or context parallel configs, use TE + BF16 + FlashAttention with CP.

## Known Working Config Families

From `BLACKWELL_TRAINING_BOOK.md`, working scripts include:

- Single-node FP32 baselines: `run_1gpu.sh`, `run_2gpu_ep1.sh`, `run_4gpu_ep1.sh`.
- Single-node MoE/EP: `run_2gpu_ep2_allgather.sh`, `run_4gpu_ep2_allgather.sh`, `run_8gpu_ep2_dp4.sh`, `run_8gpu_ep8_dp1.sh`.
- Single-node combined parallelism: `run_8gpu_tp2_ep2_dp2.sh`, `run_8gpu_tp4_pp2_ep4.sh`, `run_8gpu_pp2_ep2_dp2.sh`, `run_8gpu_tp2_pp2_cp2_ep2.sh`.
- Multinode: `run_multinode_16gpu_ep8.sh`, `run_multinode_16gpu_5d.sh`.
- FP8: `run_8gpu_fp8.sh` with delayed scaling.

Additional local smoke result:

- `scripts/test_5d_micro_16gpu.sh` completed a 1-iteration 16-GPU multinode 5D run while vLLM was active on RTX2. See `micro5d_runs/README.md`.

## Reinforce/RL Notes

The copied `reinforce` folder is separate from Megatron pretraining. The most useful distilled note is `reinforce/docs/MUON_LEARNINGS.md`:

- Muon improved matched eval performance over cold base by the recorded margins.
- The notes attribute gains to more surgical edits, better tool-call reliability, faster localization, and LoRA-compatible optimizer behavior.
- The caveat is that the result was not yet statistically significant at alpha 0.05 and should be rerun with more samples for confirmation.

## Things Intentionally Not Copied

- `.env` files, to avoid secrets.
- `checkpoints/`, `datasets/`, `tmp/`, `srlab/`, `te_build/build/`, `.git/`, `.codegraph/`, `.omo/`.
- Large logs and process pid files.
- Full Megatron source trees. Local modifications were preserved as patch files instead.
