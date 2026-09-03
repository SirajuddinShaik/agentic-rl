#!/usr/bin/env python3
"""Contract test for Polar per-request traces converted to Miles samples."""

from __future__ import annotations

import asyncio

from miles.rollout.polar_adapter import session_result_to_samples
from polar.rollout.models import SessionResult, SessionStatus, SessionTiming
from polar.trajectory.builder.per_request import PerRequestBuilder
from polar.trajectory.models import CompletionRecord, CompletionSession


def completion(name: str, prompt: list[int], response: list[int]) -> CompletionRecord:
    return CompletionRecord(
        completion_id=name,
        request={"messages": [{"role": "user", "content": name}]},
        response={
            "choices": [{
                "input_token_ids": prompt,
                "token_ids": response,
                "message": {"role": "assistant", "content": f"answer-{name}"},
                "finish_reason": "stop",
                "logprobs": {
                    "content": [
                        {"token_id": token, "logprob": -0.1}
                        for token in response
                    ]
                },
            }]
        },
    )


def main() -> None:
    session = CompletionSession(
        session_id="session-flat",
        task_id="task-flat",
        metadata={"group_id": 4, "policy_version": 0, "rollout_step": 0},
        completions=[
            completion("main", [1, 2], [3, 4]),
            completion("subagent", [5, 6, 7], [8, 9, 10]),
        ],
    )
    trajectory = asyncio.run(PerRequestBuilder().build(session))
    for trace in trajectory.traces:
        trace.reward = 0.75
    result = SessionResult(
        session_id=session.session_id,
        task_id=session.task_id,
        status=SessionStatus.COMPLETED,
        trajectory=trajectory,
        timing=SessionTiming(),
        metadata=session.metadata,
    )
    samples = session_result_to_samples(
        result,
        group_index=4,
        trajectory_index=17,
    )

    assert len(samples) == 2
    assert [sample.rollout_id for sample in samples] == [17, 17]
    assert [sample.response_length for sample in samples] == [2, 3]
    assert [sample.loss_mask for sample in samples] == [[1, 1], [1, 1, 1]]
    assert [sample.tokens for sample in samples] == [[1, 2, 3, 4], [5, 6, 7, 8, 9, 10]]
    assert all(sample.reward == {"score": 0.75} for sample in samples)
    print("Polar per-request -> Miles flattened training contract: PASS")


if __name__ == "__main__":
    main()
