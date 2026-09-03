from __future__ import annotations

import pytest

from polar.agent.models import AgentSpec
from polar.rollout.group_reward import apply_group_reward
from polar.rollout.manager import RolloutManager
from polar.rollout.models import (
    GroupRewardSpec,
    SessionResult,
    SessionStatus,
    TaskRequest,
)
from polar.trajectory.models import Trace, Trajectory


def _result(
    session_id: str,
    *,
    reward: float,
    output_tokens: int,
    input_tokens: int = 0,
    traces: int = 1,
) -> SessionResult:
    return SessionResult(
        session_id=session_id,
        task_id="task-1",
        status=SessionStatus.COMPLETED,
        trajectory=Trajectory(
            status="COMPLETED",
            traces=[
                Trace(response_ids=[1, 2], loss_mask=[1, 1], reward=reward)
                for _ in range(traces)
            ],
            metadata={
                "evaluation": {
                    "outcome_reward": reward,
                    "raw_flow": {
                        "token_usage": {
                            "input": input_tokens,
                            "output": output_tokens,
                        }
                    },
                }
            },
        ),
    )


def test_task_request_accepts_typed_group_reward() -> None:
    assert RolloutManager is not None
    request = TaskRequest(
        task_id="task-1",
        instruction="question",
        num_samples=8,
        agent=AgentSpec(import_path="pkg:Agent"),
        group_reward={
            "strategy": "quality_conditioned_token_efficiency",
            "weight": 0.03,
            "input_weight": 0.02,
        },
    )
    assert request.group_reward is not None
    assert request.group_reward.weight == 0.03
    assert request.model_dump(mode="json")["group_reward"]["input_weight"] == 0.02


def test_equal_quality_shorter_trajectory_receives_bounded_bonus() -> None:
    results = [
        _result("short", reward=0.8, output_tokens=100, traces=2),
        _result("long", reward=0.8, output_tokens=200),
    ]
    shaped = apply_group_reward(
        results,
        GroupRewardSpec(weight=0.03, input_weight=0.02),
    )
    assert shaped[0].trajectory.traces[0].reward == pytest.approx(0.806)
    assert shaped[0].trajectory.traces[1].reward == pytest.approx(0.806)
    assert shaped[1].trajectory.traces[0].reward == pytest.approx(0.8)
    audit = shaped[0].trajectory.metadata["evaluation"]["group_reward"]
    assert audit["base_reward"] == 0.8
    assert audit["efficiency"] == 1.0
    assert audit["token_cost"] == 100.0


def test_shorter_wrong_trajectory_gets_no_efficiency_bonus() -> None:
    results = [
        _result("short-wrong", reward=0.2, output_tokens=10),
        _result("long-correct", reward=0.8, output_tokens=100),
    ]
    shaped = apply_group_reward(results, GroupRewardSpec(weight=0.03))
    assert shaped[0].trajectory.traces[0].reward == pytest.approx(0.2)
    assert shaped[1].trajectory.traces[0].reward == pytest.approx(0.8)


def test_input_tokens_have_configured_small_cost() -> None:
    results = [
        _result("a", reward=0.7, output_tokens=100, input_tokens=1000),
        _result("b", reward=0.7, output_tokens=200, input_tokens=1000),
    ]
    shaped = apply_group_reward(
        results,
        GroupRewardSpec(weight=0.03, input_weight=0.02),
    )
    audit = shaped[0].trajectory.metadata["evaluation"]["group_reward"]
    assert audit["token_cost"] == 120.0
