"""Group-relative trajectory shaping — clean weighted-average design.

Every score is normalized to [0, 1].
Z-normalized components map [-1,1] -> [0,1] via (z + 1) / 2.
When all sessions are equal -> score = 0.5 for all -> cancels in GRPO.
"""

from __future__ import annotations

import math
import os
from typing import Any

import logging

logger = logging.getLogger(__name__)


def efficiency_weight(args: Any) -> float:
    value = getattr(args, "polar_group_relative_token_weight", None)
    if value is None:
        value = os.environ.get("POLAR_GROUP_RELATIVE_TOKEN_WEIGHT", "0.0")
    return max(0.0, float(value))


def trajectory_token_cost(samples: list[Any], indices: list[int]) -> float:
    """Read authoritative flow usage, falling back to train-sequence lengths."""
    input_weight = float(os.environ.get("POLAR_GROUP_RELATIVE_INPUT_WEIGHT", "0.05"))
    for index in indices:
        metadata = getattr(samples[index], "metadata", {})
        if not isinstance(metadata, dict):
            continue
        evaluation = (
            ((metadata.get("polar") or {}).get("trajectory_metadata") or {})
            .get("evaluation") or {}
        )
        usage = ((evaluation.get("raw_flow") or {}).get("token_usage") or {})
        if not isinstance(usage, dict) or not usage:
            continue
        output = _numeric(usage, "output", "output_tokens", "completion_tokens")
        input_tokens = _numeric(usage, "input", "input_tokens", "prompt_tokens")
        if output > 0.0 or input_tokens > 0.0:
            return output + input_weight * input_tokens
    return float(sum(
        max(0, int(getattr(samples[index], "response_length", 0) or 0))
        for index in indices
    ))


# ─── Group-relative dimensions ───────────────────────────────────────────
#
# Each dimension produces a score in [0, 1].
# Z-normalized: (z + 1) / 2 maps [-1,1] -> [0,1].
# When all sessions equal -> 0.5 for all -> no GRPO differentiation.
#
# Weights reflect importance hierarchy:
#   exploration (1.0): finding gold doc fast is the primary search skill
#   drill_down  (0.8): drilling to gold chunk is the refinement skill
#   token_cost  (0.5): token efficiency matters but less than search quality

DIMENSION_WEIGHTS = {
    "token_cost": 0.5,
    "exploration_distance": 1.0,
    "drill_down_distance": 0.8,
}

# For these dimensions, LOWER raw value = BETTER.
INVERT = {
    "token_cost": True,
    "exploration_distance": True,
    "drill_down_distance": True,
}


def extract_group_metrics(samples, traj_sample_indices, valid_keys):
    """Extract per-trajectory metrics for group-relative normalization."""
    metrics = {}

    for key in valid_keys:
        indices = traj_sample_indices[key]
        token_cost = trajectory_token_cost(samples, indices)
        expl_dist = 1.0
        drill_dist = 1.0

        for idx in indices:
            sample = samples[idx]
            polar_meta = getattr(sample, "metadata", {})
            if not isinstance(polar_meta, dict):
                continue
            traj_meta = (polar_meta.get("polar") or {}).get("trajectory_metadata") or {}
            ev = traj_meta.get("evaluation") or {}
            raw_flow = ev.get("raw_flow") or {}

            # Try stored retrieval ranking metadata first
            rr_meta = ev.get("retrieval_ranking") or {}
            if rr_meta:
                if "exploration_distance" in rr_meta:
                    expl_dist = min(expl_dist, float(rr_meta["exploration_distance"]))
                if "drill_down_distance" in rr_meta:
                    drill_dist = min(drill_dist, float(rr_meta["drill_down_distance"]))
                continue

            # Fallback: compute from raw flow tool calls
            calls = raw_flow.get("tool_calls") or []
            if not calls:
                continue

            gold_doc_ids = set()
            gold_chunk_ids = set()
            for gid in (ev.get("expected_doc_ids") or []):
                gold_doc_ids.add(str(gid))
            for cid in (ev.get("gold_chunk_ids") or []):
                gold_chunk_ids.add(str(cid))
            for did in (ev.get("expected_doc_ids") or []):
                gold_doc_ids.add(str(did))

            started_key = "startedAt" if "startedAt" in calls[0] else "started_at"
            sorted_calls = sorted(calls, key=lambda c: c.get(started_key) or "")
            n_vespa = sum(1 for c in sorted_calls if c.get("tool") == "vespaSearch")
            n_drill = sum(1 for c in sorted_calls if c.get("tool") in ("searchWithinDoc", "getChunks", "getDocument"))

            for j, c in enumerate(sorted_calls):
                if c.get("tool") == "vespaSearch":
                    retrieved = c.get("retrieved_chunks") or c.get("results") or []
                    for r in retrieved:
                        if isinstance(r, dict):
                            did = str(r.get("docId") or r.get("doc_id") or "")
                            if did in gold_doc_ids:
                                expl_dist = min(expl_dist, (j + 1) / max(n_vespa, 1))
                                break

            for j, c in enumerate(sorted_calls):
                if c.get("tool") in ("searchWithinDoc", "getChunks", "getDocument"):
                    retrieved = c.get("retrieved_chunks") or c.get("results") or []
                    for r in retrieved:
                        if isinstance(r, dict):
                            cid = str(r.get("chunkId") or r.get("chunk_id") or r.get("docId") or "")
                            if cid in gold_chunk_ids or cid in gold_doc_ids:
                                drill_dist = min(drill_dist, (j + 1) / max(n_drill, 1))
                                break

        metrics[key] = {
            "token_cost": token_cost,
            "exploration_distance": expl_dist,
            "drill_down_distance": drill_dist,
        }

    return metrics


def z_normalize_01(values, invert=False):
    """Z-normalize to [0, 1] range. Invert: lower=better.

    When all values equal -> returns [0.5] * n (neutral, cancels in GRPO).
    """
    n = len(values)
    if n <= 1:
        return [0.5] * n
    mean = sum(values) / n
    variance = sum((v - mean) ** 2 for v in values) / n
    std = math.sqrt(variance)
    if std < 1e-10:
        return [0.5] * n
    result = []
    for v in values:
        z = (v - mean) / std
        if invert:
            z = -z
        z = max(-1.0, min(1.0, z))
        result.append((z + 1.0) / 2.0)
    return result


def shape_trajectory_means(means, costs, *, weight):
    """Legacy single-dimension Pareto shaper (backward compat)."""
    if weight <= 0.0 or len(means) < 2:
        return dict(means)
    shaped = {}
    denominator = len(means) - 1
    for key, quality in means.items():
        wins = sum(
            1 for other, other_quality in means.items()
            if other != key
            and quality >= other_quality
            and costs.get(key, 0.0) < costs.get(other, 0.0)
        )
        efficiency = wins / denominator
        bounded_quality = max(0.0, min(1.0, quality))
        shaped[key] = quality + weight * (1.0 - bounded_quality) * efficiency
    return shaped


def shape_trajectory_means_multi(
    means, samples, traj_sample_indices, valid_keys, *, enabled=True
):
    """Multi-dimensional group-relative shaping.

    Each dimension is z-normalized to [0, 1] and added to the reward.
    When all sessions are equal -> +0.5 per dimension (neutral).
    Better-than-average -> >0.5, worse -> <0.5.
    """
    shaped = dict(means)
    if not enabled or len(valid_keys) < 2:
        return shaped

    metrics = extract_group_metrics(samples, traj_sample_indices, valid_keys)

    for dim_name, dim_weight in DIMENSION_WEIGHTS.items():
        if dim_weight <= 0:
            continue
        raw_values = [metrics[k][dim_name] for k in valid_keys]
        invert = INVERT.get(dim_name, False)
        scores_01 = z_normalize_01(raw_values, invert=invert)
        for idx, key in enumerate(valid_keys):
            contribution = dim_weight * scores_01[idx]
            shaped[key] = shaped.get(key, 0.0) + contribution
        logger.info(
            "Group-relative %s: weight=%.2f scores=[%s] raw=[%s]",
            dim_name, dim_weight,
            ", ".join("%.3f" % s for s in scores_01),
            ", ".join("%.1f" % v for v in raw_values),
        )
    return shaped


def _numeric(values, *keys):
    for key in keys:
        value = values.get(key)
        if isinstance(value, (int, float)):
            return max(0.0, float(value))
    return 0.0


__all__ = [
    "efficiency_weight",
    "trajectory_token_cost",
    "shape_trajectory_means",
    "shape_trajectory_means_multi",
    "extract_group_metrics",
    "z_normalize_01",
    "DIMENSION_WEIGHTS",
]
