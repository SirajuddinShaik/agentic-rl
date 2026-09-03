# Final Reward Architecture — Three Levels Merged to Per-Session

## Three Reward Levels

```
Level 1: PER-SESSION (gate)          Level 2: GROUP (shared)              Level 3: GROUP (differentiated)
─────────────────────────            ──────────────────────               ──────────────────────────────
completion gate                      best answer quality                  retrieval contribution
Did THIS session produce output?     Scored on BEST session's answer      How much did THIS session
                                     Applied to ALL 8 sessions            contribute to group retrieval?
```

### Level 1 — Per-Session Gate

Runs on each session individually. Binary — did the session produce any output?

```
gate_i = 1.0   if session i produced an answer
gate_i = 0.0   if session i is empty/aborted
```

If `gate_i = 0`, the session gets `adjusted_reward = 0` and participates in GRPO with negative advantage. No other scoring needed.

### Level 2 — Group Shared (Answer Quality)

Runs once after all 8 sessions complete. The best session's answer is scored, and that score is shared by ALL sessions in the group. This is the "collective synthesis" reward — the group as a whole produced an answer of quality Q, and every session shares credit for it.

```
best = argmax(outcome_reward_i)    among the 8 sessions

group_answer_score = (
    w_llm      × llm_judge(best)
  + w_cit_acc  × citation_accuracy(best)
  + w_cit_rel  × citation_relevance(best)
  + w_tok_eff  × mean(token_efficiency_i for all i)
) / (w_llm + w_cit_acc + w_cit_rel + w_tok_eff)

Applied to ALL sessions:
  shared_answer_i = group_answer_score    for every i in group
```

Weights: `w_llm=1.5, w_cit_acc=1.0, w_cit_rel=0.5, w_tok_eff=0.5`

### Level 3 — Group Differentiated (Retrieval Contribution)

Runs after all 8 sessions complete. Each session gets an individual score based on how much it contributed to the group's collective retrieval. This is where sessions are differentiated — session A that found unique gold gets more than session B that found nothing new.

Seven sub-components, each measuring a different aspect of retrieval contribution:

#### 3a. Mutual Information Evidence (polar server)

```
gold_chunks = expected chunk IDs from training data
union_chunks = ⋃ (retrieved_chunks_i for all i in group)
full_coverage    = |union_chunks ∩ gold_chunks| / |gold_chunks|
coverage_without_i = |(union_chunks − chunks_i) ∩ gold_chunks| / |gold_chunks|

MI_i = full_coverage − coverage_without_i

mi_reward_i = α_mi × MI_i         where α_mi = 0.15
```

Session that found unique gold chunks → high MI. Session that found only redundant chunks → MI ≈ 0.

#### 3b. Diversity Bonus (trainer)

```
all_chunks = ⋃ (chunks_i for all i)
total_chunks = Σ |chunks_i|
group_diversity = |all_chunks| / total_chunks
unique_i = chunks_i − ⋃(chunks_j for j ≠ i)
unique_fraction_i = |unique_i| / |all_chunks|

diversity_reward_i = α_div × group_diversity × unique_fraction_i    where α_div = 0.10
```

Rewards sessions that explored unique chunks, even if they aren't gold.

#### 3c. Exploration Distance (trainer, tool-aware)

```
vespa_calls_i = [c for c in calls_i if c.tool == "vespaSearch"]
n_vespa_i = |vespa_calls_i|

# Find first vespaSearch call that retrieved a gold document
expl_dist_i = 1.0    (default: never found)
for j, call in enumerate(vespa_calls_i):
    if any(chunk.is_gold_doc for chunk in call.chunks):
        expl_dist_i = (j + 1) / n_vespa_i
        break

exploration_reward_i = α_expl × (1.0 − expl_dist_i)    where α_expl = 0.03
```

Session that finds gold doc on first vespaSearch → `expl_dist = 1/n → reward = 0.03 × (1 − 1/n)`. Session that needs 8 calls → `expl_dist = 8/8 = 1.0 → reward = 0`. Session that never finds gold → `reward = 0`.

#### 3d. Drill-Down Distance (trainer, tool-aware)

```
drill_calls_i = [c for c in calls_i if c.tool in ("searchWithinDoc", "getChunks", "getDocument")]
n_drill_i = |drill_calls_i|

# Find first drill call that retrieved a gold chunk
drill_dist_i = 1.0    (default: never found)
for j, call in enumerate(drill_calls_i):
    if any(chunk.is_gold_chunk for chunk in call.chunks):
        drill_dist_i = (j + 1) / n_drill_i
        break

drill_reward_i = α_drill × (1.0 − drill_dist_i)    where α_drill = 0.02
```

Rewards sessions that efficiently drill from gold doc → gold chunk. A session that does `searchWithinDoc(gold_doc, "registration")` and finds gold chunk on first call gets full reward.

#### 3e. NDCG Share (trainer)

```
# Rank ALL chunks across group by Vespa score (descending)
ranked = sort(all_chunks_group, key=−vespa_score)

# DCG: gold chunk = 1.0, gold doc = 0.5, else 0
DCG = Σ (rel_i / log2(rank_i + 2))    for each chunk in ranked

# Per-session DCG contribution
session_dcg_i = Σ (rel / log2(rank + 2))    for chunks from session i

ndcg_share_i = session_dcg_i / DCG

ndcg_reward_i = α_ndcg × ndcg_share_i    where α_ndcg = 0.02
```

Session that found gold chunks with high Vespa relevance scores → higher NDCG share. Session that found gold buried deep in low-relevance results → lower share.

#### 3f. Gold Coverage (trainer)

```
gold_found_i = |{chunk_id ∈ chunks_i : chunk_id ∈ gold_chunks}|

coverage_reward_i = α_cov × (gold_found_i / |gold_chunks|)    where α_cov = 0.02
```

Session that found 5 of 9 gold chunks → `reward = 0.02 × 5/9 = 0.011`. Session that found 0 → `reward = 0`.

#### 3g. Query Diversity (trainer)

```
queries_i = [c.query for c in calls_i if c.query]
unique_queries_i = |set(queries_i)|
total_queries_i = |queries_i|

query_diversity_i = unique_queries_i / total_queries_i

diversity_q_reward_i = α_qdiv × query_diversity_i    where α_qdiv = 0.01
```

Session with 15 unique queries out of 15 calls → `reward = 0.01`. Session that repeats same query 15 times → `reward = 0.01 × 1/15 = 0.0007`.

### Level 3 Summary

```
retrieval_reward_i = mi_reward_i
                   + diversity_reward_i
                   + exploration_reward_i
                   + drill_reward_i
                   + ndcg_reward_i
                   + coverage_reward_i
                   + diversity_q_reward_i
```

## Final Merge: Per-Session Adjusted Reward

Combining all three levels into one scalar per session:

```
adjusted_reward_i = gate_i × (shared_answer_i + retrieval_reward_i)
```

If `gate_i = 0` (session produced nothing) → `adjusted_reward = 0`.
If `gate_i = 1` → `adjusted_reward = group_answer_score + individual_retrieval_contribution`.

## GRPO Advantage

```
advantage_i = (adjusted_reward_i − mean(adjusted_reward_j for j ≠ i)) / std(adjusted_reward_j for j ≠ i)
```

This is the final signal that flows into the policy gradient for LoRA weight updates.

## Concrete Example

Group of 8 sessions answering "What is SEBI's rationale for extending NPO registration?"

| Session | gate | shared_answer | MI | diversity | expl_dist | drill_dist | ndcg | gold_cov | q_div | retrieval | adjusted | advantage |
|---------|------|---------------|-----|-----------|-----------|------------|------|----------|-------|-----------|----------|-----------|
| A (found gold doc fast, good chunks, bad answer) | 1.0 | 0.55 | 0.05 | 0.03 | 0.027 | 0.018 | 0.015 | 0.011 | 0.009 | 0.160 | 0.710 | +0.42 |
| B (found nothing, great answer from A's chunks) | 1.0 | 0.55 | 0.00 | 0.00 | 0.000 | 0.000 | 0.000 | 0.000 | 0.005 | 0.005 | 0.555 | −0.12 |
| C (looped same query 15×, found nothing) | 1.0 | 0.55 | 0.00 | 0.00 | 0.000 | 0.000 | 0.000 | 0.000 | 0.001 | 0.001 | 0.551 | −0.15 |
| D (found gold doc on call 3, drilled well) | 1.0 | 0.55 | 0.03 | 0.02 | 0.020 | 0.020 | 0.010 | 0.008 | 0.008 | 0.116 | 0.666 | +0.28 |
| E (empty, aborted) | 0.0 | 0.55 | 0.00 | 0.00 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | −0.43 |

(Numbers illustrative — shared_answer is the same for all; retrieval differentiates; GRPO normalizes)

## Tool Pipeline → Reward Mapping

```
vespaSearch    →  exploration distance (3c)     how fast did you find the gold doc?
                   query diversity (3g)          did you ask varied questions?
                   NDCG (3e)                     how high did gold rank in your results?

searchWithinDoc →  drill-down distance (3d)     how fast did you find the gold chunk?
                   NDCG (3e)                     how high did gold rank?

getChunks      →  drill-down distance (3d)     did you fetch the right chunk?
                   gold coverage (3f)            did you retrieve the exact gold chunk?

All tools      →  MI evidence (3a)              did you find unique gold no one else found?
                   diversity bonus (3b)          did you explore unique chunks?
```
