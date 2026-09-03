"""Task-level reward shaping over a completed rollout group."""

from __future__ import annotations

from typing import Any

from polar.rollout.models import GroupRewardSpec, SessionResult, SessionStatus


def apply_group_reward(
    results: list[SessionResult],
    spec: GroupRewardSpec | None,
) -> list[SessionResult]:
    """Apply group-level reward shaping once all peers are available."""
    if spec is None or spec.weight <= 0.0 or len(results) < 2:
        return list(results)
    if spec.strategy == "quality_conditioned_token_efficiency":
        return _apply_quality_conditioned_efficiency(results, spec)
    if spec.strategy == "mutual_information_evidence":
        return _apply_mutual_information_evidence(results, spec)
    if spec.strategy == "best_answer_and_mi":
        return _apply_best_answer_and_mi(results, spec)
    raise ValueError(f"unsupported group reward strategy {spec.strategy!r}")


def _apply_mutual_information_evidence(
    results: list[SessionResult],
    spec: GroupRewardSpec,
) -> list[SessionResult]:
    """Issue 33: Credit sessions for unique gold evidence contribution.

    MI_i = group_coverage_with_all - group_coverage_without_i
    Sessions that found unique gold chunks get a bonus proportional to
    their marginal contribution to the group's evidence coverage.
    """
    session_chunks = []
    gold_chunks: set[str] = set()

    for result in results:
        ev = (result.trajectory.metadata.get("evaluation") or {})
        raw_flow = ev.get("raw_flow") or {}
        chunks = set()
        for c in (raw_flow.get("retrieved_chunks") or []):
            if isinstance(c, dict):
                cid = c.get("docId") or c.get("doc_id")
                if cid:
                    chunks.add(str(cid))
        session_chunks.append(chunks)
        for gid in (ev.get("gold_chunk_ids") or []):
            if gid:
                gold_chunks.add(str(gid))
        # Also check expected_doc_ids
        for did in (ev.get("expected_doc_ids") or []):
            if did:
                gold_chunks.add(str(did))

    if not gold_chunks:
        return list(results)

    all_chunks = set()
    for chunks in session_chunks:
        all_chunks.update(chunks)
    full_coverage = len(all_chunks & gold_chunks) / len(gold_chunks)

    output = list(results)
    for i, result in enumerate(results):
        without_i = set()
        for j, chunks in enumerate(session_chunks):
            if j != i:
                without_i.update(chunks)
        coverage_without_i = len(without_i & gold_chunks) / len(gold_chunks)
        mi_contribution = full_coverage - coverage_without_i

        base_reward = _trajectory_reward(result)
        if base_reward is None:
            base_reward = 0.0
        shaped = base_reward + spec.weight * mi_contribution
        output[i] = _replace_reward(
            results[i],
            shaped,
            {
                "strategy": "mutual_information_evidence",
                "base_reward": base_reward,
                "shaped_reward": shaped,
                "mi_contribution": mi_contribution,
                "full_coverage": full_coverage,
                "coverage_without_i": coverage_without_i,
                "weight": spec.weight,
            },
        )
    return output


def _apply_quality_conditioned_efficiency(
    results: list[SessionResult],
    spec: GroupRewardSpec,
) -> list[SessionResult]:
    """Original quality-conditioned token efficiency shaping."""
    candidates: dict[int, tuple[float, float]] = {}
    for index, result in enumerate(results):
        reward = _trajectory_reward(result)
        if reward is None or result.status != SessionStatus.COMPLETED:
            continue
        candidates[index] = (reward, _token_cost(result, spec.input_weight))
    if len(candidates) < 2:
        return list(results)

    denominator = len(candidates) - 1
    output = list(results)
    for index, (quality, cost) in candidates.items():
        wins = sum(
            1
            for other_index, (other_quality, other_cost) in candidates.items()
            if other_index != index
            and quality >= other_quality
            and cost < other_cost
        )
        efficiency = wins / denominator
        bounded_quality = max(0.0, min(1.0, quality))
        shaped = quality + spec.weight * (1.0 - bounded_quality) * efficiency
        output[index] = _replace_reward(
            results[index],
            shaped,
            {
                "strategy": spec.strategy,
                "base_reward": quality,
                "shaped_reward": shaped,
                "token_cost": cost,
                "efficiency": efficiency,
                "weight": spec.weight,
                "input_weight": spec.input_weight,
            },
        )
    return output

    candidates: dict[int, tuple[float, float]] = {}
    for index, result in enumerate(results):
        reward = _trajectory_reward(result)
        if reward is None or result.status != SessionStatus.COMPLETED:
            continue
        candidates[index] = (reward, _token_cost(result, spec.input_weight))
    if len(candidates) < 2:
        return list(results)

    denominator = len(candidates) - 1
    output = list(results)
    for index, (quality, cost) in candidates.items():
        wins = sum(
            1
            for other_index, (other_quality, other_cost) in candidates.items()
            if other_index != index
            and quality >= other_quality
            and cost < other_cost
        )
        efficiency = wins / denominator
        bounded_quality = max(0.0, min(1.0, quality))
        shaped = quality + spec.weight * (1.0 - bounded_quality) * efficiency
        output[index] = _replace_reward(
            results[index],
            shaped,
            {
                "strategy": spec.strategy,
                "base_reward": quality,
                "shaped_reward": shaped,
                "token_cost": cost,
                "efficiency": efficiency,
                "weight": spec.weight,
                "input_weight": spec.input_weight,
            },
        )
    return output


def _trajectory_reward(result: SessionResult) -> float | None:
    evaluation = result.trajectory.metadata.get("evaluation") or {}
    reward = evaluation.get("outcome_reward")
    if not isinstance(reward, (int, float)) and result.trajectory.traces:
        reward = result.trajectory.traces[-1].reward
    return float(reward) if isinstance(reward, (int, float)) else None


def _token_cost(result: SessionResult, input_weight: float) -> float:
    evaluation = result.trajectory.metadata.get("evaluation") or {}
    raw_flow = evaluation.get("raw_flow") or {}
    usage = raw_flow.get("token_usage") or {}
    if isinstance(usage, dict):
        output = _numeric(usage, "output", "output_tokens", "completion_tokens")
        input_tokens = _numeric(usage, "input", "input_tokens", "prompt_tokens")
        if output > 0.0 or input_tokens > 0.0:
            return output + input_weight * input_tokens
    return float(sum(
        len(trace.response_ids)
        for trace in result.trajectory.traces
    ))


def _replace_reward(
    result: SessionResult,
    reward: float,
    audit: dict[str, Any],
) -> SessionResult:
    traces = [trace.model_copy(update={"reward": reward}) for trace in result.trajectory.traces]
    metadata = dict(result.trajectory.metadata)
    evaluation = dict(metadata.get("evaluation") or {})
    evaluation["outcome_reward"] = reward
    evaluation["group_reward"] = audit
    metadata["evaluation"] = evaluation
    trajectory = result.trajectory.model_copy(
        update={"traces": traces, "metadata": metadata}
    )
    return result.model_copy(update={"trajectory": trajectory})


def _numeric(values: dict[str, Any], *keys: str) -> float:
    for key in keys:
        value = values.get(key)
        if isinstance(value, (int, float)):
            return max(0.0, float(value))
    return 0.0


__all__ = ["apply_group_reward"]


def _apply_best_answer_and_mi(
    results: list[SessionResult],
    spec: GroupRewardSpec,
) -> list[SessionResult]:
    """Three-level reward: gate + shared answer quality + MI differentiation.

    Level 1 (gate):     session produced output → gate=1, else gate=0
    Level 2 (shared):   best session answer score (llm_judge + citations) shared by all
    Level 3 (MI):       unique gold chunk contribution per session

    Final: adjusted_i = gate_i * (shared_answer + mi_reward_i)
    """
    # --- Level 2: Find best session by answer quality, not outcome_reward ---
    # The evaluator composite can be 1.0 for all sessions (high completion/format
    # scores), so selecting by outcome_reward picks the first session which may
    # be the worst. Instead, select by llm_judge + citation scores.
    best_idx = 0
    best_quality = -1.0
    for i, result in enumerate(results):
        ev_i = (result.trajectory.metadata.get("evaluation") or {})
        ps_i = ev_i.get("per_scorer") or {}
        llm = float(ps_i.get("llm_judge", 0.0) or 0.0)
        cit_acc = float(ps_i.get("citation_accuracy", 0.0) or 0.0)
        cit_rel = float(ps_i.get("citation_relevance", 0.0) or 0.0)
        cit_pres = float(ps_i.get("citation_presence", 0.0) or 0.0)
        quality = 1.5 * llm + 1.0 * cit_acc + 0.5 * cit_rel + 0.5 * cit_pres
        if quality > best_quality:
            best_quality = quality
            best_idx = i

    best_ev = (results[best_idx].trajectory.metadata.get("evaluation") or {})
    best_ps = best_ev.get("per_scorer") or best_ev.get("per_scorer_mean") or {}

    llm_judge = float(best_ps.get("llm_judge", 0.0) or 0.0)
    cit_acc = float(best_ps.get("citation_accuracy", 0.0) or 0.0)
    cit_rel = float(best_ps.get("citation_relevance", 0.0) or 0.0)
    cit_pres = float(best_ps.get("citation_presence", 0.0) or 0.0)

    w_llm, w_cit_acc, w_cit_rel, w_cit_pres = 1.5, 1.0, 0.5, 0.5
    total_w = w_llm + w_cit_acc + w_cit_rel + w_cit_pres
    shared_answer = (w_llm * llm_judge + w_cit_acc * cit_acc + w_cit_rel * cit_rel + w_cit_pres * cit_pres) / total_w

    # --- Level 3: MI evidence per session ---
    session_chunks: list[set[str]] = []
    gold_chunks: set[str] = set()

    for result in results:
        ev = (result.trajectory.metadata.get("evaluation") or {})
        raw_flow = ev.get("raw_flow") or {}
        chunks: set[str] = set()
        for c in (raw_flow.get("retrieved_chunks") or []):
            if isinstance(c, dict):
                did = c.get("docId") or c.get("doc_id")
                ch = c.get("chunk") or c.get("chunk_index") or c.get("chunk_id")
                if did and ch is not None:
                    # Chunk-level ID for proper MI differentiation
                    chunks.add(f"{did}#{ch}")
                elif did:
                    # Fallback to doc-level if chunk number unavailable
                    chunks.add(str(did))
        session_chunks.append(chunks)
        # Gold chunks: try evaluation metadata first
        for gid in (ev.get("gold_chunk_ids") or []):
            if gid:
                gold_chunks.add(str(gid))
        for did in (ev.get("expected_doc_ids") or []):
            if did:
                gold_chunks.add(str(did))
        # Fallback 1: check task_metadata
        if not gold_chunks:
            tm = (result.trajectory.metadata.get("task_metadata") or {})
            for did in (tm.get("doc_ids") or []):
                if did:
                    gold_chunks.add(str(did))
            for cid in (tm.get("chunk_ids") or []):
                if cid:
                    gold_chunks.add(str(cid))
        # Fallback 2: check source_metadata (training data passed through adapter)
        if not gold_chunks:
            sm = (result.trajectory.metadata.get("source_metadata") or {})
            if not sm:
                sm = (result.trajectory.metadata.get("metadata") or {}).get("source_metadata") or {}
            for did in (sm.get("doc_ids") or []):
                if did:
                    gold_chunks.add(str(did))
            for cid in (sm.get("chunk_ids") or []):
                if cid:
                    gold_chunks.add(str(cid))

    all_union: set[str] = set()
    for chunks in session_chunks:
        all_union.update(chunks)

    mi_rewards = [0.0] * len(results)
    if gold_chunks:
        full_coverage = len(all_union & gold_chunks) / len(gold_chunks)
        for i in range(len(results)):
            without_i: set[str] = set()
            for j, chunks in enumerate(session_chunks):
                if j != i:
                    without_i.update(chunks)
            coverage_without_i = len(without_i & gold_chunks) / len(gold_chunks)
            mi_rewards[i] = (full_coverage - coverage_without_i) * 0.20

    # --- Merge: gate * (shared_answer + mi) ---
    output = list(results)
    for i, result in enumerate(results):
        base = _trajectory_reward(result) or 0.0

        # Gate: did this session produce any output?
        traj = result.trajectory
        has_output = len(traj.traces) > 0

        if has_output:
            shaped = spec.weight * shared_answer + mi_rewards[i]
        else:
            shaped = 0.0

        output[i] = _replace_reward(
            results[i],
            shaped,
            {
                "strategy": "best_answer_and_mi",
                "base_reward": base,
                "gate": 1.0 if has_output else 0.0,
                "shared_answer_score": shared_answer if has_output else 0.0,
                "mi_reward": mi_rewards[i],
                "best_session_idx": best_idx,
                "llm_judge_best": llm_judge,
                "citation_accuracy_best": cit_acc,
                "citation_relevance_best": cit_rel,
                "citation_presence_best": cit_pres,
                "weight": spec.weight,
            },
        )
    return output
