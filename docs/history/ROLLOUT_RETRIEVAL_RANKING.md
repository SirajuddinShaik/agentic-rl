# Rollout-Level Retrieval Ranking Reward

## The Idea

Instead of scoring each session's retrieval in isolation (binary: "did you find gold?"), collect ALL tool calls and retrieved chunks across the entire rollout (8 sessions × 32 groups), rank them by relevance and gold-evidence proximity, and reward sessions that contributed high-ranked evidence.

## What Data We Have

Per session (in rollout dump `raw_flow`):
- `tool_calls[]` — each vespaSearch with `args.query`, `status`, `isError`, in call order
- `retrieved_chunks[]` — each with `docId`, `chunk`, `snippet`, `source_text`, `relevance` (Vespa score)
- `citations[]` — chunks the model actually cited in its answer

From training data (`sebi_pranav_metadata_graph_train.jsonl`):
- `metadata.doc_ids` — gold document IDs (e.g., 3 docs)
- `metadata.chunk_ids` — gold chunk IDs in `docId#chunkIndex` format (e.g., 9 chunks)
- `metadata.answer` — reference answer

### Example data from group 0, rollout 0

```
Gold docs: 3     Gold chunks: 9
Sessions completed: 49 (many retries per sample)
Total vespaSearch calls: 273
Total chunks retrieved: 2462

Per session: ~20 tool calls, ~59 chunks retrieved, ~2-3 unique queries
```

## Proposed Metrics

### 1. Chunk-Level Rank (NDCG)

Across all 8 sessions in a group, collect all retrieved chunks. Sort by Vespa relevance. Compute NDCG:

```
DCG = sum(rel_i / log2(rank_i + 1)) for gold chunks
IDCG = ideal DCG (all gold chunks at top)
NDCG = DCG / IDCG
```

Session credit = fraction of DCG contributed by that session's chunks.

### 2. Doc-Level Distance

For each gold document, find the first tool call (across all sessions) that retrieved any chunk from it:

```
doc_distance_d = min(call_order where doc_d appears) / total_calls
```

Lower distance = the group found the right document faster. Sessions that made the discovering call get credit.

### 3. Call-Order Efficiency

Across the group's ~273 tool calls, how many were "wasted" (retrieved nothing new)?

```
waste_ratio = 1 - (unique_chunks / total_chunks_retrieved)
```

Sessions with high waste ratio (repeated same queries) get penalized.

### 4. Session Retrieval Rank

For each session, compute its rank within the group:

```
session_rank_i = mean_relevance_of_gold_chunks_found_i / mean_relevance_of_all_gold_chunks_in_group
```

Sessions that found gold chunks with higher Vespa relevance (closer to the top of Vespa's ranking) get higher reward than sessions that found the same chunks buried deep.

## How to Implement

### In post_process_rewards() (trainer-side, no restart)

After computing raw_rewards, before GRPO normalization:

```python
# Collect retrieval data from all samples in the group
session_retrieval = []
for sample in samples:
    polar_meta = getattr(sample, "metadata", {}).get("polar", {})
    traj_meta = polar_meta.get("trajectory_metadata", {})
    ev = traj_meta.get("evaluation", {})
    raw_flow = ev.get("raw_flow", {})
    
    chunks = []
    for c in (raw_flow.get("retrieved_chunks") or []):
        doc_id = c.get("docId", "")
        chunk_idx = c.get("chunk")
        chunk_id = f"{doc_id}#{chunk_idx}" if chunk_idx is not None else doc_id
        chunks.append({
            "doc_id": doc_id,
            "chunk_id": chunk_id,
            "relevance": c.get("relevance", 0),
        })
    
    queries = [
        t.get("args", {}).get("query", "")
        for t in (raw_flow.get("tool_calls") or [])
        if t.get("toolName") == "vespaSearch" and not t.get("isError")
    ]
    
    session_retrieval.append({"chunks": chunks, "queries": queries})

# Gold evidence from evaluator config
gold_docs = set(ev_config.get("expected_doc_ids") or [])
gold_chunks = set(ev_config.get("expected_chunk_ids") or [])

if gold_chunks or gold_docs:
    # Doc-level: which sessions found gold docs?
    for i, sr in enumerate(session_retrieval):
        found_gold_docs = {c["doc_id"] for c in sr["chunks"]} & gold_docs
        found_gold_chunks = {c["chunk_id"] for c in sr["chunks"]} & gold_chunks
        
        # Relevance-weighted credit: higher relevance on gold = better
        gold_relevances = [c["relevance"] for c in sr["chunks"] 
                          if c["chunk_id"] in gold_chunks or c["doc_id"] in gold_docs]
        
        if gold_relevances:
            mean_gold_rel = sum(gold_relevances) / len(gold_relevances)
            raw_rewards[i] += alpha * mean_gold_rel * len(found_gold_docs) / max(len(gold_docs), 1)
        
        # Penalty for redundant queries
        unique_queries = len(set(sr["queries"]))
        total_queries = len(sr["queries"])
        if total_queries > 0:
            query_efficiency = unique_queries / total_queries
            raw_rewards[i] -= gamma * (1 - query_efficiency)  # penalize repeated same queries
```

### As a new GroupRewardSpec strategy (polar-side, needs restart)

Add `strategy = "rollout_retrieval_ranking"` to `group_reward.py` that:
1. Collects all 8 sessions' raw flows
2. Computes NDCG, doc-distance, and call-order efficiency
3. Credits each session proportionally

## Why This Is Better Than Current Per-Session Scoring

| Current (per-session) | Proposed (rollout-level) |
|----------------------|------------------------|
| Binary: did session find gold? | Ranked: how high is gold in the retrieval? |
| No cross-session comparison | Sessions compete on retrieval quality |
| Same query 15 times = same score | Wasted calls penalized |
| Finding gold at relevance 0.3 = same as finding it at 1.0 | Higher relevance on gold = more credit |
| No notion of "who found it first" | Call-order distance rewards fast discovery |
| Redundant retrievals across sessions invisible | Doc-level coverage shows collective exploration |

## Data Availability

- `retrieved_chunks` with `docId`, `chunk`, `relevance`: YES, in rollout dumps
- `tool_calls` with `args.query` in call order: YES
- `gold_doc_ids` and `gold_chunk_ids`: YES, from training data metadata
- Per-session attribution: YES, each chunk/session has session_id

## Key Insight

The rollout dump already contains everything needed. The `gold_evidence_coverage` scorer already computes exact + semantic recall per session. What's missing is the cross-session ranking — "your session found gold at Vespa relevance 0.95, another session found the same gold at 0.3, you get more credit because your retrieval was better targeted."
