# Reward Restructure: Per-Session → Group-Level

## Problem

14 per-session scorers produce the `outcome_reward`, but analysis shows:

- 3 are CONSTANT across all sessions (completion=1.0, answer_format=1.0, subagent_success=0.0) — zero discriminative power, pure noise in the denominator
- 1 is NEAR-ZERO (embedding_similarity mean=0.026) — broken for this task, heaviest weight (2.0), all noise
- 4 are REDUNDANT with group-level rewards we already built (gold_evidence_coverage, retrieval_quality, tool_evidence_utility, tool_call_efficiency) — double-counting
- 5 have signal but are ANSWER-DEPENDENT (llm_judge, citation_accuracy, citation_relevance, citation_presence, citation_evidence_coverage) — the answer quality depends on combined group retrieval, not individual session work

Only 1 scorer (token_efficiency) has genuine per-session signal that isn't captured at group level.

## Proposed New Structure

### Per-session: MINIMAL (1 scorer)

| Scorer | Weight | What it measures | Why keep per-session |
|--------|--------|------------------|----------------------|
| completion | 1.0 | Did this session produce ANY output? | Binary gate — a session that produced nothing can't contribute to the group. This is the only thing that's truly per-session. |

All other per-session scorers → DISABLED (weight=0 in config).

### Group-level: ANSWER QUALITY (scored on best answer)

| Scorer | Weight | What it measures | How it works |
|--------|--------|------------------|--------------|
| llm_judge | 1.5 | Best answer quality | Take the session with highest outcome_reward. Score its answer once. All sessions in the group get this score. |
| citation_accuracy | 1.0 | Best citation accuracy | Same — score the best session's citations. |
| citation_relevance | 0.5 | Best citation relevance | Same. |
| token_efficiency | 0.5 | Group token cost | Mean token usage across all 8 sessions. Penalizes groups that burned tokens inefficiently. |

### Group-level: RETRIEVAL (already implemented)

| Scorer | Weight | What it measures |
|--------|--------|------------------|
| mutual_information_evidence | 0.15 | Unique gold chunk contribution per session |
| diversity_bonus | 0.10 | Unique chunk exploration per session |
| exploration_distance | 0.03 | vespaSearch calls before first gold doc |
| drill_down_distance | 0.02 | searchWithinDoc/getChunks before first gold chunk |
| ndcg_share | 0.02 | Session's DCG contribution / group DCG |
| gold_coverage | 0.02 | Gold chunks found / total gold |
| query_diversity | 0.01 | Unique queries / total queries |

### Group-level: DISABLE (redundant or noise)

| Scorer | Reason |
|--------|--------|
| answer_format | Constant 1.0 — all sessions format correctly |
| subagent_success | Constant 0.0 — no sub-agents used |
| embedding_similarity | Near-zero (0.026) — broken for this task |
| gold_evidence_coverage | Redundant with MI + NDCG + gold_coverage |
| retrieval_quality | Redundant with exploration + drill-down + NDCG |
| tool_evidence_utility | Redundant with exploration + drill-down |
| tool_call_efficiency | Redundant with query_diversity + token_efficiency |
| citation_presence | Redundant with citation_accuracy |
| citation_evidence_coverage | Redundant with gold_coverage + NDCG |
| quality_conditioned_token_efficiency | Already disabled |

## Comparison

### Before (current)

| Level | Scorers | Total weight | Noise sources |
|-------|---------|-------------|---------------|
| Per-session | 14 | 16.25 | 3 constant + 1 near-zero = 3.5 weight wasted |
| Group (polar) | 1 (MI) | 0.15 | — |
| Group (trainer) | 6 (diversity + retrieval) | 0.10 | — |
| GRPO | 1 (LOO) | — | — |

### After (proposed)

| Level | Scorers | Total weight | Noise sources |
|-------|---------|-------------|---------------|
| Per-session | 1 (completion gate) | 1.0 | 0 |
| Group (answer) | 4 (llm_judge, cit_acc, cit_rel, token_eff) | 3.5 | 0 — scored on best answer |
| Group (retrieval) | 7 (MI + diversity + 5 retrieval) | 0.35 | 0 — all cross-session |
| GRPO | 1 (LOO) | — | — |

## Implementation

### Step 1: Disable noisy/redundant per-session scorers in config

```yaml
scorers:
- name: completion
  weight: 1.0
- name: answer_format
  weight: 0.0      # was 0.5 — constant 1.0
- name: citation_presence
  weight: 0.0      # was 1.0 — redundant with citation_accuracy
- name: citation_relevance
  weight: 0.0      # was 0.75 — move to group-level
- name: citation_accuracy
  weight: 0.0      # was 1.5 — move to group-level
- name: llm_judge
  weight: 0.0      # was 1.5 — move to group-level
- name: retrieval_quality
  weight: 0.0      # was 1.0 — redundant with retrieval ranking
- name: gold_evidence_coverage
  weight: 0.0      # was 1.0 — redundant with MI + NDCG
- name: citation_evidence_coverage
  weight: 0.0      # was 1.0 — redundant
- name: tool_evidence_utility
  weight: 0.0      # was 1.0 — redundant with exploration/drill-down
- name: subagent_success
  weight: 0.0      # was 0.5 — constant 0.0
- name: embedding_similarity
  weight: 0.0      # was 2.0 — near-zero, broken
- name: tool_call_efficiency
  weight: 0.0      # was 1.0 — redundant with query_diversity
- name: token_efficiency
  weight: 0.0      # was 1.0 — move to group-level
```

### Step 2: Add group-level answer scoring in group_reward.py

New `GroupRewardSpec.strategy = "best_answer_group_score"`:

```python
def _apply_best_answer_group_score(results, spec):
    """Score the best session's answer once, apply to all sessions."""
    # Find session with highest outcome_reward
    best = max(results, key=lambda r: _trajectory_reward(r) or 0.0)
    best_ev = best.trajectory.metadata.get("evaluation", {})
    best_per_scorer = best_ev.get("per_scorer", {})

    # Extract best answer scores
    llm_judge = best_per_scorer.get("llm_judge", 0.0)
    cit_acc = best_per_scorer.get("citation_accuracy", 0.0)
    cit_rel = best_per_scorer.get("citation_relevance", 0.0)

    # Group token efficiency (mean across sessions)
    token_effs = []
    for r in results:
        ps = (r.trajectory.metadata.get("evaluation") or {}).get("per_scorer", {})
        token_effs.append(ps.get("token_efficiency", 0.0))
    group_token_eff = sum(token_effs) / max(len(token_effs), 1)

    # Apply to all sessions
    for i, result in enumerate(results):
        base = _trajectory_reward(result) or 0.0
        shaped = base + spec.weight * (
            1.5 * llm_judge
            + 1.0 * cit_acc
            + 0.5 * cit_rel
            + 0.5 * group_token_eff
        ) / 3.5  # normalize by total weight
        results[i] = _replace_reward(result, shaped, {
            "strategy": "best_answer_group_score",
            "base_reward": base,
            "llm_judge": llm_judge,
            "citation_accuracy": cit_acc,
            "citation_relevance": cit_rel,
            "group_token_efficiency": group_token_eff,
        })
    return results
```

### Step 3: Config

```yaml
group_reward:
  strategy: best_answer_group_score
  weight: 1.0
```

## What This Changes

**Before:** Each session gets scored on 14 dimensions individually. Session A (good retrieval, bad answer) gets penalized on llm_judge (w=1.5) and embedding_similarity (w=2.0) — the two heaviest weights. Its retrieval contribution is invisible.

**After:** Session A gets:
- completion = 1.0 (it produced something)
- Group answer score = best session's llm_judge/citation scores (A isn't penalized for poor synthesis)
- MI evidence = high (A found unique gold chunks)
- NDCG share = high (A's gold chunks ranked well)
- Exploration distance = high (A found gold doc quickly)
- Drill-down distance = high (A found gold chunk quickly)

The reward now reflects A's actual contribution to the group's success, not its individual answer quality. GRPO advantage pushes the model toward A's exploration strategy.
