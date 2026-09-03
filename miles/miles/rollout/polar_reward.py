"""Polar reward adapter for Miles and Slime.

Thin Miles-side counterpart to ``slime_bridge/reward.py`` and
``slime_bridge/reward_post_process.py``.  A Polar trajectory already carries a
per-trace scalar ``score`` (embedded into each converted sample); the reward
module only needs to read it back.  No Polar core, slime_bridge, or Xyne code is
touched or imported by this module.

Canonical entrypoints
---------------------
``custom_rm(args, sample_or_samples) -> float | list[float]``
    The canonical Miles ``--custom-rm-path`` entrypoint. Miles' runtime loads
    the configured symbol for both single-sample and batched reward paths, so
    this coroutine accepts either shape and preserves the corresponding return
    shape. Register this symbol as your ``--custom-rm-path``.

``compute_reward(args, sample) -> float``
    The synchronous pure equivalent of ``custom_rm``.  Holds the actual reward
    extraction logic and returns a plain ``float``, so any synchronous consumer
    (or the documented ``def custom_rm(args, sample) -> float`` contract) can call
    it directly without ``asyncio``.

``reward_func(args, sample_or_samples, **kwargs)``
    Slime-compatible async reward hook mirroring ``slime_bridge.reward.reward_func``,
    kept for drop-in parity with the Slime adapter contract.  Accepts either a
    single sample or a list and returns a ``{polar_reward_key: float}`` dict (or a
    list of such dicts).  Delegates to ``compute_reward`` to avoid duplication.

``post_process_rewards(args, samples) -> (raw_rewards, rewards)``
    Port of ``slime_bridge.reward_post_process.post_process_rewards``: leave-one-
    trajectory-out advantage normalization keyed by ``Sample.group_id`` so that a
    trajectory with a variable number of traces counts as one gradient unit.

``custom_rm``, ``compute_reward``, and ``reward_func`` all defensively read the
Polar sample shape: a nested sample dict whose ``polar_reward_key`` (default
``"score"``) holds the scalar reward.  Purely numeric rewards and a dict-of-many
numeric values are also handled, matching Slime's extraction behaviour.
"""

from __future__ import annotations

import json
import logging
import os
import statistics
from pathlib import Path
from typing import Any

from miles.rollout.group_relative_efficiency import (
    efficiency_weight,
    shape_trajectory_means,
    shape_trajectory_means_multi,
    trajectory_token_cost,
)

logger = logging.getLogger(__name__)


def _reward_key(args: Any) -> str:
    return str(getattr(args, "polar_reward_key", getattr(args, "reward_key", "score")))


def _extract_reward(sample: Any, reward_key: str) -> float:
    """Return the Polar score embedded in a single sample.

    A Polar-converted sample stores its reward under the ``polar_reward_key``
    field (default ``"score"``), either as a direct attribute or inside the
    nested ``sample["sample"]["response"]["reward"]`` dict that Polar produces.
    Fallbacks mirror Slime's ``_extract_reward``: a plain numeric reward, a
    ``dict`` whose key matches, a ``"score"`` key, or any single numeric value.
    """
    reward = getattr(sample, "reward", None)

    if reward is None and isinstance(sample, dict):
        # Polar nests the trace under sample["sample"]; dig down defensively to
        # the innermost dict(s) that actually carry a reward value.
        candidate: Any = sample
        for _ in range(8):
            if not isinstance(candidate, dict):
                break
            if "reward" in candidate:
                reward = candidate["reward"]
                break
            inner = candidate.get("sample")
            if isinstance(inner, dict):
                candidate = inner
            else:
                break

    if isinstance(reward, dict):
        if reward_key in reward:
            return float(reward[reward_key])
        if "score" in reward:
            return float(reward["score"])
        for value in reward.values():
            if isinstance(value, (int, float)):
                return float(value)
        return 0.0
    if isinstance(reward, (int, float)):
        return float(reward)
    return 0.0


def compute_reward(args: Any, sample: Any) -> float:
    """Synchronous pure reward extraction for a single Polar sample.

    This holds the actual extraction logic shared by the async entrypoints.
    Returns a plain ``float`` so any synchronous consumer can use it directly, per
    the documented ``def custom_rm(args, sample) -> float`` contract.
    """
    reward_key = _reward_key(args)
    reward = _extract_reward(sample, reward_key)
    logger.debug("polar reward -> %s (key=%s)", reward, reward_key)
    return float(reward)


async def custom_rm(
    args: Any, sample_or_samples: Any, **kwargs: Any
) -> float | list[float]:
    """Miles ``--custom-rm-path`` entrypoint for single and batched calls.

    ``rm_hub.async_rm`` passes one sample, while
    ``rm_hub.batched_async_rm`` passes the complete sample list to the same
    configured callable. Preserve that distinction in the return value so both
    Miles paths receive the shape they expect.
    """
    del kwargs
    if isinstance(sample_or_samples, list):
        return [compute_reward(args, sample) for sample in sample_or_samples]
    return compute_reward(args, sample_or_samples)


async def reward_func(args: Any, sample_or_samples: Any, **kwargs: Any) -> Any:
    """Slime-compatible async reward hook (drop-in parity with slime_bridge).

    Accepts a single sample or a list of samples.  Returns a ``{reward_key: float}``
    dict for a single sample, or a list of such dicts for a batch, mirroring the
    Slime adapter contract.  Delegates to ``compute_reward`` so both paths share the
    same extraction logic as ``custom_rm``.
    """
    del kwargs
    reward_key = _reward_key(args)
    if isinstance(sample_or_samples, list):
        return [{reward_key: compute_reward(args, sample)} for sample in sample_or_samples]
    return {reward_key: compute_reward(args, sample_or_samples)}


_DUMPED_GROUP_SIGNATURES: set[tuple[Any, ...]] = set()
_DUMPED_GROUP_SIGNATURES_MAX = 200000


def _status_str(status: Any) -> Any:
    return getattr(status, "value", status)


def _sample_polar_meta(sample: Any) -> dict:
    md = getattr(sample, "metadata", None) or {}
    polar = md.get("polar") if isinstance(md, dict) else None
    return polar or {}


def _reward_detail(sample: Any) -> dict:
    polar = _sample_polar_meta(sample)
    tm = polar.get("trajectory_metadata") or {}
    ev = tm.get("evaluation") or {}
    per_scorer = ev.get("per_scorer")
    if isinstance(per_scorer, dict):
        _USELESS = {"embedding_similarity", "subagent_success"}
        return {str(k): v for k, v in per_scorer.items() if str(k) not in _USELESS}
    return {}


def _dump_group_rewards(
    args: Any,
    samples: list[Any],
    raw_rewards: list[float],
    normalized_by_sample: list[float],
) -> None:
    """Persist one JSON record per group: session-level (raw) + relative rewards.

    Called from ``post_process_rewards`` so each completed group is dumped as soon
    as both its session-level rewards and its within-group relative (leave-one-out)
    rewards are computed, rather than waiting for the full rollout batch. Best-effort
    and non-fatal; identical (group, reward-vector) pairs are deduplicated.
    """
    try:
        configured = os.environ.get("MILES_POLAR_TRAJECTORY_DUMP_DIR", "").strip()
        if not configured:
            return
        dump_dir = Path(configured) / "group_rewards"
        dump_dir.mkdir(parents=True, exist_ok=True)
        by_group: dict[Any, list[tuple[int, Any]]] = {}
        for i, sample in enumerate(samples):
            group_idx = getattr(sample, "group_index", None)
            by_group.setdefault(group_idx, []).append((i, sample))

        for group_idx, items in by_group.items():
            records: list[dict] = []
            signature: list[Any] = [group_idx]
            for i, sample in items:
                polar = _sample_polar_meta(sample)
                raw = float(raw_rewards[i])
                norm = float(normalized_by_sample[i])
                signature.append(round(raw, 6))
                signature.append(round(norm, 6))
                # Extract source_metadata (doc_ids, chunk_ids, answer) from sample
                sample_metadata = getattr(sample, "metadata", {}) or {}
                source_metadata = {
                    k: sample_metadata.get(k)
                    for k in ("doc_ids", "chunk_ids", "answer", "question", "source")
                    if sample_metadata.get(k) is not None
                }
                _ps = _reward_detail(sample)
                records.append(
                    {
                        "session_id": polar.get("session_id"),
                        "task_id": polar.get("task_id"),
                        "node_id": polar.get("node_id"),
                        "trace_index": polar.get("trace_index"),
                        "sample_index": getattr(sample, "index", None),
                        "status": _status_str(getattr(sample, "status", None)),
                        "raw_reward": raw,
                        "normalized_reward": norm,
                        "response_length": int(getattr(sample, "response_length", 0) or 0),
                        "reward_summary": _ps,
                        "source_metadata": source_metadata if source_metadata else None,
                        "judge_io": (
                            (polar.get("trajectory_metadata") or {})
                            .get("evaluation", {})
                            .get("scorer_io")
                            or {}
                        ),
                    }
                )
            signature = tuple(signature)
            if signature in _DUMPED_GROUP_SIGNATURES:
                continue
            _DUMPED_GROUP_SIGNATURES.add(signature)
            if len(_DUMPED_GROUP_SIGNATURES) > _DUMPED_GROUP_SIGNATURES_MAX:
                _DUMPED_GROUP_SIGNATURES.clear()
            group_components = _compute_group_components(samples, raw_rewards)
            payload = {
                "group_index": group_idx,
                "n_samples": len(records),
                "group_mean_raw": (
                    sum(r["raw_reward"] for r in records) / len(records) if records else 0.0
                ),
                "group_mean_normalized": (
                    sum(r["normalized_reward"] for r in records) / len(records)
                    if records
                    else 0.0
                ),
                "reward_components": group_components,
                "samples": records,
            }
            target = dump_dir / f"group_{str(group_idx).zfill(6)}.jsonl"
            with open(target, "a", encoding="utf-8") as stream:
                stream.write(json.dumps(payload, ensure_ascii=False, default=str))
                stream.write("\n")
    except Exception:
        logger.exception("Failed to dump per-group rewards (non-fatal)")


def _compute_group_components(samples: list[Any], raw_rewards: list[float]) -> list[dict]:
    """Extract per-session reward component breakdown for dump verification."""
    components = []
    for i, sample in enumerate(samples):
        polar = _sample_polar_meta(sample)
        tm = polar.get("trajectory_metadata") or {}
        ev = tm.get("evaluation") or {}
        gr = ev.get("group_reward") or {}
        ps = ev.get("per_scorer") or {}
        components.append({
            "session_id": polar.get("session_id"),
            # Group-shared
            "shared_answer": float(gr.get("shared_answer_score", 0.0) or 0.0),
            "mi_reward": float(gr.get("mi_reward", 0.0) or 0.0),
            "gate": float(gr.get("gate", 0.0) or 0.0),
            # Citation metrics (THE GOAL)
            "citation_recall": float(ps.get("citation_evidence_coverage", ps.get("gold_evidence_coverage", 0.0)) or 0.0),
            "citation_precision": float(ps.get("citation_accuracy", 0.0) or 0.0),
            "citation_relevance": float(ps.get("citation_relevance", 0.0) or 0.0),
            # Answer quality
            "llm_judge": float(ps.get("llm_judge", 0.0) or 0.0),
            # Efficiency
            "token_efficiency": float(ps.get("token_efficiency", 0.0) or 0.0),
            "tool_call_efficiency": float(ps.get("tool_call_efficiency", 0.0) or 0.0),
            # Evidence
            "gold_evidence_coverage": float(ps.get("gold_evidence_coverage", 0.0) or 0.0),
            "citation_evidence_coverage": float(ps.get("citation_evidence_coverage", 0.0) or 0.0),
            # Final
            "final_reward": float(raw_rewards[i]) if i < len(raw_rewards) else 0.0,
        })
    return components


def post_process_rewards(args: Any, samples: list[Any]) -> tuple[list[float], list[float]]:
    """Miles ``--custom-reward-post-process-path`` hook. Returns ``(raw, rewards)``.

    Port of ``slime_bridge.reward_post_process.post_process_rewards``: builds a
    per-trace advantage against a leave-one-trajectory-out baseline derived from
    other trajectories sharing the same prompt group, so a Polar trajectory that
    fans out into multiple traces still counts as one gradient unit.  Honors the
    same ``rewards_normalization``, ``advantage_estimator``, and ``grpo_std_normalization``
    switches as Slime.
    """
    raw_rewards = [float(_extract_reward(sample, _reward_key(args))) for sample in samples]

    # --- Goal-Aligned Group-Relative Reward (v22) ---
    # GOAL: correct citations > fewer tokens > better answer.
    # If model says more than asked but citations are correct, DON'T penalize.
    #
    # Weight allocation (total = 10.0):
    #   TIER 1 - Citation correctness (50%):
    #     citation_recall     3.0  (gold chunks cited / total gold)
    #     citation_precision  2.0  (correct citations / total citations)
    #   TIER 2 - Answer quality (20%):
    #     answer_quality      2.0  (llm_judge, per-session)
    #   TIER 3 - Efficiency (10%, SOFT — don't over-penalize verbose):
    #     token_efficiency    0.5  (soft log decay, floor at 0.5)
    #     tool_efficiency     0.5  (soft log decay, floor at 0.5)
    #   TIER 4 - Exploration (10%):
    #     exploration         0.5  (group-relative, vespa distance)
    #     evidence_diversity  0.5  (group-relative, unique chunks)
    #   TIER 5 - Group signal (10%):
    #     shared_answer       0.5  (best answer, same for all)
    #     mi_reward           0.5  (unique contribution, currently 0)
    #
    # REMOVED (redundant, r>0.7 with kept metrics):
    #   - ndcg_share (redundant with citation_recall)
    #   - retrieval_quality (redundant with gold_evidence_coverage)
    #   - tool_evidence_utility (redundant with gold_evidence_coverage)
    #   - query_diversity (too low priority)
    #   - drill_down_distance (redundant with exploration)
    #   - answer_format, completion (zero variance, always 1.0)

    W_CIT_RECALL = 3.0
    W_CIT_PRECISION = 2.0
    W_ANSWER = 2.0
    W_TOKEN = 0.5
    W_TOOL = 0.5
    W_EXPL = 0.5
    W_DIV = 0.5
    W_SHARED = 0.5
    W_MI = 0.5
    TOTAL_W = (W_CIT_RECALL + W_CIT_PRECISION + W_ANSWER + W_TOKEN + W_TOOL
               + W_EXPL + W_DIV + W_SHARED + W_MI)  # 10.0

    _n = len(samples)
    if _n > 1:
        import math as _math

        # === SESSION-LEVEL AGGREGATION ===
        # Deduplicate traces by session_id. Normalization is across 8 unique
        # sessions, not N traces. This is critical for correct group-relative scoring.
        def _get_sid(idx):
            pm = getattr(samples[idx], "metadata", {})
            if not isinstance(pm, dict):
                pm = {}
            return (pm.get("polar") or {}).get("session_id") or f"trace_{idx}"

        session_order = []
        session_trace_indices = {}
        session_group_map = {}
        for idx in range(_n):
            sid = _get_sid(idx)
            if sid not in session_trace_indices:
                session_order.append(sid)
                session_trace_indices[sid] = []
                gidx = getattr(samples[idx], "group_index", None)
                if gidx is None:
                    pm = getattr(samples[idx], "metadata", {})
                    if isinstance(pm, dict):
                        gidx = pm.get("group_index")
                if gidx is None:
                    gidx = idx // 8
                session_group_map[sid] = gidx
            session_trace_indices[sid].append(idx)
        n_sessions = len(session_order)

        from collections import defaultdict
        group_sessions = defaultdict(list)
        for sid in session_order:
            group_sessions[session_group_map[sid]].append(sid)

        # === EXTRACT PER-SESSION METRICS ===
        # For each unique session, extract its raw metrics
        session_metrics = {}
        for sid in session_order:
            idx0 = session_trace_indices[sid][0]
            pm = getattr(samples[idx0], "metadata", {})
            if not isinstance(pm, dict):
                pm = {}
            tm = (pm.get("polar") or {}).get("trajectory_metadata") or {}
            ev = tm.get("evaluation") or {}
            ps = ev.get("per_scorer") or {}
            rf = ev.get("raw_flow") or {}
            gr = ev.get("group_reward") or {}

            # Aggregate chunks and calls across all traces of this session
            all_chunks = set()
            all_calls = []
            total_tokens = 0.0
            for idx in session_trace_indices[sid]:
                pm_i = getattr(samples[idx], "metadata", {})
                if not isinstance(pm_i, dict):
                    pm_i = {}
                tm_i = (pm_i.get("polar") or {}).get("trajectory_metadata") or {}
                ev_i = tm_i.get("evaluation") or {}
                rf_i = ev_i.get("raw_flow") or {}
                for c in (rf_i.get("retrieved_chunks") or []):
                    if isinstance(c, dict):
                        cid = c.get("docId") or c.get("doc_id")
                        if cid:
                            all_chunks.add(str(cid))
                for call in (rf_i.get("tool_calls") or []):
                    tool_name = str(call.get("tool", call.get("name", "")))
                    # Skip system/compaction calls that aren't real agent work
                    if any(skip in tool_name.lower() for skip in ("compaction", "compact", "system", "truncat")):
                        continue
                    all_calls.append(call)
                usage = rf_i.get("token_usage") or {}
                if isinstance(usage, dict) and usage:
                    out = float(usage.get("output", usage.get("output_tokens", usage.get("completion_tokens", 0))) or 0)
                    inp = float(usage.get("input", usage.get("input_tokens", usage.get("prompt_tokens", 0))) or 0)
                    total_tokens += out + 0.05 * inp
                else:
                    total_tokens += float(getattr(samples[idx], "response_length", 0) or 0)

            session_metrics[sid] = {
                # Citation metrics (the GOAL)
                "citation_recall": float(ps.get("citation_evidence_coverage", ps.get("gold_evidence_coverage", 0.0)) or 0.0),
                "citation_precision": float(ps.get("citation_accuracy", 0.0) or 0.0),
                "citation_relevance": float(ps.get("citation_relevance", 0.0) or 0.0),
                # Answer quality
                "answer_quality": float(ps.get("llm_judge", 0.0) or 0.0),
                # Efficiency (raw values, will be soft-normalized)
                "token_count": total_tokens,
                "tool_call_count": float(len(all_calls)),
                # Exploration
                "chunks_found": all_chunks,
                "tool_calls": all_calls,
                # Per-session raw scores (shared_answer will be computed below)
                "shared_answer_raw": float(gr.get("shared_answer_score", 0.0) or 0.0),
                "gate": float(gr.get("gate", 0.0) or 0.0),
                # Store per-scorer for shared_answer computation
                "_llm_judge": float(ps.get("llm_judge", 0.0) or 0.0),
                "_cit_acc": float(ps.get("citation_accuracy", 0.0) or 0.0),
                "_cit_rel": float(ps.get("citation_relevance", 0.0) or 0.0),
                "_cit_pres": float(ps.get("citation_presence", 0.0) or 0.0),
            }

        # === COMPUTE SHARED_ANSWER ACROSS ALL 8 SESSIONS (ONE GRPO GROUP) ===
        # Find the best session by answer quality, then use ITS score as
        # the shared_answer for ALL 8 sessions. This is correct because:
        # - Each rollout is independent (not sub-agents)
        # - shared_answer represents "the best achievable answer quality for this question"
        # - All 8 sessions get the same baseline, differentiation comes from relative metrics
        best_sid = None
        best_quality = -1.0
        for sid in session_order:
            m = session_metrics[sid]
            # Quality = weighted answer score (same formula as gateway)
            quality = 1.5 * m["_llm_judge"] + 1.0 * m["_cit_acc"] + 0.5 * m["_cit_rel"] + 0.5 * m["_cit_pres"]
            if quality > best_quality:
                best_quality = quality
                best_sid = sid

        if best_sid is not None:
            best_m = session_metrics[best_sid]
            w_llm, w_cit_acc, w_cit_rel, w_cit_pres = 1.5, 1.0, 0.5, 0.5
            total_w = w_llm + w_cit_acc + w_cit_rel + w_cit_pres
            group_shared_answer = (
                w_llm * best_m["_llm_judge"]
                + w_cit_acc * best_m["_cit_acc"]
                + w_cit_rel * best_m["_cit_rel"]
                + w_cit_pres * best_m["_cit_pres"]
            ) / total_w
        else:
            group_shared_answer = 0.0

        # Set the SAME shared_answer for ALL 8 sessions
        for sid in session_order:
            session_metrics[sid]["shared_answer"] = group_shared_answer

        # Gold chunks for this group
        all_gold_chunks = set()
        for sid in session_order:
            idx0 = session_trace_indices[sid][0]
            pm = getattr(samples[idx0], "metadata", {})
            if not isinstance(pm, dict):
                pm = {}
            tm = (pm.get("polar") or {}).get("trajectory_metadata") or {}
            ev = tm.get("evaluation") or {}
            for gid in (ev.get("gold_chunk_ids") or []):
                all_gold_chunks.add(str(gid))
            if not ev.get("gold_chunk_ids"):
                src_meta = pm
                for cid in (src_meta.get("chunk_ids") or []):
                    all_gold_chunks.add(str(cid))

        # === GROUP-RELATIVE NORMALIZATION ===
        # Min-max normalize across the 8 unique sessions for citation metrics.
        # This amplifies small within-group differences into full [0,1] spread.
        def _z01_sessions(values_by_sid, invert=False):
            """Min-max normalize PER-GROUP (8 sessions), not across all sessions."""
            result = {}
            for gidx, g_sids in group_sessions.items():
                g_values = {sid: values_by_sid[sid] for sid in g_sids if sid in values_by_sid}
                if not g_values:
                    continue
                if len(g_values) <= 1:
                    for sid in g_values:
                        result[sid] = 0.5
                    continue
                vals = list(g_values.values())
                v_min, v_max = min(vals), max(vals)
                if v_max - v_min < 1e-10:
                    for sid in g_values:
                        result[sid] = 0.5
                    continue
                if invert:
                    for sid, v in g_values.items():
                        result[sid] = (v_max - v) / (v_max - v_min)
                else:
                    for sid, v in g_values.items():
                        result[sid] = (v - v_min) / (v_max - v_min)
            for sid in values_by_sid:
                if sid not in result:
                    result[sid] = 0.5
            return result

        # Citation metrics: group-relative min-max (THE CORE DIFFERENTIATOR)
        cit_recall_raw = {sid: m["citation_recall"] for sid, m in session_metrics.items()}
        cit_precision_raw = {sid: m["citation_precision"] for sid, m in session_metrics.items()}
        cit_recall_scores = _z01_sessions(cit_recall_raw)
        cit_precision_scores = _z01_sessions(cit_precision_raw)

        # Answer quality: group-relative
        answer_raw = {sid: m["answer_quality"] for sid, m in session_metrics.items()}
        answer_scores = _z01_sessions(answer_raw)

        # === SOFT EFFICIENCY (don't over-penalize verbose correct answers) ===
        # If model says more than asked but citations are correct, minimal penalty.
        # Floor at 0.5 so even extreme verbosity only loses 50% of efficiency score.
        def _soft_efficiency(my_value, all_values, floor=0.5, my_sid=None):
            """Soft efficiency computed PER-GROUP when possible."""
            if my_sid and my_sid in session_group_map:
                gidx = session_group_map[my_sid]
                g_sids = group_sessions.get(gidx, [])
                g_vals = []
                for gs in g_sids:
                    if gs in token_counts if 'token_counts' in dir() else True:
                        pass
                # Use group's values if available
                if hasattr(all_values, 'get'):
                    g_vals = [all_values.get(gs, my_value) for gs in g_sids]
                    if g_vals:
                        all_values = g_vals
            if not all_values:
                return 1.0
            sorted_vals = sorted(all_values)
            median = sorted_vals[len(sorted_vals) // 2]
            if my_value <= median:
                return 1.0
            ratio = my_value / max(median, 1e-8)
            return max(floor, 1.0 - 0.15 * _math.log2(ratio))

        token_counts = {sid: m["token_count"] for sid, m in session_metrics.items()}
        tool_counts = {sid: m["tool_call_count"] for sid, m in session_metrics.items()}
        token_eff_scores = {sid: _soft_efficiency(v, list(token_counts.values())) for sid, v in token_counts.items()}
        tool_eff_scores = {sid: _soft_efficiency(v, list(tool_counts.values())) for sid, v in tool_counts.items()}

        # === EXPLORATION (group-relative) ===
        # Distance to first gold chunk via vespaSearch
        session_expl = {}
        for sid in session_order:
            calls = session_metrics[sid]["tool_calls"]
            sorted_calls = sorted(calls, key=lambda c: c.get("startedAt") or c.get("started_at") or "") if calls else []
            n_vespa = sum(1 for c in sorted_calls if c.get("tool") == "vespaSearch")
            expl = 1.0
            for j, c in enumerate(sorted_calls):
                if c.get("tool") == "vespaSearch":
                    retrieved = c.get("retrieved_chunks") or c.get("results") or []
                    for r in retrieved:
                        if isinstance(r, dict):
                            did = str(r.get("docId") or r.get("doc_id") or "")
                            if did in all_gold_chunks:
                                expl = min(expl, (j + 1) / max(n_vespa, 1))
                                break
            session_expl[sid] = expl
        expl_scores = _z01_sessions(session_expl, invert=True)

        # Evidence diversity: unique chunks per session relative to group
        all_chunks_union = set()
        for sid in session_order:
            all_chunks_union.update(session_metrics[sid]["chunks_found"])
        div_scores = {}
        for sid in session_order:
            others = set()
            for other_sid in session_order:
                if other_sid != sid:
                    others.update(session_metrics[other_sid]["chunks_found"])
            unique = session_metrics[sid]["chunks_found"] - others
            div_scores[sid] = len(unique) / max(len(all_chunks_union), 1) if all_chunks_union else 0.0

        # === MI REWARD (per-session, chunk-level) ===
        def _compute_mi_for_session(sid):
            src_meta = getattr(samples[session_trace_indices[sid][0]], "metadata", {})
            if not isinstance(src_meta, dict):
                src_meta = {}
            chunk_gold = set(str(c) for c in (src_meta.get("chunk_ids") or []))
            if not chunk_gold:
                return 0.0
            # Union of all sessions' chunks
            all_union = set()
            for s in session_order:
                all_union.update(session_metrics[s]["chunks_found"])
            full_cov = len(all_union & chunk_gold) / len(chunk_gold)
            # Coverage without this session
            without = set()
            for s in session_order:
                if s != sid:
                    without.update(session_metrics[s]["chunks_found"])
            cov_without = len(without & chunk_gold) / len(chunk_gold)
            return max(0.0, (full_cov - cov_without) * 0.20)

        mi_scores = {sid: _compute_mi_for_session(sid) for sid in session_order}

        # === COMPUTE FINAL REWARD PER SESSION ===
        session_final_rewards = {}
        for sid in session_order:
            m = session_metrics[sid]
            gate = m["gate"]
            if gate == 0.0:
                session_final_rewards[sid] = 0.0
                continue

            weighted = (
                W_CIT_RECALL * cit_recall_scores[sid]
                + W_CIT_PRECISION * cit_precision_scores[sid]
                + W_ANSWER * answer_scores[sid]
                + W_TOKEN * token_eff_scores[sid]
                + W_TOOL * tool_eff_scores[sid]
                + W_EXPL * expl_scores[sid]
                + W_DIV * div_scores[sid]
                + W_SHARED * m["shared_answer"]
                + W_MI * mi_scores[sid]
            )
            session_final_rewards[sid] = weighted / TOTAL_W

        # Map session-level rewards back to traces
        for i in range(_n):
            sid = _get_sid(i)
            raw_rewards[i] = session_final_rewards.get(sid, 0.0)

        # Log per-session breakdown for debugging
        for sid in session_order:
            logger.info(
                "Reward session %s: final=%.4f | cit_recall=%.3f cit_prec=%.3f answer=%.3f "
                "tok_eff=%.3f tool_eff=%.3f expl=%.3f div=%.3f shared=%.3f mi=%.3f",
                sid[:16], session_final_rewards[sid],
                cit_recall_scores[sid], cit_precision_scores[sid], answer_scores[sid],
                token_eff_scores[sid], tool_eff_scores[sid], expl_scores[sid],
                div_scores[sid], session_metrics[sid]["shared_answer"], mi_scores[sid],
            )

    estimator = getattr(args, "advantage_estimator", None)
    if estimator not in ("grpo", "gspo", "reinforce_plus_plus_baseline"):
        return raw_rewards, list(raw_rewards)

    std_norm = estimator in ("grpo", "gspo") and bool(getattr(args, "grpo_std_normalization", False))

    traj_sample_indices: dict[Any, list[int]] = {}
    traj_valid_rewards: dict[Any, list[float]] = {}
    traj_failed: dict[Any, bool] = {}
    group_keys: dict[Any, list[Any]] = {}

    for i, sample in enumerate(samples):
        group_idx, key = _trajectory_key(sample, i)
        if key not in traj_sample_indices:
            traj_sample_indices[key] = []
            traj_valid_rewards[key] = []
            traj_failed[key] = False
            group_keys.setdefault(group_idx, []).append(key)
        traj_sample_indices[key].append(i)
        if _is_failed_trajectory(sample):
            traj_failed[key] = True
        elif _has_trainable_tokens(sample):
            traj_valid_rewards[key].append(raw_rewards[i])

    normalized_by_sample = [1e-8] * len(samples)
    for keys in group_keys.values():
        valid_keys = [key for key in keys if not traj_failed[key] and traj_valid_rewards[key]]
        traj_mean = {
            key: sum(traj_valid_rewards[key]) / len(traj_valid_rewards[key]) for key in valid_keys
        }
        traj_cost = {
            key: trajectory_token_cost(samples, traj_sample_indices[key])
            for key in valid_keys
        }
        # Group-relative shaping now done in weighted-average above.
        # shape_trajectory_means_multi disabled to prevent double-counting.
        shaped_mean = dict(traj_mean)

        for key in keys:
            if key not in shaped_mean:
                continue
            other_means = [
                shaped_mean[other_key]
                for other_key in valid_keys
                if other_key != key
            ]
            baseline = sum(other_means) / len(other_means) if other_means else 0.0
            scale = _loo_scale(other_means) if std_norm else 1.0
            for sample_index in traj_sample_indices[key]:
                normalized_by_sample[sample_index] = (
                    shaped_mean[key] - baseline
                ) / scale

    normalized_by_sample = [r if abs(r) > 1e-10 else 1e-8 for r in normalized_by_sample]
    _dump_group_rewards(args, samples, raw_rewards, normalized_by_sample)
    return raw_rewards, normalized_by_sample


def _trajectory_key(sample: Any, sample_position: int) -> tuple[Any, Any]:
    group_idx = _key_value(getattr(sample, "group_index", None), -1)
    traj_idx = getattr(sample, "rollout_id", None)
    if traj_idx is None:
        traj_idx = getattr(sample, "index", None)
    return group_idx, (group_idx, _key_value(traj_idx, sample_position))


def _key_value(value: Any, default: Any) -> Any:
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return str(value)


def _loo_scale(other_means: list[float]) -> float:
    if len(other_means) <= 1:
        return 1.0
    return statistics.stdev(other_means) + 1e-6


def _has_trainable_tokens(sample: Any) -> bool:
    if bool(getattr(sample, "remove_sample", False)):
        return False
    loss_mask = getattr(sample, "loss_mask", None)
    if loss_mask is None:
        return int(getattr(sample, "response_length", 0) or 0) > 0
    return any(int(value) != 0 for value in loss_mask)


def _is_failed_trajectory(sample: Any) -> bool:
    """True if the sample's status marks it as agent ERROR or TIMEOUT."""
    status = getattr(sample, "status", None)
    name = getattr(status, "name", None) or str(status).rsplit(".", 1)[-1]
    return name.upper() in ("FAILED", "ABORTED")


__all__ = [
    "custom_rm",
    "compute_reward",
    "reward_func",
    "post_process_rewards",
    "_extract_reward",
    "_trajectory_key",
    "_key_value",
    "_loo_scale",
    "_has_trainable_tokens",
    "_is_failed_trajectory",
]
