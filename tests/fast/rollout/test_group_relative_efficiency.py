from __future__ import annotations

from types import SimpleNamespace

import pytest

from miles.rollout.group_relative_efficiency import (
    shape_trajectory_means,
    trajectory_token_cost,
)


def _sample(*, output: int, input_tokens: int = 0, response_length: int = 1):
    return SimpleNamespace(
        response_length=response_length,
        metadata={
            "polar": {
                "trajectory_metadata": {
                    "evaluation": {
                        "raw_flow": {
                            "token_usage": {"input": input_tokens, "output": output}
                        }
                    }
                }
            }
        },
    )


def test_token_cost_uses_flow_usage_once_for_multi_trace_trajectory(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("POLAR_GROUP_RELATIVE_INPUT_WEIGHT", "0.1")
    samples = [_sample(output=100, input_tokens=200), _sample(output=100, input_tokens=200)]
    assert trajectory_token_cost(samples, [0, 1]) == 120.0


def test_relative_efficiency_only_rewards_no_worse_candidate() -> None:
    shaped = shape_trajectory_means(
        {"short-wrong": 0.2, "long-correct": 0.8, "short-correct": 0.8},
        {"short-wrong": 10.0, "long-correct": 100.0, "short-correct": 20.0},
        weight=0.1,
    )
    assert shaped["short-wrong"] == 0.2
    assert shaped["long-correct"] == 0.8
    assert shaped["short-correct"] == pytest.approx(0.81)
