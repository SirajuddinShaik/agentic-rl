"""Tests for the three composite-reward scorers added for the training loop.

Covers:
- ``embedding_similarity``: SQuAD F1 (identical ~1.0, disjoint ~0.0, empty
  reference/answer -> 0.0) and that the embedding method falls back to F1 when
  ``sentence-transformers`` is unavailable.
- ``tool_call_efficiency``: tool-call counting from synthetic debug_events and
  nested_runs, plus the over-budget penalty and the budget boundary.
- ``token_efficiency``: under/over budget, and neutral (1.0) when telemetry is
  absent.
- An end-to-end evaluator test proving the token-count injection from a
  synthetic ``Trajectory`` reaches the scorer.
"""

from __future__ import annotations

import pytest

from polar.trajectory.models import Trace, Trajectory
from polar.xyne.evaluator import XyneCompositeEvaluator
from polar.xyne.scorers.embedding_similarity import EmbeddingSimilarityScorer
from polar.xyne.scorers.retrieval_quality import RetrievalQualityScorer
from polar.xyne.scorers.subagent_success import SubagentSuccessScorer
from polar.xyne.scorers.token_efficiency import TokenEfficiencyScorer
from polar.xyne.scorers.tool_call_efficiency import (
    ToolCallEfficiencyScorer,
    count_tool_calls,
)
from polar.xyne.types import XyneRawFlow


def _flow(
    *,
    answer: str = "some answer text",
    debug_events: list[dict] | None = None,
    nested_runs: list[dict] | None = None,
    reference_answer: str | None = None,
) -> XyneRawFlow:
    return XyneRawFlow(
        conversation_id="conv-1",
        run_id="run-1",
        request_messages=[{"role": "user", "content": "hi"}],
        answer=answer,
        citations=[],
        debug_events=debug_events or [],
        nested_runs=nested_runs or [],
        error=None,
    )


# --------------------------------------------------------------------------- #
# EmbeddingSimilarityScorer (F1 default)
# --------------------------------------------------------------------------- #


def test_embedding_identical_answers_score_one() -> None:
    scorer = EmbeddingSimilarityScorer(config={"reference_answer": "the quick brown fox"})
    assert scorer.score(_flow(answer="the quick brown fox")) == pytest.approx(1.0)


def test_embedding_identical_with_different_punctuation_casing() -> None:
    scorer = EmbeddingSimilarityScorer(config={"reference_answer": "The Quick, Brown Fox."})
    assert scorer.score(_flow(answer="the quick brown fox")) == pytest.approx(1.0)


def test_embedding_disjoint_answers_score_low() -> None:
    scorer = EmbeddingSimilarityScorer(config={"reference_answer": "the quick brown fox"})
    score = scorer.score(_flow(answer="completely unrelated words here"))
    assert score < 0.2


def test_embedding_partial_overlap_scored_between() -> None:
    scorer = EmbeddingSimilarityScorer(config={"reference_answer": "a b c d"})
    score = scorer.score(_flow(answer="a b z z"))
    assert 0.0 < score < 1.0


def test_embedding_empty_reference_scores_zero() -> None:
    scorer = EmbeddingSimilarityScorer(config={"reference_answer": ""})
    assert scorer.score(_flow(answer="anything")) == 0.0


def test_embedding_missing_reference_scores_zero() -> None:
    scorer = EmbeddingSimilarityScorer(config={})
    assert scorer.score(_flow(answer="anything")) == 0.0


def test_embedding_empty_answer_scores_zero() -> None:
    scorer = EmbeddingSimilarityScorer(config={"reference_answer": "the quick brown fox"})
    assert scorer.score(_flow(answer="")) == 0.0


def test_embedding_whitespace_answer_scores_zero() -> None:
    scorer = EmbeddingSimilarityScorer(config={"reference_answer": "the quick brown fox"})
    assert scorer.score(_flow(answer="   \n  ")) == 0.0


def test_embedding_method_falls_back_to_f1_when_unavailable(monkeypatch) -> None:
    """Without sentence-transformers the embedding method must fall back to F1."""
    import builtins

    real_import = builtins.__import__

    def _blocked(name, *args, **kwargs):
        if name == "sentence_transformers":
            raise ImportError("blocked in test")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _blocked)
    scorer = EmbeddingSimilarityScorer(
        config={"reference_answer": "the quick brown fox", "method": "embedding"}
    )
    # Falls back to F1 -> identical answers still score ~1.0, no ImportError.
    assert scorer.score(_flow(answer="the quick brown fox")) == pytest.approx(1.0)


# --------------------------------------------------------------------------- #
# ToolCallEfficiencyScorer
# --------------------------------------------------------------------------- #


def test_tool_call_count_from_type_markers() -> None:
    events = [
        {"type": "tool_call", "name": "lookup"},
        {"kind": "tool_use"},
        {"type": "text"},
    ]
    nested: list[dict] = []
    assert count_tool_calls(debug_events=events, nested_runs=nested) == 2


def test_tool_call_count_from_name_plus_arguments() -> None:
    events = [
        {"name": "lookup_docs", "arguments": {"query": "x"}},
        {"name": "search", "input": "querystring"},
    ]
    assert count_tool_calls(debug_events=events, nested_runs=[]) == 2


def test_tool_call_count_nested_runs_is_floor() -> None:
    # No tool-marked debug events, but nested runs exist -> count >= len(nested).
    assert count_tool_calls(debug_events=[], nested_runs=[{"runId": "a"}, {"runId": "b"}]) == 2


def test_tool_call_count_combines_floor_with_events() -> None:
    events = [
        {"type": "tool_call"},
        {"type": "tool_call"},
        {"type": "tool_call"},
        {"type": "tool_call"},
        {"type": "tool_call"},
    ]
    nested = [{"runId": "a"}]  # floor of 1
    assert count_tool_calls(debug_events=events, nested_runs=nested) == 5


def test_tool_call_under_budget_scores_one() -> None:
    scorer = ToolCallEfficiencyScorer(config={"budget": 4})
    flow = _flow(debug_events=[{"type": "tool_call"}] * 3)
    assert scorer.score(flow) == pytest.approx(1.0)
    assert scorer.last_count == 3


def test_tool_call_at_budget_scores_one() -> None:
    scorer = ToolCallEfficiencyScorer(config={"budget": 4})
    flow = _flow(debug_events=[{"type": "tool_call"}] * 4)
    assert scorer.score(flow) == pytest.approx(1.0)


def test_tool_call_over_budget_penalty() -> None:
    # budget 4, count 8: 1 - (8-4)/4 = 0.0
    scorer = ToolCallEfficiencyScorer(config={"budget": 4})
    flow = _flow(debug_events=[{"type": "tool_call"}] * 8)
    assert scorer.score(flow) == pytest.approx(0.0)


def test_tool_call_partial_over_budget_penalty() -> None:
    # budget 4, count 6: 1 - (6-4)/4 = 0.5
    scorer = ToolCallEfficiencyScorer(config={"budget": 4})
    flow = _flow(debug_events=[{"type": "tool_call"}] * 6)
    assert scorer.score(flow) == pytest.approx(0.5)


def test_tool_call_default_budget_is_eight() -> None:
    scorer = ToolCallEfficiencyScorer(config={})
    assert scorer.budget == 8


def test_tool_call_last_count_exposed() -> None:
    scorer = ToolCallEfficiencyScorer(config={"budget": 4})
    flow = _flow(debug_events=[{"type": "tool_call"}] * 7)
    scorer.score(flow)
    assert scorer.last_count == 7


# --------------------------------------------------------------------------- #
# TokenEfficiencyScorer
# --------------------------------------------------------------------------- #


def test_token_under_budget_scores_one() -> None:
    scorer = TokenEfficiencyScorer(
        config={"total_completion_tokens": 100, "budget_tokens": 4096}
    )
    assert scorer.score(_flow()) == pytest.approx(1.0)


def test_token_at_budget_scores_one() -> None:
    scorer = TokenEfficiencyScorer(
        config={"total_completion_tokens": 4096, "budget_tokens": 4096}
    )
    assert scorer.score(_flow()) == pytest.approx(1.0)


def test_token_over_budget_penalty() -> None:
    # count 8192, budget 4096: 1 - (8192-4096)/4096 = 0.0
    scorer = TokenEfficiencyScorer(
        config={"total_completion_tokens": 8192, "budget_tokens": 4096}
    )
    assert scorer.score(_flow()) == pytest.approx(0.0)


def test_token_partial_over_budget_penalty() -> None:
    # count 5120, budget 4096: 1 - (5120-4096)/4096 = 0.75
    scorer = TokenEfficiencyScorer(
        config={"total_completion_tokens": 5120, "budget_tokens": 4096}
    )
    assert scorer.score(_flow()) == pytest.approx(0.75)


def test_token_missing_count_is_neutral_one() -> None:
    scorer = TokenEfficiencyScorer(config={})
    assert scorer.score(_flow()) == pytest.approx(1.0)


def test_token_default_budget_is_4096() -> None:
    scorer = TokenEfficiencyScorer(config={"total_completion_tokens": 100})
    assert scorer.budget_tokens == 4096


def test_token_last_count_exposed() -> None:
    scorer = TokenEfficiencyScorer(
        config={"total_completion_tokens": 5000, "budget_tokens": 4096}
    )
    scorer.score(_flow())
    assert scorer.last_count == 5000


# --------------------------------------------------------------------------- #
# End-to-end: evaluator injects token counts from a synthetic Trajectory
# --------------------------------------------------------------------------- #


def _trajectory_with_traces(resp_tokens: list[int]) -> Trajectory:
    traces = [Trace(response_ids=[0] * n, prompt_ids=[0] * 2) for n in resp_tokens]
    raw = XyneRawFlow(
        conversation_id="c",
        run_id="r",
        request_messages=[{"role": "user", "content": "hi"}],
        answer="an answer",
    )
    return Trajectory(status="COMPLETED", metadata={"xyne_raw": raw.to_dict()}, traces=traces)


@pytest.mark.asyncio
async def test_evaluator_injects_token_counts_end_to_end() -> None:
    # 3 traces with 1000, 2000, 3000 completion tokens -> total 6000.
    trajectory = _trajectory_with_traces([1000, 2000, 3000])
    config = {
        "scorers": [
            {"name": "token_efficiency", "budget_tokens": 4096},
        ]
    }
    evaluator = XyneCompositeEvaluator(**config)
    result = await evaluator.evaluate(trajectory)
    # total_completion = 6000, budget 4096 -> 1 - (6000-4096)/4096 = 0.535...
    expected = 1.0 - (6000 - 4096) / 4096
    assert result.metadata["per_scorer"]["token_efficiency"] == pytest.approx(expected)


@pytest.mark.asyncio
async def test_evaluator_token_injection_respects_explicit_config() -> None:
    # A config that already sets total_completion_tokens must win over the
    # trajectory-derived total.
    trajectory = _trajectory_with_traces([9000])
    config = {
        "scorers": [
            {"name": "token_efficiency", "budget_tokens": 4096,
             "total_completion_tokens": 100},
        ]
    }
    evaluator = XyneCompositeEvaluator(**config)
    result = await evaluator.evaluate(trajectory)
    assert result.metadata["per_scorer"]["token_efficiency"] == pytest.approx(1.0)


@pytest.mark.asyncio
async def test_evaluator_token_scorer_without_traces_is_neutral() -> None:
    trajectory = Trajectory(status="COMPLETED", traces=[])
    raw = XyneRawFlow(
        conversation_id="c",
        run_id="r",
        request_messages=[],
        answer="an answer",
    )
    trajectory.metadata["xyne_raw"] = raw.to_dict()
    config = {"scorers": [{"name": "token_efficiency"}]}
    evaluator = XyneCompositeEvaluator(**config)
    result = await evaluator.evaluate(trajectory)
    # Zero traces -> total_completion_tokens 0 <= budget -> 1.0
    assert result.metadata["per_scorer"]["token_efficiency"] == pytest.approx(1.0)


@pytest.mark.asyncio
async def test_evaluator_does_not_mutate_original_config() -> None:
    trajectory = _trajectory_with_traces([1234])
    config = {"scorers": [{"name": "token_efficiency"}]}
    evaluator = XyneCompositeEvaluator(**config)
    await evaluator.evaluate(trajectory)
    # The original scorer entry must not carry injected token counts.
    assert "total_completion_tokens" not in config["scorers"][0]


# --------------------------------------------------------------------------- #
# Real-dump fixture-driven tests (fixtures: tests/xyne/conftest.py)
# --------------------------------------------------------------------------- #


def test_tool_call_efficiency_counts_real_dump_success(
    success_flow: XyneRawFlow,
) -> None:
    # success_with_tools.json: 4 tool_calls, 4 tool_use_blocks, empty legacy fields.
    scorer = ToolCallEfficiencyScorer(config={})  # default budget 8
    assert scorer.score(success_flow) == pytest.approx(1.0)
    assert scorer.last_count == 4


def test_tool_call_efficiency_real_error_dump_is_zero_calls(
    error_flow: XyneRawFlow,
) -> None:
    # error_dump.json carries NO tool_calls/tool_use_blocks keys -> default [].
    scorer = ToolCallEfficiencyScorer(config={})
    assert scorer.score(error_flow) == pytest.approx(1.0)
    assert scorer.last_count == 0


def test_retrieval_quality_success_dump_scores_half(
    success_flow: XyneRawFlow,
) -> None:
    # Empty sub_agents -> vacuous sub_agent_success 1.0; citations lack a
    # `relevance` key -> relevance 0.0. 0.5*1.0 + 0.5*0.0 = 0.5.
    score = RetrievalQualityScorer().score(success_flow)
    assert score >= 0.5


def test_token_efficiency_falls_back_to_real_flow_output(
    success_flow: XyneRawFlow,
) -> None:
    # No config-injected count -> falls back to flow.token_usage["output"] = 929
    # which is <= budget 4096 -> score 1.0.
    scorer = TokenEfficiencyScorer(config={})
    assert scorer.score(success_flow) == pytest.approx(1.0)
    assert scorer.last_count == 929


def test_subagent_success_success_dump_vacuous(
    success_flow: XyneRawFlow,
) -> None:
    # success_with_tools.json has empty sub_agents -> vacuously true 1.0.
    score = SubagentSuccessScorer().score(success_flow)
    assert score == 1.0


@pytest.mark.asyncio
async def test_evaluator_end_to_end_uses_real_success_dump(
    success_trajectory: Trajectory,
) -> None:
    # Runs every updated scorer over the real 341KB dump via the evaluator.
    config = {
        "scorers": [
            {"name": "tool_call_efficiency"},
            {"name": "token_efficiency"},
            {"name": "retrieval_quality"},
            {"name": "subagent_success"},
        ]
    }
    evaluator = XyneCompositeEvaluator(**config)
    result = await evaluator.evaluate(success_trajectory)
    per = result.metadata["per_scorer"]
    # 4 tool calls (budget 8) -> 1.0; output 929 tokens (budget 4096) -> 1.0.
    assert per["tool_call_efficiency"] == pytest.approx(1.0)
    assert per["token_efficiency"] == pytest.approx(1.0)
    # citations lack `relevance`, sub_agents empty -> 0.5.
    assert per["retrieval_quality"] == pytest.approx(0.5)
    assert per["subagent_success"] == pytest.approx(1.0)
