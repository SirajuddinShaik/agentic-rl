# Xyne GRPO Reward Architecture

## Reward Pipeline Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    PER-SESSION (×8 sessions)                 │
│                                                              │
│  XyneCompositeEvaluator.evaluate(trajectory)                 │
│  ├── completion              (w=1.0)  Produced an answer?    │
│  ├── answer_format           (w=0.5)  Properly formatted?    │
│  ├── citation_presence       (w=1.0)  Citations present?     │
│  ├── citation_relevance      (w=0.75) Mean Vespa relevance   │
│  ├── citation_accuracy       (w=1.5)  Match gold docs?       │
│  ├── llm_judge               (w=1.5)  LLM-scored quality     │
│  ├── retrieval_quality       (w=1.0)  Retrieval execution    │
│  ├── gold_evidence_coverage  (w=1.0)  Gold chunks found      │
│  ├── citation_evidence_coverage (w=1.0) Citations vs evidence│
│  ├── tool_evidence_utility   (w=1.0)  Marginal gold per call │
│  ├── subagent_success        (w=0.5)  Sub-agents error-free? │
│  ├── embedding_similarity    (w=2.0)  F1 vs reference answer │
│  ├── tool_call_efficiency    (w=1.0)  Calls within budget 8? │
│  └── token_efficiency        (w=1.0)  Tokens within 8192?    │
│                                                              │
│  → weighted average = outcome_reward                         │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              GROUP LEVEL — POLAR SERVER                       │
│              apply_group_reward() @ manager.py:245            │
│                                                              │
│  A. mutual_information_evidence  (w=0.15)  APPLIED           │
│     MI_i = group_gold_coverage − coverage_without_session_i  │
│     Credits sessions that found UNIQUE gold evidence         │
│                                                              │
│  B. quality_conditioned_token_efficiency  (w=0.0)  DISABLED  │
│     Pareto: same quality + fewer tokens = bonus             │
│                                                              │
│  → shaped_reward = outcome_reward + MI_bonus                │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              GROUP LEVEL — TRAINER                            │
│              post_process_rewards() @ polar_reward.py         │
│                                                              │
│  C. Diversity bonus           (β=0.1)              APPLIED   │
│     bonus = β × group_diversity × unique_chunk_fraction     │
│     Rewards sessions that explored unique chunks             │
│                                                              │
│  D. Tool-aware retrieval ranking (β=0.1)          APPLIED    │
│     ┌────────────────────────────────────────────────┐       │
│     │ D1. Exploration distance     (30%)              │       │
│     │     vespaSearch calls before first gold doc     │       │
│     │     reward = (1 − dist) × 0.3                   │       │
│     ├────────────────────────────────────────────────┤       │
│     │ D2. Drill-down distance      (20%)              │       │
│     │     searchWithinDoc/getChunks before gold chunk │       │
│     │     reward = (1 − dist) × 0.2                   │       │
│     ├────────────────────────────────────────────────┤       │
│     │ D3. NDCG share               (20%)              │       │
│     │     session_DCG / group_DCG                    │       │
│     │     Vespa score ranking of gold chunks          │       │
│     ├────────────────────────────────────────────────┤       │
│     │ D4. Gold coverage            (20%)              │       │
│     │     gold_chunks_found / total_gold_chunks       │       │
│     ├────────────────────────────────────────────────┤       │
│     │ D5. Query diversity          (10%)              │       │
│     │     unique_queries / total_queries              │       │
│     │     penalizes repeating same search             │       │
│     └────────────────────────────────────────────────┘       │
│                                                              │
│  → adjusted_reward = shaped_reward + diversity + retrieval   │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              GRPO ADVANTAGE NORMALIZATION                     │
│                                                              │
│  E. Leave-one-out baseline                                   │
│                                                              │
│     advantage_i = (adjusted_reward_i − mean(others)) / std   │
│                                                              │
│  → policy gradient                                           │
└─────────────────────────────────────────────────────────────┘
```

## Per-Session Scorers (14 total)

| # | Scorer | File | Weight | What it measures |
|---|--------|------|--------|------------------|
| 1 | completion | completion.py | 1.0 | Session produced a non-empty answer |
| 2 | answer_format | answer_format.py | 0.5 | Answer has expected format (citations, structure) |
| 3 | citation_presence | citation_presence.py | 1.0 | At least one citation in the answer |
| 4 | citation_relevance | citation_relevance.py | 0.75 | Mean Vespa relevance score of cited chunks |
| 5 | citation_accuracy | citation_accuracy.py | 1.5 | Cited docs match expected gold documents |
| 6 | llm_judge | llm_judge.py | 1.5 | LLM judge scores answer on 4 dimensions (quality, correctness, groundedness, citation_accuracy) |
| 7 | retrieval_quality | retrieval_quality.py | 1.0 | Retrieval tool success (40%) + best evidence relevance (30%) + citation-evidence coverage (30%) |
| 8 | gold_evidence_coverage | gold_evidence_coverage.py | 1.0 | Exact chunk recall + semantic recall against gold evidence |
| 9 | citation_evidence_coverage | citation_evidence_coverage.py | 1.0 | Cited chunks cover expected evidence |
| 10 | tool_evidence_utility | tool_evidence_utility.py | 1.0 | Each tool call added marginal gold evidence (cumulative coverage delta) |
| 11 | subagent_success | subagent_success.py | 0.5 | All sub-agents ran without errors |
| 12 | embedding_similarity | embedding_similarity.py | 2.0 | F1 embedding similarity between answer and reference |
| 13 | tool_call_efficiency | tool_call_efficiency.py | 1.0 | Number of tool calls within budget (8) |
| 14 | token_efficiency | token_efficiency.py | 1.0 | Token usage within budget (8192) |

**Total weight: 16.25** → `outcome_reward = Σ(scorer_score × weight) / 16.25`

## Group-Relative Rewards (polar server side)

| # | Reward | File | Weight | Status | Formula |
|---|--------|------|--------|--------|---------|
| A | mutual_information_evidence | group_reward.py | 0.15 | APPLIED | `shaped = base + 0.15 × (group_coverage − coverage_without_i)` |
| B | quality_conditioned_token_efficiency | group_reward.py | 0.0 | DISABLED | `shaped = quality + w × (1 − quality) × pareto_efficiency` |

**Where:** `group_coverage` = fraction of gold chunks found by all 8 sessions collectively. `coverage_without_i` = same fraction excluding session i's chunks. Sessions finding unique gold get high MI; sessions finding only redundant chunks get MI ≈ 0.

## Group-Relative Rewards (trainer side)

| # | Reward | File | Weight | Status | Formula |
|---|--------|------|--------|--------|---------|
| C | Diversity bonus | polar_reward.py | 0.1 | APPLIED | `bonus = 0.1 × (|union_chunks| / Σ|chunks|) × (|unique_i| / |union|)` |
| D | Tool-aware retrieval ranking | polar_reward.py | 0.1 | APPLIED | See breakdown below |
| E | shape_trajectory_means (Pareto) | group_relative_efficiency.py | 0.0 | DISABLED | `shaped = quality + w × (1 − quality) × pareto_wins` |

### Tool-Aware Retrieval Ranking (D) — Breakdown

| Sub | Component | Weight | Tool | Formula |
|-----|-----------|--------|------|---------|
| D1 | Exploration distance | 30% | vespaSearch | `reward = (1 − calls_to_first_gold_doc / total_vespa_calls) × 0.3` |
| D2 | Drill-down distance | 20% | searchWithinDoc, getChunks, getDocument | `reward = (1 − calls_to_first_gold_chunk / total_drill_calls) × 0.2` |
| D3 | NDCG share | 20% | All tools | `reward = (session_DCG / group_DCG) × 0.2` |
| D4 | Gold coverage | 20% | All tools | `reward = (gold_chunks_found / total_gold) × 0.2` |
| D5 | Query diversity | 10% | vespaSearch, searchWithinDoc | `reward = (unique_queries / total_queries) × 0.1` |

**Retrieval pipeline model:**

```
vespaSearch (explore)  →  discovers gold documents
        ↓
searchWithinDoc (drill)  →  finds specific gold chunks within known docs
        ↓
getChunks (fetch)  →  retrieves exact chunk by ID
```

D1 rewards fast exploration — finding the right document quickly.
D2 rewards efficient drill-down — finding the right chunk within the document quickly.
D3 rewards high-quality retrieval — gold chunks ranked high by Vespa relevance.
D4 rewards thoroughness — finding more of the gold evidence.
D5 penalizes redundancy — repeating the same query wastes calls.

## GRPO Advantage

| # | Reward | File | Status | Formula |
|---|--------|------|--------|---------|
| F | Leave-one-out normalization | polar_reward.py | ACTIVE | `advantage_i = (adjusted_reward_i − mean(other_adjusted)) / std(others)` |

**Final advantage** = how much better or worse this session did compared to its peers, normalized by group variance. Sessions that found unique gold evidence and drilled down efficiently get positive advantage; sessions that looped on the same query or never found gold get negative advantage.

## Data Flow Summary

| Stage | Where | Input | Output |
|-------|-------|-------|--------|
| Session execution | Polar harness + xyne-server | Prompt + tools | `XyneRawFlow` (answer, citations, tool_calls, retrieved_chunks) |
| Per-session scoring | XyneCompositeEvaluator | `XyneRawFlow` + gold evidence | `outcome_reward` (0.0–1.0) + 14 sub-scores |
| Group MI shaping | apply_group_reward @ manager.py | 8 × `SessionResult` | `shaped_reward` per session |
| Trainer bonuses | post_process_rewards @ polar_reward.py | 8 × `Sample` with metadata | `adjusted_reward` per session |
| GRPO advantage | post_process_rewards @ polar_reward.py | 8 × `adjusted_reward` | `advantage` per session |
| Policy gradient | Megatron trainer | `advantage` × tokens | Weight update (LoRA) |
