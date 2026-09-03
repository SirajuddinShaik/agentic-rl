# Training Setup Audit

## Current End-to-End Flow

1. A 12-GPU Ray cluster exposes RTX1 GPUs 0-7 and RTX2 GPUs 4-7.
2. Miles schedules one Megatron actor on all eight RTX1 GPUs.
3. The actor uses TP2, CP4, EP8, PP1 and rank-64 LoRA over attention and expert
   MLP projections. Full recomputation limits activation memory. The default
   16,384-token per-rank budget caps each CP4 trace at 65,536 tokens.
4. Two TP2 SGLang engines occupy the four advertised RTX2 GPUs.
   Each engine is explicitly capped at 128 running requests. The Polar gateway
   currently caps the whole node at 128 live run workers, so the practical
   distribution is roughly 64 sessions per engine plus queued work.
5. Miles requests 32 prompts with eight GRPO samples each, producing 256
   trajectories for a global batch of 256.
6. Polar creates isolated XYNE sessions, drives agent turns, and returns masked
   trajectories plus rollout-policy log probabilities.
7. XYNE retrieval uses Vespa, Postgres state, rerankers, and native tool calls.
   The dump route preserves messages, tool calls/results, citations, IDs,
   sub-runs, token usage, and final answers.
8. The Polar reward adapter scores and flattens session traces. Miles computes
   GRPO advantages and Megatron performs the optimizer step.
9. Miles broadcasts the updated LoRA weights to SGLang before the next rollout.
10. Checkpoints and W&B metrics are written from the trainer.

The current run intentionally has no separate reference model or KL penalty.
`--use-rollout-logprobs` supplies the behavior-policy denominator for PPO/GRPO.
Miles performs one optimizer step per collected batch here because
`rollout_batch_size * group_size == global_batch_size` and
`num_steps_per_rollout=1`. Megatron's printed `grpo_iterations=2` default belongs
to its native RL collector and is not used by the Miles actor loop.

## Required External Artifacts

The repository does not store large or private runtime artifacts:

| Artifact | Current expected location |
| --- | --- |
| Miles runtime checkout | `/root/miles` inside the training container |
| Megatron-LM | `/root/Megatron-LM` inside the training container |
| Nemotron 30B checkpoint | `/data/siraj/hf_models/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16` |
| Training JSONL | `/data/siraj/xyne_s/xyne_qa_train.jsonl` |
| XYNE checkout | `/data/siraj/xyne_s/xyne-search` |
| Agent CLI bundle | `/data/siraj/ARL/miles/tmp/swegym_agent_cli/opt_node` |
| Polar runtime image | `polar-xyne-runtime:withwait` |
| Vespa/Postgres/reranker data | managed server volumes and services |
| Credentials | external env file; never committed |

The audited JSONL contains 2,858 valid rows, 2,858 unique `instance_id` values,
and non-empty `answer`, `doc_ids`, and `chunk_ids` metadata on every row. There
is currently no separate held-out file wired into the launcher.

The repository template requires `ACCESS_TOKEN_SECRET` and `JWT_SECRET` from
the external credential file. This intentionally replaces literal values that
still exist in the experimental RTX1 template; applying the repository overlay
without adding those variables now fails preflight instead of reusing them.

## Launch Order

```bash
# RTX1 host; first confirm that no Ray training job is active
ALLOW_RAY_RESTART=1 bash scripts/cluster/start_ray_head_rtx1.sh

# RTX2 host: advertises only GPUs 4-7 to this Ray cluster
ALLOW_RAY_RESTART=1 bash scripts/cluster/start_ray_worker_rtx2.sh

# RTX1, inside the Miles training container
bash scripts/setup_wandb_credentials.sh
bash scripts/preflight_training.sh
XYNE_RL_CREDENTIALS_FILE=/secure/polar_credentials.env \
  bash runs/launch_xyne_tp2cp4ep8_multinode.sh
```

Do not start a second Ray head from the training launcher. It would disconnect
the rollout worker and collapse the job to a single node.

`run_xyne_qa_megatron_peft64_tp2cp4ep8_multinode.sh` is the recommended run.
The TP4/PP2 variant is retained to document the unsupported LoRA weight-sync
failure, and the TP8 variant is retained to reproduce the activation OOM that
motivated CP4 plus full recomputation.

## What Is Complete

- Polar session lifecycle, concurrency, capture, reward extraction, and masking.
- Native XYNE retrieval tool schemas and dump fields needed for reward judging.
- Megatron actor LoRA, expert LoRA targets, activation recomputation, and SGLang
  LoRA weight synchronization.
- Multinode Ray topology and two TP2 rollout engines.
- Reward replay, flattened-batch validation, smoke scripts, checkpoint saving,
  and W&B plumbing.

## Remaining Production Gaps

1. **Fully locked build:** the observed revisions and package versions are in
   `RTX1_RUNTIME_MANIFEST.md`, but dirty editable checkouts must be replaced by
   committed forks and a reproducible image digest.
2. **Resume drill:** checkpoints are saved, but the active script starts with
   `--no-load-optim --no-load-rng`. Add and test a separate resume launcher
   before relying on recovery from a long run.
3. **Held-out evaluation:** the active launcher has no periodic eval dataset or
   harness-quality gate. Keep train and eval question IDs disjoint and run the
   same capture/reward stack without optimizer updates.
4. **Token-budget calibration:** overlong traces are now deterministically
   dropped at the Megatron admission boundary, but the 65,536-token default
   still needs percentile logging and tuning against observed OOM headroom.
5. **Fault recovery:** verify retries are idempotent and do not duplicate a
   session or reward after gateway, container, Ray actor, or SGLang failure.
6. **Capacity soak:** pass a sustained 50-100 session test with bounded queue
   depth, file descriptors, Postgres connections, and runtime-container count.
7. **Artifact retention:** define checkpoint retention, rollout-dump retention,
   W&B run naming, and the exact promoted checkpoint criteria.
8. **Secret injection:** generated Polar YAML is protected by `umask 077`, and
   W&B uses `~/.netrc` instead of Ray runtime metadata. Move the remaining
   external credential file to a managed secret store for production.

The first three gaps are blockers for a recoverable, measurable long training
run. The remaining items are scale and operational-hardening work.
