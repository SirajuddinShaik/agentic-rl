# Reward Architecture Analysis — Session-Level vs Group-Level Rewarding

**Created:** 2026-08-31
**Context:** v19 GRPO training, 8 samples per group, 32 groups per rollout

---

## Current Architecture

Right now the reward pipeline is **strictly per-session**:

```
Session 1 (8 traces) ──> XyneCompositeEvaluator ──> reward_1
Session 2 (8 traces) ──> XyneCompositeEvaluator ──> reward_2
...
Session 8 (8 traces) ──> XyneCompositeEvaluator ──> reward_8
                                                    │
                    GRPO normalization (leave-one-out)
                    advantage_i = reward_i - mean(reward_others)
```

Each session runs independently through the xyne harness. The evaluator calls `pipeline.run_with_scores(flow)` on ONE session's `XyneRawFlow` at a time. Every scorer (13 total) scores that one session in isolation:

- `gold_evidence_coverage` — did THIS session find the gold chunks?
- `tool_evidence_utility` — did THIS session's tool calls add evidence?
- `citation_accuracy` — did THIS session cite the right docs?
- `llm_judge` — is THIS session's answer good?
- `retrieval_quality` — were THIS session's retrieved chunks relevant?

No scorer ever sees what other sessions in the same group found. The only group-level signal is the GRPO normalization in `post_process_rewards()`, which computes `advantage_i = reward_i - mean(other_rewards)` — but this is just a scalar transform on already-computed per-session rewards.

## The Problem You're Identifying

Sessions within a GRPO group can complement each other:

**Scenario:** Group has 8 sessions answering "What is X?"

- Session A does 3 vespaSearch calls, finds chunks [1, 5, 9, 12] — includes the gold chunk 5 — but generates a poor answer (llm_judge=0.3)
- Session B does 2 vespaSearch calls, finds chunks [3, 7] — no gold chunks — but generates a great answer (llm_judge=0.9) using those chunks
- Session C finds chunks [5, 8, 11] — has the gold chunk — and a decent answer (llm_judge=0.6)

**Current scoring:**
- A: low reward (bad answer despite good retrieval)
- B: high reward (good answer despite missing gold evidence)
- C: medium-high reward (good retrieval + decent answer)

**What's missing:** Session A found chunk 5 which Session B could have used to produce an even better answer. Session A's retrieval work has value to the group even though its own answer was poor. The current reward model gives A a low reward, so the model learns "finding chunk 5 isn't worth much" — but it IS worth much if combined with B's answer generation ability.

## Three Levels of Solution

### Level 1: Group Evidence Coverage Bonus (minimal change)

Add a new scorer: `group_evidence_coverage`. This runs AFTER all 8 sessions complete, not per-session.

**How it works:**
1. After all 8 sessions in a group complete, collect the union of all retrieved chunks across sessions: `union_chunks = A.chunks ∪ B.chunks ∪ ... ∪ H.chunks`
2. Compute what fraction of gold evidence the GROUP collectively found: `group_coverage = |union_chunks ∩ gold_chunks| / |gold_chunks|`
3. For each session, compute its **unique contribution**: chunks it found that no other session found
4. Bonus = `group_coverage * unique_contribution_fraction`

**Reward adjustment:**
```
final_reward_i = session_reward_i + α * group_coverage_bonus_i
```

Where α is a weight (e.g. 0.2) and `group_coverage_bonus_i` rewards sessions that contributed unique evidence to the group's collective coverage.

**Implementation:**
- New scorer class `GroupEvidenceCoverageScorer` that takes ALL 8 flows, not one
- Requires changing the evaluator to pass group context
- OR: post-process in `post_process_rewards()` where all samples are already available

**Pros:** Captures cross-session evidence value. Session A gets bonus for finding chunk 5 even if its answer was poor.
**Cons:** Requires group context at scoring time. The evaluator currently scores one trajectory at a time.

### Level 2: Best-of-Group Composition Reward

Instead of scoring each session independently, compose a "group answer" from the best parts of all sessions.

**How it works:**
1. After all 8 sessions complete, extract:
   - Best chunks: union of all retrieved chunks, ranked by relevance
   - Best citations: all unique citations across sessions
   - Best answer fragments: segments from each session's answer that are cited
2. Feed the best chunks to an LLM judge: "Given these chunks (from all sessions), what is the best possible answer?"
3. Compare each session's individual answer to the group composite answer
4. Reward = how much each session contributed to the composite

**Reward components:**
- `chunk_contribution`: did this session's unique chunks end up in the composite answer?
- `answer_overlap`: how similar is this session's answer to the group composite?
- `citation_contribution`: did this session's citations appear in the composite?

**Implementation:**
- New post-processing step in `post_process_rewards()`
- Requires an LLM call to generate the composite answer (or use the best session's answer as proxy)
- The `llm_judge` scorer already supports network calls, so the infrastructure exists

**Pros:** Directly measures "did this session help the group produce a better answer?"
**Cons:** Extra LLM call per group (8 groups × 32 = 256 extra calls per rollout). More complex.

### Level 3: Shared Context Pipeline (generation-side change)

Instead of running sessions independently, share intermediate tool results across sessions within a group.

**How it works:**
1. Session 1 runs, does vespaSearch, finds chunks [1, 5, 9]
2. Session 2 starts with session 1's chunks pre-loaded in context: "Previous searches found these relevant chunks: [1, 5, 9]. You may use them or search for more."
3. Session 2 can skip redundant searches and focus on synthesizing a better answer
4. Session 3 gets chunks from sessions 1+2, etc.

**Implementation:**
- Change the xyne harness to accept "prior context" (chunks from previous sessions)
- Change the task payload to include shared context
- Change the reward model to account for "did this session build on prior work or repeat it?"

**Pros:** Sessions actively help each other. Reduces redundant tool calls. Each session can specialize (search vs synthesize).
**Cons:** Major pipeline change. Sessions are no longer independent samples for GRPO — the i.i.d. assumption breaks. Need careful advantage normalization.

---

## Recommended Approach: Level 1 First

Level 1 (group evidence coverage bonus) is the best bang-for-effort:

1. **Minimal code change:** Add the bonus in `post_process_rewards()` in `polar_reward.py` where all 8 samples are already available. No evaluator or harness changes needed.

2. **No extra LLM calls:** Pure set operations on chunk IDs. Fast.

3. **Preserves GRPO assumptions:** Sessions still generate independently. The bonus is a reward shaping on top of per-session rewards, not a generation change.

4. **Captures the key signal:** Session A that found unique gold chunks gets a bonus even with a poor answer. Session B that produced a great answer but found nothing unique gets its full per-session reward but no group bonus.

### Proposed Implementation

In `post_process_rewards()` (polar_reward.py), after computing per-session raw_rewards:

```python
# Group evidence coverage bonus
# All 8 samples share the same group_id; collect their retrieved chunks
group_chunks = defaultdict(set)
gold_chunks = set()
for i, sample in enumerate(samples):
    # Extract retrieved chunk IDs from sample metadata
    polar_meta = getattr(sample, "metadata", {}).get("polar", {})
    traj_meta = polar_meta.get("trajectory_metadata", {})
    ev = traj_meta.get("evaluation", {})
    raw_flow = ev.get("raw_flow", {})
    chunks = {c.get("docId") for c in raw_flow.get("retrieved_chunks", []) if c.get("docId")}
    group_chunks[i] = chunks
    # Gold chunks from evaluator config
    gold = ev.get("gold_chunk_ids", [])
    gold_chunks.update(gold)

if gold_chunks:
    # Union of all sessions' chunks
    union_chunks = set()
    for chunks in group_chunks.values():
        union_chunks.update(chunks)
    group_coverage = len(union_chunks & gold_chunks) / len(gold_chunks)

    # Unique contribution per session
    for i in range(len(samples)):
        others_union = set()
        for j, chunks in group_chunks.items():
            if j != i:
                others_union.update(chunks)
        unique = group_chunks[i] - others_union
        unique_gold = unique & gold_chunks
        # Bonus: group coverage * unique gold contribution
        bonus = alpha * group_coverage * (len(unique_gold) / max(len(gold_chunks), 1))
        raw_rewards[i] += bonus
```

### Config

Add to polar config:
```yaml
group_evidence_bonus:
  enabled: true
  alpha: 0.15  # weight of group bonus relative to per-session reward
  require_unique: true  # only bonus for chunks no other session found
```

---

## Current Scorer Weights (for reference)

| Scorer | Weight | What it measures |
|--------|--------|------------------|
| completion | 1.0 | Did the session produce an answer? |
| answer_format | 0.5 | Is the answer properly formatted? |
| citation_presence | 1.0 | Are there citations? |
| citation_relevance | 0.75 | Are cited chunks relevant? |
| citation_accuracy | 1.5 | Do citations match expected docs? |
| llm_judge | 1.5 | Is the answer correct? (LLM-scored) |
| retrieval_quality | 1.0 | Are retrieved chunks relevant? |
| gold_evidence_coverage | 1.0 | Did THIS session find gold evidence? |
| citation_evidence_coverage | 1.0 | Do citations cover expected evidence? |
| tool_evidence_utility | 1.0 | Did tool calls add useful evidence? |
| subagent_success | 0.5 | Did sub-agents run without errors? |
| embedding_similarity | 2.0 | Is answer semantically similar to reference? |
| tool_call_efficiency | 1.0 | Were tool calls efficient (budget=8)? |
| token_efficiency | 1.0 | Was token usage efficient? |

All of these are per-session. The proposed `group_evidence_coverage` bonus would be the first cross-session signal.

---

## Key Files

| File | Location | Role |
|------|----------|------|
| reward_pipeline.py | /data/siraj/ARL/ProRL-Agent-Server/src/polar/xyne/ | Pipeline framework, scorer registry |
| evaluator.py | /data/siraj/ARL/ProRL-Agent-Server/src/polar/xyne/ | Calls pipeline.run_with_scores() per session |
| polar_reward.py | /root/miles/miles/rollout/ | GRPO normalization, post_process_rewards() |
| types.py | /data/siraj/ARL/ProRL-Agent-Server/src/polar/xyne/ | XyneRawFlow dataclass (retrieved_chunks, tool_calls, etc.) |
| scorers/ | /data/siraj/ARL/ProRL-Agent-Server/src/polar/xyne/ | 13 individual scorer implementations |
| polar_config_custom.yaml | run dir | Scorer weights and configuration |
