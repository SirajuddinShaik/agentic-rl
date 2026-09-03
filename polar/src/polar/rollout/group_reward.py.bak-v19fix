"""Task-level reward shaping over a completed rollout group."""

from __future__ import annotations

from typing import Any

from polar.rollout.models import GroupRewardSpec, SessionResult, SessionStatus


def apply_group_reward(
    results: list[SessionResult],
    spec: GroupRewardSpec | None,
) -> list[SessionResult]:
    """Apply quality-conditioned token efficiency once all peers are available."""
    if spec is None or spec.weight <= 0.0 or len(results) < 2:
        return list(results)
    if spec.strategy != "quality_conditioned_token_efficiency":
        raise ValueError(f"unsupported group reward strategy {spec.strategy!r}")

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
