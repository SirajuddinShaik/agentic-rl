# Using the Xyne Harness Through Polar

Last verified: 2026-08-12 on RTX1

This is the operational handout for running the Xyne agentic harness through Polar and, later, connecting the same rollout path to Slime/Megatron GRPO.

## 1. Architecture

```text
Slime/Megatron trainer
        |
        | async rollout task
        v
Polar rollout server :8080
        |
        v
Polar gateway :8100  --->  SGLang/vLLM inference server
        |
        | starts one isolated runtime for the task
        v
XyneHarness
        |
        | HTTP calls to Xyne backend
        v
Xyne backend ---> Vespa + retrieval tools
        |
        | backend LLM calls go back through the Polar gateway
        v
Trajectory: answer, tool calls, chunks, citations, token/logprob metadata
        |
        v
Polar evaluator ---> scalar reward ---> Slime/Megatron GRPO update
```

Polar is the rollout and trajectory service. The Xyne backend remains the agent implementation and Vespa remains the retrieval system.

## 2. Important Distinction

### Standalone smoke test

```text
/data/siraj/test_without_polar.sh
```

This tests Xyne backend + Vespa + model API + raw-flow capture. It deliberately does **not** use Polar, so it has no GRPO session attribution and does not produce a Polar training trajectory.

Example:

```bash
export JUSPAY_API_KEY='your-grid-key'
bash /data/siraj/test_without_polar.sh 3 glm-latest
```

### Polar harness run

The Polar path uses:

```text
/data/siraj/ARL/ProRL-Agent-Server/src/polar/xyne/harness.py
/data/siraj/ARL/ProRL-Agent-Server/src/polar/xyne/xyne_fetch_flow.py
/data/siraj/ARL/ProRL-Agent-Server/src/polar/xyne/evaluator.py
```

`XyneHarness` boots or connects to the Xyne backend, sends the instruction, captures the complete `/dump` flow, and stores it in `result.metadata["xyne_raw"]`.

## 3. Polar Services

Use the Xyne-specific topology:

```text
/data/siraj/ARL/ProRL-Agent-Server/xyne/topology.sgl.yaml
```

The current topology defines:

```text
Polar rollout: 127.0.0.1:8080
Polar gateway: 127.0.0.1:8100
Inference engine: SGLang at 127.0.0.1:8000
```

Start the services from the ProRL-Agent-Server environment:

```bash
cd /data/siraj/ARL/ProRL-Agent-Server
source /data/siraj/ARL/.venv/bin/activate

polar serve_rollout -c xyne/topology.sgl.yaml \
  > /data/siraj/ARL/logs/xyne_polar_rollout.log 2>&1 &

polar serve_gateway -c xyne/topology.sgl.yaml \
  --node-id localhost-node-xyne \
  > /data/siraj/ARL/logs/xyne_polar_gateway.log 2>&1 &
```

Check service health:

```bash
curl -sS http://127.0.0.1:8080/health
polar status -c /data/siraj/ARL/ProRL-Agent-Server/xyne/topology.sgl.yaml
```

The topology is a wiring stub for one local SGLang engine. For actual training, point `inference.base_url` at the Slime-managed SGLang router/engine and use the training launch configuration described below.

## 4. Xyne Polar Task Configuration

The Xyne task configuration is represented by the Polar config files under:

```text
/data/siraj/ARL/ProRL-Agent-Server/examples/swegym_slime_grpo/
/data/siraj/ARL/logs/xyne_qa/polar_config_custom.yaml
```

The important fields are:

```yaml
agent:
  import_path: polar.xyne.harness:XyneHarness
  model_name: nemotron-30b-a3b

evaluator:
  strategy: polar.xyne.evaluator:XyneCompositeEvaluator
```

The runtime must have access to:

- Xyne backend source or a prepared Xyne runtime image
- Xyne database at the configured Postgres endpoint
- Vespa query/feed endpoints
- The model gateway endpoint
- An access token or the configured JWT-minting environment

Do not put API keys or JWTs into a committed config. Supply them through environment variables or the runtime secret mechanism.

## 5. What XyneHarness Does Per Task

For each instruction, the harness:

1. Creates the runtime workspace.
2. Writes the packaged `xyne_fetch_flow.py` helper.
3. Starts the Xyne backend unless `skip_boot` is enabled.
4. Waits for `/v2/health` with a bounded timeout.
5. Creates a Xyne conversation and sends the user instruction.
6. Waits for the run to complete.
7. Fetches the authoritative `/v2/chat/conversations/:id/dump` endpoint.
8. Extracts the final answer and full flow metadata.
9. Stores the flow for the evaluator.

The dump is the source of truth. It includes messages, runs, tool calls, tool results, citations, thinking, token usage, and nested sub-agent traces when they exist.

## 6. Retrieval Data Preserved

The captured Vespa flow preserves:

- `docId`
- `title` / `fileName`
- `chunkIndex`
- `chunkIndices`
- `relevantChunkIndices`
- Actual chunk text
- Page information
- Citation references such as `[docId#44]`
- `totalCount`, `nextOffset`, and `hasMore`

The current live Vespa deployment is session 42 and contains:

- `chunk_tf_prox_coverage`
- `default_native_dynamic_chunks_file_v6_rsf_vec`
- `document-summary lean`

See `XYNE_VESPA_TOOL_PROFILE_FIXES.md` for the deployment diagnosis.

## 7. Reward / Evaluation

The Xyne evaluator is:

```text
/data/siraj/ARL/ProRL-Agent-Server/src/polar/xyne/evaluator.py
```

The reward pipeline is a weighted average of enabled scorers:

```text
reward = sum(weight_i * score_i) / sum(weight_i)
```

Available Xyne scorers include:

- `completion`: run completed without an error
- `answer_format`: answer is non-empty and usable
- `citation_presence`: answer has citations
- `citation_relevance`: cited evidence is relevant
- `citation_accuracy`: citations match expected document IDs
- `retrieval_quality`: retrieval and nested-agent evidence quality
- `subagent_success`: nested sub-agent runs succeeded
- `tool_call_efficiency`: tool usage stays within budget
- `token_efficiency`: completion tokens stay within budget
- `llm_judge`: optional model-based answer grading

The evaluator returns the configured reward key, normally `score`, to the rollout bridge.

## 8. Polar to Slime/Megatron GRPO

The bridge entry point is:

```text
slime_bridge.rollout.generate_rollout_polar_async
```

The bridge performs:

1. Slime submits a rollout group.
2. The bridge submits asynchronous Polar tasks.
3. Polar runs isolated Xyne harness sessions.
4. Polar captures trajectories and computes rewards.
5. The bridge converts trajectories into Slime samples.
6. Failed or unusable traces are filtered.
7. GRPO group advantages are computed.
8. Megatron updates the actor.
9. The next rollout uses the updated policy version.

Relevant bridge files:

```text
/data/siraj/ARL/ProRL-Agent-Server/src/slime_bridge/config.py
/data/siraj/ARL/ProRL-Agent-Server/src/slime_bridge/rollout.py
/data/siraj/ARL/ProRL-Agent-Server/src/slime_bridge/adapter.py
/data/siraj/ARL/ProRL-Agent-Server/src/slime_bridge/reward.py
/data/siraj/ARL/ProRL-Agent-Server/src/slime_bridge/reward_post_process.py
```

The legacy RTX1 Xyne Q&A configuration is:

```text
/data/siraj/ARL/logs/xyne_qa/polar_config_custom.yaml
/data/siraj/ARL/logs/xyne_qa/launch.sh
```

Before using it for a real run, verify that its `polar_xyne_server_dir`, runtime image, model endpoint, token plumbing, and dataset paths match the current deployment. Some values are historical launch-template paths.

## 9. Data Format

Each training JSONL row should contain at least:

```json
{
  "prompt": "user question",
  "label": "reference answer",
  "metadata": {
    "instance_id": "case-001",
    "doc_ids": ["clf-example"],
    "chunk_ids": [44]
  }
}
```

For Xyne-specific evaluation, `metadata.doc_ids` supplies expected document identifiers and `label` supplies the reference answer. Keep document and chunk IDs from the corpus, not generated guesses.

## 10. Smoke-Test Checklist

Before training:

1. Verify Vespa health and profiles.
2. Verify the Xyne backend `/v2/health`.
3. Run the standalone test to validate the question and answer path.
4. Start Polar rollout and gateway services.
5. Submit one calculator or Xyne task through Polar.
6. Confirm the task reaches `completed`.
7. Confirm the result contains a non-empty answer and reward.
8. Confirm the trajectory contains model messages, tool calls, citations, and token/logprob metadata.
9. Only then launch Slime/Megatron.

Inspect logs:

```bash
tail -f /data/siraj/ARL/logs/xyne_polar_rollout.log
tail -f /data/siraj/ARL/logs/xyne_polar_gateway.log
find /data/siraj/xyne_s/flow_dumps -type f -name 'test_raw_*.json' | tail
```

## 11. Sub-Agents

The harness framework supports `dispatchSubagent` and `dispatchSubagentBatch`, but the live `sub_agents` table currently has zero rows. Therefore no sub-agent is dispatched in the current SEBI setup.

Sub-agents are optional. Add them for multi-document research, verification, or parallel specialist work. They are not required for a bounded single-document lookup.

## 12. Troubleshooting

### Empty answer or no final completion

Check the run status in the raw dump and confirm the helper waited for a terminal run before reading the final assistant text.

### Raw model protocol appears in the answer

The model may be emitting tool syntax as text instead of structured tool calls. Use a model/backend with native tool-call parsing and verify the gateway’s tool-call parser configuration.

### Tool calls are zero

Check all of:

- The SEBI agent’s DB tool list
- Native retrieval tools in the agent prompt
- Model structured-tool support
- Xyne backend tool execution configuration
- The raw `/dump`, not only the answer preview

### Missing Vespa profile or `lean` summary

Compare the backend tool constants with the active `kb_items.sd`, then deploy the matching package. Do not delete the Vespa data volume.

### No Polar attribution

The standalone `test_without_polar.sh` intentionally has no Polar session attribution. Use the Polar rollout server and gateway path for GRPO trajectories.

## 13. Reference Paths

```text
Polar repo:        /data/siraj/ARL/ProRL-Agent-Server
Xyne Polar code:   /data/siraj/ARL/ProRL-Agent-Server/src/polar/xyne
Slime bridge:      /data/siraj/ARL/ProRL-Agent-Server/src/slime_bridge
Xyne backend:      /data/siraj/xyne_s/xyne-search (read-only)
Vespa:             container siraj-vespa
Smoke test:        /data/siraj/test_without_polar.sh
Flow dumps:        /data/siraj/xyne_s/flow_dumps
```

