# Cross-Session Reward Research — Findings & Recommendations

## What Already Exists in the Codebase

### 1. `apply_group_reward()` in polar/rollout/group_reward.py

There IS already a group-level reward step. It runs AFTER all 8 sessions complete, BEFORE the trainer sees rewards. Called at `manager.py:245`:

```python
ordered_results = apply_group_reward(list(results), request.group_reward)
```

It implements **quality-conditioned token efficiency** (Pareto shaping):
- For each session, compares quality vs token cost against all other sessions
- If session A has same quality as B but fewer tokens → A gets efficiency bonus
- Bonus = `weight * (1 - bounded_quality) * efficiency_score`
- `efficiency_score` = fraction of peers this session Pareto-dominates

This is **not enabled in v19** — `group_reward` is absent from the config, so `spec=None` and the function returns early. The `shape_trajectory_means()` in `group_relative_efficiency.py` does the same thing on the trainer side, gated by `POLAR_GROUP_RELATIVE_TOKEN_WEIGHT=0.0` (disabled).

### 2. Leave-one-out (LOO) baseline in post_process_rewards()

The GRPO advantage normalization in `polar_reward.py` already does leave-one-trajectory-out:

```python
other_means = [shaped_mean[other_key] for other_key in valid_keys if other_key != key]
baseline = sum(other_means) / len(other_means)
advantage = (shaped_mean[key] - baseline) / scale
```

This is the standard GRPO approach: advantage = reward_i - mean(reward_others). It's purely scalar — no cross-session information sharing.

### 3. `check_reward_nonzero_std` dynamic filter

The trainer uses `--dynamic-sampling-filter-path check_reward_nonzero_std` which drops entire groups where all 8 samples have the same reward (std=0). This means groups where all sessions either succeed or all fail get zero gradient — no learning signal.

### 4. `tool_evidence_utility` scorer

This scorer is the closest thing to cross-session awareness, but it's still per-session. It tracks **marginal contribution** of each tool call within a single session:
- For each vespaSearch call, checks if it added new gold evidence not found by previous calls in the SAME session
- Rewards calls that increase cumulative coverage

The concept of "marginal contribution" is exactly right — but it's applied within one session, not across the group.

---

## Research: What the Literature Says

### Approach A: Shapley Value Credit Assignment

**Paper:** "A Shapley Value Estimation Method for Multi-Agent Reinforcement Learning" (Wang et al., 2021)

Instead of simple leave-one-out, compute each session's **Shapley value** — its average marginal contribution across all possible coalitions of sessions:

```
φ_i = Σ (|S|! * (n - |S| - 1)!) / n! * [v(S ∪ {i}) - v(S)]
```

Where `v(S)` is the "group value" function — what reward would the group get if only sessions in coalition S existed?

**How it applies here:**
- `v(S)` = best possible answer achievable using only chunks found by sessions in S
- Session A that found unique gold chunk 5 has positive Shapley value even if its own answer was poor, because removing A from any coalition reduces the group's achievable coverage
- Sessions that found redundant chunks (already found by others) get near-zero Shapley value

**Problem:** Exact Shapley is O(n!) — infeasible for n=8 (40320 coalitions). But Monte Carlo Shapley approximation (sample random permutations) works well for n=8: ~100 permutations gives good estimates.

### Approach B: Mutual Information Reward (InfoNCE-style)

**Paper:** "Diversity-Inducing Information Bottleneck for Multi-Agent RL" (Tian et al., 2022)

Reward sessions for being **informative** — contributing information that other sessions don't:

```
MI_reward_i = H(chunks_group) - H(chunks_group | chunks_i)
```

Where:
- `H(chunks_group)` = entropy of the full set of chunks found by all 8 sessions
- `H(chunks_group | chunks_i)` = entropy remaining when session i's chunks are removed

**How it applies here:**
- Session A found chunks [1, 5, 9]. Other sessions found [3, 7, 1, 5].
- Without A: group has {1, 3, 5, 7}. With A: group has {1, 3, 5, 7, 9}.
- A's unique contribution = chunk 9. If chunk 9 is gold evidence, A gets high MI reward.
- Session B found [3, 7] which others also found. B's MI contribution = 0 (no new information).

**Advantage over Shapley:** O(n) computation — just set operations. No sampling needed.

### Approach C: Tournament / Pairwise Comparison (Self-Play)

**Paper:** "Constitutional AI: Harmlessness from AI Feedback" (Anthropic, 2022)

Instead of absolute scoring, run pairwise comparisons:
- Take each pair of sessions (A, B) in the group
- Ask the LLM judge: "Which response is better, A or B?"
- Session's tournament score = fraction of pairwise wins

**How it applies here:**
- Session A (good retrieval, bad answer) vs Session B (bad retrieval, good answer)
- Judge compares answers only → B wins → A gets low reward
- BUT: could also run a "retrieval tournament" — which session's chunks would produce a better answer if fed to a fresh model?
- A's chunks → better answer than B's chunks → A wins the retrieval tournament

**Problem:** O(n²) LLM judge calls (28 pairs for n=8). Expensive but thorough.

### Approach D: Best-of-N Composition (Rationale-style)

**Paper:** "Training Language Models with Self-Improvement" (Huang et al., 2023)

After all N sessions complete:
1. Extract the best components from each session (best chunks, best answer fragments, best citations)
2. Compose a "group-optimal" answer from these components
3. Each session's reward = how much it contributed to the group-optimal answer

**How it applies here:**
- Session A found chunks [5, 9], Session B found [3, 7], Session C found [5, 8]
- Group-optimal chunks = [3, 5, 7, 8, 9] (union of unique)
- Feed these to LLM judge → group-optimal answer
- A's contribution score = |{5, 9} ∩ group_optimal_cited| / |group_optimal_cited|
- B's contribution score = |{3, 7} ∩ group_optimal_cited| / |group_optimal_cited|

**Advantage:** Directly measures "did this session's work end up in the best possible answer?"

### Approach E: Diversity Bonus (Existing in multi-agent RL)

**Paper:** "Cooperative Multi-Agent Reinforcement Learning with Diversity" (Du et al., 2019)

Simple but effective:
1. Compute each session's individual reward R_i
2. Compute group diversity D = number of unique chunks across all sessions / total chunks
3. Each session gets: `R_i + β * D * (unique_chunks_i / total_unique_chunks)`

**How it applies here:**
- Group found 12 unique chunks total, 2 were from session A
- A's diversity bonus = β * (12/15) * (2/12) = β * 0.133
- This rewards exploration — sessions that search different areas of the evidence space

---

## What I Recommend

### Short-term (implement now, no polar restart needed)

**Approach E (Diversity Bonus) in `post_process_rewards()`**

This is the simplest, fastest, and most robust. Pure set operations on chunk IDs, no extra LLM calls, no i.i.d. assumptions broken.

```python
# In post_process_rewards(), after computing raw_rewards:

# Collect retrieved chunks per session
session_chunks = []
for sample in samples:
    polar_meta = getattr(sample, "metadata", {}).get("polar", {})
    traj_meta = polar_meta.get("trajectory_metadata", {})
    ev = traj_meta.get("evaluation", {})
    raw_flow = ev.get("raw_flow", {})
    chunks = {c.get("docId") for c in raw_flow.get("retrieved_chunks", []) if c.get("docId")}
    session_chunks.append(chunks)

# Compute group diversity
all_chunks = set()
for chunks in session_chunks:
    all_chunks.update(chunks)
group_diversity = len(all_chunks) / max(sum(len(c) for c in session_chunks), 1)

# Unique contribution per session
for i in range(len(samples)):
    others = set()
    for j, chunks in enumerate(session_chunks):
        if j != i:
            others.update(chunks)
    unique_i = session_chunks[i] - others
    unique_fraction = len(unique_i) / max(len(all_chunks), 1)
    diversity_bonus = beta * group_diversity * unique_fraction
    raw_rewards[i] += diversity_bonus
```

Config: `beta = 0.1` (10% of base reward weight for diversity)

### Medium-term (needs polar restart, but worth it)

**Approach B (Mutual Information) as a new scorer in group_reward.py**

Add a new `GroupRewardSpec.strategy = "mutual_information_evidence"` that:
1. Computes each session's MI contribution (unique chunks that are gold evidence)
2. Applies bonus proportional to MI × group gold coverage

This replaces the current `quality_conditioned_token_efficiency` strategy (which is disabled anyway) with something that captures cross-session evidence value.

### Long-term (research direction)

**Approach D (Best-of-N Composition)** — would need:
1. An extra LLM call per group to compose the "group-optimal answer" from the best chunks
2. A citation attribution step to credit each session for chunks used in the optimal answer
3. This is the most accurate credit assignment but also the most expensive

---

## Key Insight from Codebase Analysis

The `apply_group_reward()` function at `manager.py:245` is **already called** after all 8 sessions complete but before the trainer sees rewards. It currently does Pareto token efficiency (disabled). This is the perfect injection point for cross-session reward shaping — it has all 8 `SessionResult` objects with full trajectories, including `retrieved_chunks`, `citations`, `tool_calls`, and `reward` for each session.

The `GroupRewardSpec` model already supports a `strategy` field. Adding a new strategy like `"mutual_information_evidence"` would:
1. Not break existing flows (current strategy stays as default)
2. Be configurable per-task in the polar config
3. Have access to all 8 sessions' raw flows

The trainer-side `post_process_rewards()` is the fallback if the polar-side group reward is disabled, and it's where we can apply the diversity bonus without any polar changes.

---

## Comparison Table

| Approach | Computation | Extra LLM calls | Breaks i.i.d.? | Captures cross-session value? | Implementation effort |
|----------|------------|-----------------|----------------|------------------------------|----------------------|
| E: Diversity Bonus | O(n) set ops | No | No | Partially (unique chunks only) | Low — 20 lines in polar_reward.py |
| B: Mutual Information | O(n) set ops | No | No | Yes (information theory) | Medium — new GroupRewardSpec strategy |
| A: Shapley (Monte Carlo) | O(n × samples) | No | No | Yes (exact marginal contribution) | Medium — ~100 lines, sampling loop |
| C: Tournament | O(n²) comparisons | 28 per group | No | Yes (direct comparison) | High — 28 LLM judge calls per group |
| D: Best-of-N | 1 LLM call + attribution | 1 per group | No | Yes (composition) | High — new pipeline step |
| Shared context (Level 3) | Pipeline change | No | Yes | Yes (generation-time) | Very high — harness changes |

## Final Recommendation

1. **Now:** Implement Diversity Bonus (Approach E) in `post_process_rewards()`. 20 lines, no restart, immediate effect.
2. **Next restart:** Enable `GroupRewardSpec` with `mutual_information_evidence` strategy in polar config.
3. **Research:** Explore Best-of-N composition for the next training run if the above doesn't sufficiently improve exploration.

The key difference from my earlier proposal: the codebase already has the `apply_group_reward()` injection point at the polar server level. This is better than doing it in `post_process_rewards()` because:
- It shapes the reward BEFORE the trainer sees it (cleaner separation)
- It has access to full `SessionResult` objects (not just flattened samples)
- It's already wired up — just needs a new strategy implementation and config
