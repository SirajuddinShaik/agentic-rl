# Operations and Monitoring

## Service health

```bash
./scripts/servers/check_stack.sh
curl -s http://127.0.0.1:8081/health
curl -s http://127.0.0.1:8101/health
curl -s http://127.0.0.1:18114/health
curl -s http://127.0.0.1:30100/health
```

## Ray job status

```bash
ray job status <job-id> --address http://192.168.111.7:8265
```

For the current v34 lane and exact launch settings, see
[CURRENT_RUNBOOK.md](CURRENT_RUNBOOK.md).

## GPU utilization

```bash
nvidia-smi --query-gpu=index,utilization.gpu,memory.used --format=csv
```

## Training progress

Inspect the trainer log for:

- `micro-batch trained`
- `Timer actor_train start/end`
- `step N`
- `Saving LoRA checkpoint`
- `rollout/rewards`
- `train/loss`

Example:

```bash
grep -E "micro-batch trained|Timer actor_train|step [0-9]+:|Saving LoRA checkpoint"   /root/miles/tmp/<run>_submit.log | tail -n 50
```

## Dumps and checkpoints

Typical paths:

```text
/root/miles/tmp/xyne_qa_tp2cp4ep8/<run-id>/trajectory_dumps
/root/miles/tmp/ckpt/xyne_qa_tp2cp4ep8/<run-id>/iter_XXXXXXXX
```

Each rollout group is stored as:

```text
rollout_000001_group_000.jsonl.gz
```

## Dashboard

The read-only dashboard is usually served on port `8400`. It reads only
trajectory dumps and never mutates training state.

Set `DASH_DUMP_ROOT` to the active run's `trajectory_dumps` directory before
starting it.

## Common checks

- Multi-turn behavior: count tool calls and tool results per session.
- Citations: inspect `raw_flow.citations` and citation scorer outputs.
- Rewards: inspect `reward.score`,
  `polar_metadata.trajectory_metadata.evaluation.per_scorer`,
  `polar_metadata.trajectory_metadata.evaluation.group_reward`,
  `polar_metadata.trajectory_metadata.evaluation.outcome_reward`, and
  `judge_io`.
- Judge truncation: verify `judge_io.*.input.body.max_tokens == 16384`.
- Session attribution: search Xyne logs for `409 no Polar session matched`.
- Trainer stalls: compare GPU utilization with `actor_train` timer state.

## Restart policy

- Do not restart the trainer during an active optimizer step unless it is hung.
- Restart from the latest completed checkpoint.
- Restart Polar only after confirming no active sessions depend on it.
- Restart Xyne only between rollout batches; conversation state is in memory.
- Always preserve the current dump directory before relaunching.
