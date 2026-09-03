# Current Consolidated State

This note resolves the timeline across the handouts. Older documents are kept
because they explain failures, but their blocker status is not always current.

## Current Architecture

- Miles owns GRPO and the Megatron actor update.
- SGLang serves rollout inference and receives updated actor weights.
- Polar owns asynchronous task/session orchestration and trajectory capture.
- XYNE owns the agent loop, retrieval tools, and full conversation dump.
- Vespa provides retrieval evidence; Postgres stores agent/tool configuration.
- The XYNE evaluator produces deterministic, process, and optional judge
  signals; Miles consumes the scalar `score` and token-faithful trajectories.

## Resolved Items

- Native agentic tool execution is enabled for the SEBI agent.
- The six retrieval tools are present in the agent database row.
- Vespa session 42 provides the required `lean` summary and ranking profiles.
- `/dump` captures answers, calls, results, citations, runs, thinking, and
  token usage with owner-gated authentication.
- The shared session proxy uses deterministic session markers and serialized
  startup for concurrent rollouts.
- Gateway postprocessing metadata is merged before evaluation.
- `LocalRuntime` exists and maps `/polar/session` to a writable host session.
- The multidimensional judge uses discrete per-dimension scores and bounded
  concurrency with sufficient output tokens.

## Still Deployment-Dependent

- Subagent support exists, but the live database had no configured subagents.
- The TEI reranker was healthy but not wired into the retrieval tool path.
- Conversation state was in memory; restarting XYNE during a rollout loses it.
- High concurrency must be proven end to end, not inferred from accepted HTTP
  submissions or a large worker limit.
- Real training still depends on a compatible Miles/Megatron/SGLang image,
  model checkpoint, dataset, GPU allocation, and weight synchronization.

## Historical Notes

`XYNE_FLOW_CAPTURE_HANDOFF.md`, `XYNE_POLAR_REWARD_BLOCKER.md`, and
`xyne-training-context.md` contain snapshots from before later fixes. Use them
for root-cause history. For setup, prefer this note, `POLAR_XYNE_SETUP.md`, and
`configs/servers/README.md`.
