# XYNE + Polar Agentic RL Reward Signals

## Purpose

This handout documents the reward signals available from the Polar/Xyne harness, what the current Miles run actually uses, and a practical reward design for GRPO training of an agent that must retrieve evidence and answer correctly.

The working principle is:

> Task success and grounded correctness are primary. Tool, token, and latency efficiency are secondary shaping signals.

An agent must not receive a high reward merely because it is short, fast, or makes few tool calls.

## Source Dump Inspected

Example dump:

```text
/data/siraj/logs/xyne_grpo/rollouts/task_polar-xyne-qa-grpo-142-142/ses_sk-polar-aef8f615-9aff-4df0-bdec-a44ff5bb0f27.json
```

The dump contains five reconstructed traces for one prompt. Each trace has prompt IDs, response IDs, a loss mask, response log-probabilities, finish reason, reward, metadata, and sometimes tool schemas.

Important limitation in this sample:

```text
tool schemas: present in one trace
actual tool calls: empty
tool results: empty
citations: empty
nested runs: empty
debug events: empty
```

Therefore, tool-use and citation rewards cannot be trusted until the harness persists the actual calls, arguments, results, document IDs, chunk IDs, and citations into the trajectory.

## Signals From the Harness

| Signal | Present in dump | Current reward use | Priority | Possible use |
|---|---:|---:|---|---|
| User prompt and messages | Yes | Training input | Critical | Condition the policy and judge |
| Reference answer / label | Dataset-side | F1 similarity | Critical | Deterministic answer evaluation |
| Expected document IDs | Dataset-side | Configured but not independently verified | Critical for RAG | Citation and retrieval correctness |
| Final answer text | Yes | F1 input, non-empty check | Critical | Correctness, completeness, format |
| Conversation/run IDs | Yes | Attribution only | Mid | Replay and debugging |
| Model, run status, finish reason | Yes | Completion/diagnostics | Critical | Failure and truncation penalties |
| Error/status | Yes | Completion scorer | Critical | Error/timeout reward |
| Citations | Field exists; empty here | Not currently useful | Critical for RAG | Citation presence, accuracy, support |
| Tool schemas | Sometimes | Not scored | Optional | Check available action space |
| Actual tool calls and arguments | Empty here | Not reliable | Critical for agent RL | Tool selection and query-quality rewards |
| Tool results | Empty here | Not reliable | Critical for agent RL | Evidence, retrieval, and tool-success rewards |
| Document IDs/chunk IDs | Not present in this sample | Not scored | Critical for RAG | Exact grounding and retrieval recall |
| Sub-agent runs | Empty here | Not scored | Mid | Delegation success and integration |
| Debug events | Empty here | Not scored | Mid | Process-level diagnostics and reward |
| Prompt token IDs | Yes | Policy input | Critical | Forward pass |
| Response token IDs | Yes | Policy output | Critical | Token-level policy gradient |
| Loss mask | Yes | Training mask | Critical | Train only intended response tokens |
| Response log-probabilities | Yes | Rollout log-probs | Critical | GRPO importance ratio |
| Per-trace reward | Yes | GRPO reward | Critical | Group-relative advantages |
| Group/policy/rollout metadata | Yes | Grouping and staleness | Critical | Same-prompt comparison and on-policy checks |
| Token usage | Yes | Diagnostic | Mid | Completion and context cost |
| Timing/latency | Yes | Diagnostic only | Optional | Production cost and timeout shaping |

## Current Reward

The active evaluator uses six scorers:

```text
completion            weight 1.0
answer_format         weight 0.5
retrieval_quality     weight 0.5
embedding_similarity  weight 2.0   # currently token F1, despite the name
tool_call_efficiency  weight 1.0
token_efficiency      weight 1.0
```

The pipeline computes a weighted average:

```text
R = sum(weight_i * score_i) / sum(weight_i)
```

In the inspected trajectory:

```text
completion            = 1.0
answer_format         = 1.0
retrieval_quality     = 0.5
embedding_similarity  = 0.0
tool_call_efficiency  = 1.0
token_efficiency      = 1.0
final reward          = 0.625
```

This is a bad learning shape for answer quality: a planning-only or incorrect response can still receive about `0.625` because completion, format, and efficiency are rewarded independently of correctness.

## Embedding-Based Signals

Embeddings are useful for semantic similarity and retrieval diagnostics, but similarity is not proof of factual correctness. Use them as auxiliary signals and keep exact checks or a judge as the authority.

### 1. Answer-to-reference similarity

Embed the generated answer `a` and reference answer `y`:

```text
s_answer = cosine(Embed(a), Embed(y))
d_answer = 1 - s_answer
```

Map to `[0, 1]` with a calibrated transformation, not an arbitrary raw threshold:

```text
R_answer_embed = clamp((s_answer - tau_bad) / (tau_good - tau_bad), 0, 1)
```

Recommended use:

- Keep exact/F1 or structured answer checks as the primary score where possible.
- Use embedding similarity for paraphrases and partial semantic overlap.
- Calibrate `tau_bad` and `tau_good` using correct, partially correct, and incorrect validation answers.
- Do not reward a long answer just because it shares many generic words.

### 2. Answer-to-evidence similarity

For retrieved chunks `c_1 ... c_n`, compute:

```text
s_evidence_max  = max_i cosine(Embed(answer), Embed(c_i))
s_evidence_mean = mean(top_k cosine(Embed(answer), Embed(c_i)))
```

Use this to ask whether the answer is semantically close to the evidence. It is useful for retrieval and grounding diagnostics, but it can be fooled by topical overlap. Pair it with an entailment or LLM groundedness check:

```text
R_grounded = entailment(answer, cited_chunks)
```

### 3. Query-to-chunk retrieval quality

For each tool query `q` and returned chunk `c`:

```text
s_query_chunk = cosine(Embed(q), Embed(c))
```

Possible use:

- Reward a query that retrieves relevant evidence.
- Penalize repeated queries with low marginal evidence.
- Measure recall by checking whether the expected document/chunk appears in the retrieved set.

Do not optimize query-chunk similarity alone. A generic query can have high similarity while missing the answer.

### 4. Citation-to-document/chunk similarity

For each cited item `z`, compare its text or metadata against:

- The reference answer
- The final answer claim it is attached to
- Retrieved chunks
- The expected document/chunk IDs

Useful values:

```text
R_citation_id       = exact expected ID match
R_citation_support  = entailment(claim, cited_chunk)
R_citation_embed    = cosine(Embed(claim), Embed(cited_chunk))
```

Exact ID and entailment should dominate embedding similarity.

### 5. Citation-to-folder similarity

Folder names are useful as a weak prior or scope check:

```text
s_folder = cosine(Embed(query or answer), Embed(folder_path + folder_description))
```

Use folder similarity to detect obviously unrelated retrieval. Never treat folder similarity as evidence that the answer is correct. A folder can contain many irrelevant documents.

### 6. Tool-result-to-answer coverage

Split the answer into claims `h_1 ... h_m`. For each claim, find the best supporting retrieved chunk:

```text
coverage = mean_j max_i entailment(h_j, c_i)
```

This is more meaningful than one whole-answer embedding distance because it catches answers that correctly mention one part but hallucinate another.

## Correctness and Grounding Signals

### Deterministic signals

Use whenever the task allows them:

- Exact answer match
- Numeric/date/entity match
- Structured JSON/schema validity
- Required fields present
- Expected document ID match
- Expected chunk ID match
- Citation count and citation format
- Tool argument schema validity
- Environment/test pass

### LLM judge

Use an independent judge for semantic cases where deterministic checks are insufficient. Pass the judge:

```text
user question
reference answer, if available
final answer
claims extracted from the answer
citations
retrieved chunks and document/chunk IDs
tool trace and tool results
```

Ask for separate scores:

```text
correctness:       0..1
completeness:      0..1
groundedness:      0..1
citation_accuracy: 0..1
format:            0..1
```

Require structured JSON and reject malformed judge outputs. The judge should not see hidden policy reasoning. Use a fixed judge model/version, cache results, sample a validation subset, and monitor judge agreement with deterministic labels.

LLM judging is a useful complement to verifiable rewards, but it is vulnerable to verbosity, phrasing, and judge-model bias. It should not be the only reward.

## Process and Tool Rewards

Once the harness records real tool events, add:

| Process signal | Reward idea |
|---|---|
| Correct tool selected | Positive reward for the tool appropriate to the subtask |
| Valid arguments | Positive; strong penalty for schema errors |
| Useful query | Query retrieves expected or supporting evidence |
| New evidence | Reward unique relevant chunks, not repeated results |
| Tool result used | Answer claims or next action references the result |
| Search recall | Expected document/chunk found anywhere in the trace |
| Search precision | Relevant result fraction among retrieved results |
| Duplicate calls | Small penalty for repeated equivalent calls |
| Failed calls | Penalty proportional to failure severity |
| Recovery | Small positive reward when the agent repairs a failed call and succeeds |
| Sub-agent success | Reward successful delegated subtask |
| Sub-agent integration | Reward correct use of delegated evidence |
| Early unsupported answer | Strong penalty when required retrieval was skipped |

For multi-step agents, outcome reward alone gives weak credit assignment. Process signals can help, but they must be gated by the final outcome so the policy does not learn to search forever or produce plausible-looking intermediate steps. Process reward models are commonly used to provide finer-grained supervision than outcome-only rewards. See the [process reward survey](https://arxiv.org/abs/2510.08049).

## Efficiency Rewards

Efficiency is useful, but secondary:

```text
tool_efficiency       = calls within task-specific budget
output_efficiency     = useful answer content / completion tokens
context_efficiency    = useful evidence / retrieved-context tokens
latency_efficiency    = target_latency / observed_latency, clipped
cost_efficiency       = useful result / estimated cost
```

Do not penalize fixed system prompt tokens. Penalize avoidable output, repeated retrieval, irrelevant context, and unnecessary tool calls.

Recommended rule:

```text
quality = correctness * groundedness * citation_accuracy
final_reward = quality * (0.85 + 0.15 * efficiency)
```

This makes efficiency improve a correct answer but prevents a short incorrect answer from winning.

## Recommended Reward Design

### Primary quality score

```text
Q = 0.35 * correctness
  + 0.20 * groundedness
  + 0.15 * citation_accuracy
  + 0.15 * task_success
  + 0.10 * completeness
  + 0.05 * format
```

Use deterministic checks first, then the calibrated LLM judge only where needed.

### Secondary process score

```text
P = 0.30 * retrieval_recall
  + 0.20 * tool_selection
  + 0.20 * tool_result_use
  + 0.15 * query_quality
  + 0.10 * subagent_success
  + 0.05 * recovery_quality
```

Only apply `P` when the trace is captured completely. Missing telemetry should produce `unknown`, not a full reward.

### Efficiency score

```text
E = 0.40 * tool_efficiency
  + 0.30 * output_token_efficiency
  + 0.20 * latency_efficiency
  + 0.10 * cost_efficiency
```

### Final scalar

```text
R = Q * (0.85 + 0.10 * P + 0.05 * E)
```

This keeps the reward in a stable range and makes correctness dominant.

## What Must Be Fixed Before RL

### Critical telemetry contract

Persist one normalized event record for every agent action:

```json
{
  "step": 3,
  "assistant_message_id": "...",
  "tool_name": "vespaSearch",
  "arguments": {"query": "..."},
  "result_status": "success",
  "result": "bounded tool result",
  "document_ids": ["..."],
  "chunk_ids": ["..."],
  "citation_ids": ["..."],
  "latency_ms": 123,
  "input_tokens": 100,
  "output_tokens": 30
}
```

The final trajectory should expose:

- Complete ordered tool events
- Tool arguments and bounded results
- Document IDs and chunk IDs
- Citation-to-claim links
- Sub-agent boundaries and outcomes
- Per-step timestamps and token counts
- Final answer and finish reason
- Error/timeout information

### Prevent silent reward failure

Do not convert missing data to a positive default:

```text
missing tool trace       -> unknown, exclude or quality-gate
missing citations        -> 0 when citations are required
missing reference        -> judge/task verifier required
missing token telemetry  -> neutral efficiency, never bonus
malformed evaluator      -> explicit failure reward and diagnostic
```

## Evaluation Plan

Before restarting long RL:

1. Run 50-100 fixed prompts through the harness.
2. Save complete raw traces.
3. Manually label correctness, grounding, citations, and tool usefulness.
4. Compare deterministic scores, embeddings, and LLM judge scores.
5. Tune thresholds on a validation split only.
6. Freeze the reward implementation and run a reward-ablation test.
7. Track held-out task success, answer correctness, citation accuracy, and reward separately.

Minimum ablations:

```text
correctness only
correctness + grounding
correctness + grounding + citations
full quality + process shaping
full quality + efficiency shaping
```

## Success Criteria

The next reward implementation is ready for a real run when:

- Tool calls and results are present in every completed trace.
- Expected document/chunk IDs can be checked automatically.
- The judge agrees with human labels on a held-out sample.
- Incorrect planning-only answers score near zero.
- Correct grounded answers score clearly above partial answers.
- Efficiency changes do not reduce task success.
- GRPO groups have nonzero reward variance on a useful fraction of prompts.
- Held-out task success improves, not just the training reward.

## References

- [DeepSeekMath: GRPO](https://arxiv.org/abs/2402.03300)
- [Hugging Face TRL GRPOTrainer](https://huggingface.co/docs/trl/grpo_trainer)
- [Hugging Face reward functions](https://huggingface.co/docs/trl/main/rewards)
- [WebArena functional task success](https://arxiv.org/abs/2307.13854)
- [Self-Rewarding Language Models / LLM-as-a-Judge](https://proceedings.mlr.press/v235/yuan24d.html)
- [Process Reward Models survey](https://arxiv.org/abs/2510.08049)

## Relevant Current Files

```text
/data/siraj/ARL/miles/miles/rollout/polar_reward.py
/data/siraj/ARL/miles/polar-pkg/polar/xyne/evaluator.py
/data/siraj/ARL/miles/polar-pkg/polar/xyne/reward_pipeline.py
/data/siraj/ARL/miles/polar-pkg/polar/xyne/scorers/
/data/siraj/ARL/miles/miles/examples/polar_swegym_grpo/polar_config_xyne_qa.yaml
```
