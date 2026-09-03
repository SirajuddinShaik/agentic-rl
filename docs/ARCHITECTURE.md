# Architecture

## System overview

```text
                 +---------------------------+
                 | Miles / Megatron trainer  |
                 +---------------------------+
                     | grouped rollout request
                     v
                 +---------------------------+
                 | Polar rollout server      |
                 | task/session orchestration|
                 +---------------------------+
                     | isolated agent sessions
                     v
                 +---------------------------+
                 | Xyne backend              |
                 | agent loop + tools        |
                 +---------------------------+
                     | retrieval / persistence
                     v
       +-----------------------+ +----------------+
       | Vespa retrieval index | | Postgres state |
       +-----------------------+ +----------------+
                     |
                     | full /dump flow
                     v
                 +---------------------------+
                 | Polar gateway + evaluator |
                 | reward + masked trajectory|
                 +---------------------------+
                     |
                     v
                 +---------------------------+
                 | Miles GRPO actor update   |
                 +---------------------------+
                     |
                     | LoRA weight broadcast
                     v
                 +---------------------------+
                 | SGLang inference engines  |
                 +---------------------------+
```

## Component responsibilities

### Xyne-search

- Owns the agent loop, retrieval tools, conversation state, and `/dump` API.
- Calls the model through the Polar gateway so every completion is attributable
  to a Polar session.
- Preserves tool calls, tool results, reasoning, citations, retrieved chunks,
  token usage, and the final answer.

### Polar

- Owns asynchronous task/session orchestration and trajectory capture.
- Provides the gateway that proxies model calls and annotates them with session
  and trace metadata.
- Runs the Xyne harness, fetches the authoritative raw flow, evaluates rewards,
  and returns masked training trajectories to Miles.
- Computes group-level reward signals such as mutual-information evidence.

### Miles

- Owns the GRPO training loop and Megatron actor update.
- Schedules grouped rollouts, consumes Polar trajectories, computes advantages,
  and updates LoRA weights.
- Synchronizes updated actor weights back to SGLang for the next rollout.
- Writes checkpoints, W&B metrics, and per-run trajectory dumps.

### SGLang

- Serves policy inference for Xyne agent turns.
- Receives updated LoRA weights from Miles.
- Must use the same model name, chat template, tool-call parser, and context
  limits as the training configuration.

## Service map

| Order | Service | Default endpoint | Notes |
| ---: | --- | --- | --- |
| 1 | Postgres | `127.0.0.1:15432` | Xyne state and agent/tool config |
| 2 | Vespa | query `:18081`, feed `:18080` | retrieval and chunk metadata |
| 3 | SGLang | router `:30100` or engine `:30300` | policy inference |
| 4 | Xyne backend | `:3001` or test lane `:3103` | agent loop and `/dump` |
| 5 | Polar rollout | `:8081` | task/session orchestration |
| 6 | Polar gateway | `:8101` | model proxy and attribution |
| 7 | Miles trainer | Ray job | GRPO actor update |

## Reward flow

1. Xyne returns a full raw flow.
2. Polar evaluates per-session gates and answer quality.
3. Polar and Miles compute group-level credit:
   - shared answer quality
   - mutual-information evidence
   - retrieval diversity
   - exploration and drill-down efficiency
   - gold coverage and NDCG
4. Miles computes GRPO advantages from the adjusted per-session rewards.
5. Megatron updates the LoRA actor and broadcasts weights to SGLang.

See [docs/history/REWARD_FINAL_STRUCTURE.md](history/REWARD_FINAL_STRUCTURE.md)
for the full reward equations.
