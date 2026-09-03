"""Tests for the XyneCompositeEvaluator.

Covers the four plan acceptance cases (missing raw key, composite reward,
per-scorer weights, idempotence) plus the per-scorer config forwarding that
Todo 5 must handle (expected_doc_ids -> citation_accuracy, judge -> llm_judge).
The llm_judge path is exercised only through an injected ``httpx.MockTransport``
so no real network is ever touched.
"""

from __future__ import annotations

import asyncio
import json
import time

import httpx
import pytest

from polar.trajectory.models import Trajectory
from polar.xyne.evaluator import XyneCompositeEvaluator
from polar.xyne.types import XyneRawFlow


def _flow(
    *,
    answer: str = "a well-formed answer",
    error: str | None = None,
    citations: list[dict] | None = None,
    nested_runs: list[dict] | None = None,
) -> XyneRawFlow:
    return XyneRawFlow(
        conversation_id="conv-1",
        run_id="run-1",
        request_messages=[{"role": "user", "content": "hi"}],
        answer=answer,
        error=error,
        citations=citations or [],
        nested_runs=nested_runs or [],
    )


_ALL_8 = [
    {"name": "completion"},
    {"name": "answer_format"},
    {"name": "citation_presence"},
    {"name": "citation_relevance"},
    {"name": "citation_accuracy"},
    {"name": "retrieval_quality"},
    {"name": "subagent_success"},
    {"name": "llm_judge"},
]


def _trajectory(*, metadata: dict | None = None) -> Trajectory:
    return Trajectory(status="COMPLETED", metadata=metadata or {})


@pytest.mark.asyncio
async def test_evaluate_offloads_single_scorer_pass(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    class SlowPipeline:
        def run_with_scores(self, flow: XyneRawFlow) -> tuple[float, dict[str, float]]:
            nonlocal calls
            calls += 1
            time.sleep(0.05)
            return 0.75, {"slow": 0.75}

    monkeypatch.setattr("polar.xyne.evaluator._build_pipeline", lambda config: SlowPipeline())
    task = asyncio.create_task(
        XyneCompositeEvaluator().evaluate(
            _trajectory(metadata={"xyne_raw": _flow().to_dict()})
        )
    )
    await asyncio.sleep(0.01)
    assert not task.done()
    result = await task
    assert calls == 1
    assert result.outcome_reward == pytest.approx(0.75)


# --------------------------------------------------------------------------- #
# Plan acceptance case 1: missing metadata -> 0.0, no crash
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_missing_xyne_raw_returns_zero() -> None:
    evaluator = XyneCompositeEvaluator(**{"scorers": _ALL_8})
    result = await evaluator.evaluate(_trajectory(metadata={}))
    assert result.outcome_reward == 0.0


@pytest.mark.asyncio
async def test_xyne_raw_none_returns_zero() -> None:
    evaluator = XyneCompositeEvaluator()
    result = await evaluator.evaluate(_trajectory(metadata={"xyne_raw": None}))
    assert result.outcome_reward == 0.0


@pytest.mark.asyncio
async def test_malformed_xyne_raw_returns_zero_without_raising() -> None:
    evaluator = XyneCompositeEvaluator()
    result = await evaluator.evaluate(
        _trajectory(metadata={"xyne_raw": {"conversation_id": "only"}})
    )
    assert result.outcome_reward == 0.0


# --------------------------------------------------------------------------- #
# Plan acceptance case 2: composite reward == expected weighted average
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_composite_reward_weighted_average() -> None:
    # Every scorer enabled with weight 1.0. With this flow:
    #   completion 1.0, answer_format 1.0, citation_presence 1.0,
    #   citation_relevance 0.6, citation_accuracy 1.0 (matches expected doc),
    #   retrieval_quality = 0.5*sub_ok(1.0) + 0.5*relevance(0.6) = 0.8,
    #   subagent_success 1.0, llm_judge 0.0 (no judge).
    flow = _flow(
        citations=[{"docId": "doc-1", "relevance": 0.6}],
        nested_runs=[{"runId": "a"}],
    )
    config = {
        "scorers": _ALL_8,
        "expected_doc_ids": ["doc-1"],
    }
    result = await XyneCompositeEvaluator(**config).evaluate(
        _trajectory(metadata={"xyne_raw": flow.to_dict()})
    )
    expected = (1.0 + 1.0 + 1.0 + 0.6 + 1.0 + 0.8 + 1.0 + 0.0) / 8
    assert result.outcome_reward == pytest.approx(expected)


@pytest.mark.asyncio
async def test_composite_metadata_has_all_eight_scorer_names() -> None:
    flow = _flow(citations=[{"docId": "doc-1", "relevance": 0.9}])
    result = await XyneCompositeEvaluator(**{"scorers": _ALL_8}).evaluate(
        _trajectory(metadata={"xyne_raw": flow.to_dict()})
    )
    assert set(result.metadata["per_scorer"]) == {
        "completion",
        "answer_format",
        "citation_presence",
        "citation_relevance",
        "citation_accuracy",
        "retrieval_quality",
        "subagent_success",
        "llm_judge",
    }
    assert result.outcome_reward is not None and 0.0 <= result.outcome_reward <= 1.0


# --------------------------------------------------------------------------- #
# Plan acceptance case 3: per-scorer weights honored
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_per_scorer_weights_honored() -> None:
    # citation_presence (one citation -> 1.0) weight 3.0 vs
    # citation_relevance (0.5) weight 1.0 -> (3*1.0 + 1*0.5) / 4 = 0.875.
    # (Unweighted average would be 0.75 — the weight pulls it up.)
    flow = _flow(citations=[{"relevance": 0.5}])
    config = {
        "scorers": [
            {"name": "citation_presence", "weight": 3.0},
            {"name": "citation_relevance", "weight": 1.0},
        ]
    }
    result = await XyneCompositeEvaluator(**config).evaluate(
        _trajectory(metadata={"xyne_raw": flow.to_dict()})
    )
    assert result.outcome_reward == pytest.approx(0.875)


@pytest.mark.asyncio
async def test_disabled_scorer_excluded_from_weights() -> None:
    # citation_presence disabled -> only citation_relevance contributes,
    # scaled by its own weight only.
    flow = _flow(citations=[{"relevance": 0.5}])
    config = {
        "scorers": [
            {"name": "citation_presence", "weight": 9.0, "enabled": False},
            {"name": "citation_relevance", "weight": 1.0},
        ]
    }
    result = await XyneCompositeEvaluator(**config).evaluate(
        _trajectory(metadata={"xyne_raw": flow.to_dict()})
    )
    assert result.outcome_reward == pytest.approx(0.5)


# --------------------------------------------------------------------------- #
# Plan acceptance case 4: idempotence (same trajectory, same result)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_evaluate_is_idempotent() -> None:
    flow = _flow(
        answer="answer",
        citations=[{"docId": "doc-1", "relevance": 0.9}],
        nested_runs=[{"runId": "a"}],
    )
    trajectory = _trajectory(metadata={"xyne_raw": flow.to_dict()})
    config = {"scorers": _ALL_8, "expected_doc_ids": ["doc-1"]}
    evaluator = XyneCompositeEvaluator(**config)

    first = await evaluator.evaluate(trajectory)
    second = await evaluator.evaluate(trajectory)

    assert first.outcome_reward == pytest.approx(second.outcome_reward)
    assert set(first.metadata["per_scorer"]) == set(second.metadata["per_scorer"])
    for name in first.metadata["per_scorer"]:
        assert first.metadata["per_scorer"][name] == pytest.approx(
            second.metadata["per_scorer"][name]
        )
    # Repeated evaluation must not mutate the trajectory.
    assert trajectory.metadata == {"xyne_raw": flow.to_dict()}


# --------------------------------------------------------------------------- #
# Per-scorer config forwarding (Todo 5 known-limitation handling)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_expected_doc_ids_reach_citation_accuracy_via_top_level() -> None:
    # expected_doc_ids at top level, matched by citations -> accuracy 1.0.
    flow = _flow(citations=[{"itemId": "doc-a"}, {"docId": "doc-b"}])
    config = {"scorers": _ALL_8, "expected_doc_ids": ["doc-a", "doc-b"]}
    result = await XyneCompositeEvaluator(**config).evaluate(
        _trajectory(metadata={"xyne_raw": flow.to_dict()})
    )
    assert result.metadata["per_scorer"]["citation_accuracy"] == pytest.approx(1.0)


@pytest.mark.asyncio
async def test_expected_doc_ids_unmatched_scores_zero() -> None:
    flow = _flow(citations=[{"docId": "other"}])
    config = {"scorers": _ALL_8, "expected_doc_ids": ["doc-a"]}
    result = await XyneCompositeEvaluator(**config).evaluate(
        _trajectory(metadata={"xyne_raw": flow.to_dict()})
    )
    assert result.metadata["per_scorer"]["citation_accuracy"] == pytest.approx(0.0)


@pytest.mark.asyncio
async def test_judge_config_reaches_llm_judge_via_mock_transport() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"choices": [{"message": {"content": "0.7"}}]}
        )

    transport = httpx.MockTransport(handler)
    flow = _flow(answer="a judged answer")
    config = {
        "scorers": _ALL_8,
        "judge": {
            "base_url": "http://judge.local/v1",
            "api_key": "secret",
            "model": "gpt-4o-mini",
            "weight": 0.5,
        },
        # _transport is a unit-test only injection into the judge scorer.
        "_transport": None,
    }
    # Inline _transport directly on the llm_judge entry to prove entry-level
    # override + no real network.
    config["scorers"] = [
        entry if entry["name"] != "llm_judge" else {**entry, "_transport": transport}
        for entry in _ALL_8
    ]
    result = await XyneCompositeEvaluator(**config).evaluate(
        _trajectory(metadata={"xyne_raw": flow.to_dict()})
    )
    assert result.metadata["per_scorer"]["llm_judge"] == pytest.approx(0.5)


@pytest.mark.asyncio
async def test_judge_dimension_config_reaches_llm_judge() -> None:
    # Multi-dimensional judge config (dimension_weights, max_concurrency and an
    # enable_<dim> toggle) must reach the constructed LLMJudgeScorer. The mock
    # handler scores correctness 1.0 and every other enabled dimension 0.0, so
    # with correctness weighted 3.0 and quality+groundedness disabled the
    # composite proves both the weight (0.75) and the enable toggles were
    # forwarded (unweighted would be 0.5).
    seen_dims: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        content = body["messages"][1]["content"]
        for dim in ("quality", "correctness", "groundedness", "citation_accuracy"):
            if f"rubric ({dim})" in content:
                seen_dims.append(dim)
        value = "1.0" if "rubric (correctness)" in content else "0.0"
        return httpx.Response(200, json={"choices": [{"message": {"content": value}}]})

    transport = httpx.MockTransport(handler)
    flow = _flow(answer="a judged answer")
    config = {
        "scorers": _ALL_8,
        "judge": {
            "base_url": "http://judge.local/v1",
            "model": "gpt-4o-mini",
            "dimension_weights": {"correctness": 3.0},
            "max_concurrency": 2,
            "enable_quality": False,
            "enable_groundedness": False,
        },
    }
    # Inline _transport on the llm_judge entry (no real network).
    config["scorers"] = [
        entry if entry["name"] != "llm_judge" else {**entry, "_transport": transport}
        for entry in _ALL_8
    ]
    result = await XyneCompositeEvaluator(**config).evaluate(
        _trajectory(metadata={"xyne_raw": flow.to_dict()})
    )
    # quality+groundedness disabled -> correctness+citation_accuracy remain.
    assert set(seen_dims) == {"correctness", "citation_accuracy"}
    # correctness=1.0 (weight 3.0), citation_accuracy=0.0 -> 3/4.
    assert result.metadata["per_scorer"]["llm_judge"] == pytest.approx(0.75)


@pytest.mark.asyncio
async def test_llm_judge_without_judge_config_returns_zero_no_network() -> None:
    flow = _flow(answer="an answer")
    result = await XyneCompositeEvaluator(**{"scorers": _ALL_8}).evaluate(
        _trajectory(metadata={"xyne_raw": flow.to_dict()})
    )
    assert result.metadata["per_scorer"]["llm_judge"] == 0.0


# --------------------------------------------------------------------------- #
# Trimming / metadata sanity
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_raw_flow_metadata_is_bounded() -> None:
    huge_debug = [{"kind": f"event-{i}"} for i in range(500)]
    huge_runs = [{"runId": f"run-{i}"} for i in range(500)]
    flow = _flow(
        answer="answer",
        citations=[{"docId": "doc-1", "relevance": 0.9}],
        nested_runs=huge_runs,
    )
    flow.debug_events = huge_debug
    result = await XyneCompositeEvaluator(**{"scorers": _ALL_8}).evaluate(
        _trajectory(metadata={"xyne_raw": flow.to_dict()})
    )
    trimmed = result.metadata["raw_flow"]
    assert len(trimmed["debug_events"]) == 100
    assert len(trimmed["nested_runs"]) == 100
