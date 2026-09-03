"""Tests for the 8 built-in Xyne scorer plug-ins.

Each scorer gets at least three cases: happy path, boundary (empty/missing
input), and malformed input. The ``llm_judge`` scorer is tested exclusively via
an ``httpx.MockTransport`` so no real network is ever hit.
"""

from __future__ import annotations

import httpx
import pytest

import json
import asyncio
from pathlib import Path

from polar.xyne.reward_pipeline import build_pipeline, SCORER_REGISTRY
from polar.xyne.scorers import ALL_SCORERS
from polar.xyne.scorers.answer_format import AnswerFormatScorer
from polar.xyne.scorers.citation_accuracy import CitationAccuracyScorer
from polar.xyne.scorers.citation_presence import CitationPresenceScorer
from polar.xyne.scorers.citation_relevance import CitationRelevanceScorer
from polar.xyne.scorers.completion import CompletionScorer
from polar.xyne.scorers.llm_judge import (
    DEFAULT_MAX_TOKENS,
    LLMJudgeScorer,
    _extract_score,
    _quantize,
    _render_citations,
)
from polar.xyne.scorers.retrieval_quality import RetrievalQualityScorer
from polar.xyne.scorers.subagent_success import SubagentSuccessScorer
from polar.xyne.types import XyneRawFlow


def _flow(
    *,
    answer: str = "hello",
    error: str | None = None,
    citations: list[dict] | None = None,
    nested_runs: list[dict] | None = None,
    request_messages: list[dict] | None = None,
    retrieved_chunks: list[dict] | None = None,
) -> XyneRawFlow:
    return XyneRawFlow(
        conversation_id="conv-1",
        run_id="run-1",
        request_messages=request_messages or [{"role": "user", "content": "hi"}],
        answer=answer,
        citations=citations or [],
        nested_runs=nested_runs or [],
        retrieved_chunks=retrieved_chunks or [],
        error=error,
    )


def _judge_handler(content: str | int | float, status: int = 200):
    if status != 200:
        return lambda _request: httpx.Response(status, text="judge failure")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status,
            json={"choices": [{"message": {"content": content}}]},
        )

    return handler


# --------------------------------------------------------------------------- #
# Registration / pluggable seam
# --------------------------------------------------------------------------- #


def test_all_scorers_registered() -> None:
    assert set(ALL_SCORERS) == {
        "completion",
        "answer_format",
        "citation_presence",
        "citation_relevance",
        "citation_accuracy",
        "retrieval_quality",
        "subagent_success",
        "embedding_similarity",
        "gold_evidence_coverage",
        "citation_evidence_coverage",
        "tool_evidence_utility",
        "tool_call_efficiency",
        "token_efficiency",
        "llm_judge",
    }


def test_each_scorer_exposes_name_weight_enabled() -> None:
    for name, cls in ALL_SCORERS.items():
        scorer = cls(config={})
        assert scorer.name == name
        assert isinstance(scorer.weight, float)
        assert isinstance(scorer.enabled, bool)


# --------------------------------------------------------------------------- #
# CompletionScorer
# --------------------------------------------------------------------------- #


def test_completion_happy_path() -> None:
    assert CompletionScorer().score(_flow(error=None)) == 1.0


def test_completion_with_error_scores_zero() -> None:
    assert CompletionScorer().score(_flow(error="boom")) == 0.0


def test_completion_empty_string_error_counts_as_failure() -> None:
    assert CompletionScorer().score(_flow(error="")) == 0.0


# --------------------------------------------------------------------------- #
# AnswerFormatScorer
# --------------------------------------------------------------------------- #


def test_answer_format_happy_path() -> None:
    assert AnswerFormatScorer().score(_flow(answer="a real answer", error=None)) == 1.0


def test_answer_format_whitespace_only_answer_scores_zero() -> None:
    assert AnswerFormatScorer().score(_flow(answer="   \n  ", error=None)) == 0.0


def test_answer_format_empty_answer_scores_zero() -> None:
    assert AnswerFormatScorer().score(_flow(answer="", error=None)) == 0.0


def test_answer_format_errored_run_scores_zero_even_with_answer() -> None:
    assert AnswerFormatScorer().score(_flow(answer="partial", error="failed")) == 0.0


# --------------------------------------------------------------------------- #
# CitationPresenceScorer
# --------------------------------------------------------------------------- #


def test_citation_presence_happy_path() -> None:
    flow = _flow(citations=[{"docId": "doc-1"}])
    assert CitationPresenceScorer().score(flow) == 1.0


def test_citation_presence_empty_scores_zero() -> None:
    assert CitationPresenceScorer().score(_flow(citations=[])) == 0.0


def test_citation_presence_malformed_item_still_counts_as_present() -> None:
    flow = _flow(citations=["not a dict"])
    assert CitationPresenceScorer().score(flow) == 1.0


# --------------------------------------------------------------------------- #
# CitationRelevanceScorer
# --------------------------------------------------------------------------- #


def test_citation_relevance_means_values() -> None:
    flow = _flow(citations=[{"relevance": 0.8}, {"relevance": 0.6}])
    assert CitationRelevanceScorer().score(flow) == pytest.approx(0.7)


def test_citation_relevance_empty_scores_zero() -> None:
    assert CitationRelevanceScorer().score(_flow(citations=[])) == 0.0


def test_citation_relevance_missing_or_none_treated_as_zero() -> None:
    flow = _flow(citations=[{"relevance": None}, {"relevance": 0.8}])
    assert CitationRelevanceScorer().score(flow) == pytest.approx(0.4)


def test_citation_relevance_non_numeric_and_non_dict_drag_to_zero() -> None:
    flow = _flow(citations=[{"relevance": "0.8"}, "notadict", {"relevance": 0.8}])
    assert CitationRelevanceScorer().score(flow) == pytest.approx(0.8 / 3)


# --------------------------------------------------------------------------- #
# CitationAccuracyScorer
# --------------------------------------------------------------------------- #


def test_citation_accuracy_all_match() -> None:
    flow = _flow(citations=[{"itemId": "doc-a"}, {"docId": "doc-b"}])
    scorer = CitationAccuracyScorer(config={"expected_doc_ids": ["doc-a", "doc-b"]})
    assert scorer.score(flow) == 1.0


def test_citation_accuracy_empty_expectation_is_no_penalty() -> None:
    """Locked: no expectation set -> 1.0 (no penalty for an unasked check)."""
    scorer = CitationAccuracyScorer(config={"expected_doc_ids": []})
    assert scorer.score(_flow(citations=[{"itemId": "whatever"}])) == 1.0


def test_citation_accuracy_no_match_scores_zero() -> None:
    flow = _flow(citations=[{"itemId": "doc-x"}])
    scorer = CitationAccuracyScorer(config={"expected_doc_ids": ["doc-a"]})
    assert scorer.score(flow) == 0.0


def test_citation_accuracy_partial_match_is_fraction() -> None:
    flow = _flow(citations=[{"itemId": "doc-a"}, {"docId": "doc-c"}])
    scorer = CitationAccuracyScorer(config={"expected_doc_ids": ["doc-a", "doc-b"]})
    assert scorer.score(flow) == pytest.approx(0.5)


def test_citation_accuracy_expected_set_but_no_citations_scores_zero() -> None:
    scorer = CitationAccuracyScorer(config={"expected_doc_ids": ["doc-a"]})
    assert scorer.score(_flow(citations=[])) == 0.0


# --------------------------------------------------------------------------- #
# RetrievalQualityScorer
# --------------------------------------------------------------------------- #


def test_retrieval_quality_all_ok_and_relevant_is_one() -> None:
    flow = _flow(
        nested_runs=[{"runId": "a"}, {"runId": "b"}],
        citations=[{"relevance": 1.0}],
    )
    assert RetrievalQualityScorer().score(flow) == pytest.approx(1.0)


def test_retrieval_quality_empty_scores_half_vacuous() -> None:
    # Empty sub_agents/nested_runs -> sub_agent_success is vacuously 1.0;
    # no citations -> relevance 0.0. 0.5*1.0 + 0.5*0.0 = 0.5.
    flow = _flow(nested_runs=[], citations=[])
    assert RetrievalQualityScorer().score(flow) == pytest.approx(0.5)


def test_retrieval_quality_partial_subagent_failure_combines() -> None:
    flow = _flow(
        nested_runs=[{"runId": "a"}, {"runId": "b", "error": "boom"}],
        citations=[{"relevance": 1.0}],
    )
    # sub_ok = 0.5, relevance = 1.0 -> 0.5*0.5 + 0.5*1.0 = 0.75
    assert RetrievalQualityScorer().score(flow) == pytest.approx(0.75)


def test_retrieval_quality_non_dict_nested_run_counts_successful() -> None:
    flow = _flow(nested_runs=["raw"], citations=[{"relevance": 0.5}])
    # sub_ok = 1.0 (non-dict has no error), relevance = 0.5 -> 0.5 + 0.25 = 0.75
    assert RetrievalQualityScorer().score(flow) == pytest.approx(0.75)


# --------------------------------------------------------------------------- #
# SubagentSuccessScorer
# --------------------------------------------------------------------------- #


def test_subagent_success_all_ok() -> None:
    flow = _flow(nested_runs=[{"runId": "a"}, {"runId": "b"}])
    assert SubagentSuccessScorer().score(flow) == 1.0


def test_subagent_success_empty_vacuously_true() -> None:
    """Locked: no sub-agents -> 1.0 (nothing failed)."""
    flow = _flow(nested_runs=[])
    assert SubagentSuccessScorer().score(flow) == 1.0


def test_subagent_success_one_error_fails_all() -> None:
    flow = _flow(nested_runs=[{"runId": "a"}, {"runId": "b", "error": "boom"}])
    assert SubagentSuccessScorer().score(flow) == 0.0


def test_subagent_success_none_error_is_success_and_non_dict_ok() -> None:
    flow = _flow(nested_runs=[{"runId": "a", "error": None}, "raw"])
    assert SubagentSuccessScorer().score(flow) == 1.0


# --------------------------------------------------------------------------- #
# LLMJudgeScorer (httpx MockTransport — no real network)
# --------------------------------------------------------------------------- #


def test_llm_judge_returns_judge_score() -> None:
    transport = httpx.MockTransport(_judge_handler("0.7"))
    scorer = LLMJudgeScorer(
        config={"judge_base_url": "http://judge.local/v1", "_transport": transport}
    )
    assert scorer.score(_flow(answer="an answer")) == pytest.approx(0.5)


def test_llm_judge_http_500_returns_zero() -> None:
    transport = httpx.MockTransport(_judge_handler("0.7", status=500))
    scorer = LLMJudgeScorer(
        config={"judge_base_url": "http://judge.local/v1", "_transport": transport}
    )
    assert scorer.score(_flow()) == 0.0


def test_llm_judge_non_numeric_content_returns_zero() -> None:
    transport = httpx.MockTransport(_judge_handler("not a number"))
    scorer = LLMJudgeScorer(
        config={"judge_base_url": "http://judge.local/v1", "_transport": transport}
    )
    assert scorer.score(_flow()) == 0.0


def test_llm_judge_missing_base_url_returns_zero_without_network() -> None:
    scorer = LLMJudgeScorer(config={})
    assert scorer.score(_flow()) == 0.0


def test_llm_judge_network_failure_returns_zero() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("judge unreachable")

    transport = httpx.MockTransport(handler)
    scorer = LLMJudgeScorer(
        config={"judge_base_url": "http://judge.local/v1", "_transport": transport}
    )
    assert scorer.score(_flow()) == 0.0


# --------------------------------------------------------------------------- #
# Pipeline integration
# --------------------------------------------------------------------------- #


def test_build_pipeline_runs_all_scorers() -> None:
    config = {
        "scorers": [
            {"name": "completion"},
            {"name": "answer_format"},
            {"name": "citation_presence"},
            {"name": "citation_relevance"},
            {"name": "citation_accuracy", "weight": 0.0},
            {"name": "retrieval_quality"},
            {"name": "subagent_success"},
            {"name": "embedding_similarity", "reference_answer": "a solid answer"},
            {"name": "gold_evidence_coverage"},
            {"name": "citation_evidence_coverage"},
            {"name": "tool_evidence_utility"},
            {"name": "tool_call_efficiency"},
            {"name": "token_efficiency"},
            {"name": "llm_judge"},
        ]
    }
    pipeline = build_pipeline(config)
    flow = _flow(
        answer="a solid answer",
        citations=[{"docId": "doc-1", "relevance": 0.9}],
        nested_runs=[{"runId": "a"}],
    )
    result = pipeline.run(flow)
    assert 0.0 <= result <= 1.0

    per_scorer = pipeline.per_scorer_scores(flow)
    assert set(per_scorer) == set(ALL_SCORERS)
    # llm_judge with no base_url must not hit the network -> 0.0.
    assert per_scorer["llm_judge"] == 0.0


# --------------------------------------------------------------------------- #
# Multi-dim LLMJudgeScorer: composite / concurrency / disable / registry /
# prompt rendering (httpx MockTransport — no real network)
# --------------------------------------------------------------------------- #

DIM_VALUES = {"quality": 0.9, "correctness": 0.8, "groundedness": 0.7, "citation_accuracy": 0.6}


def _dim_from_request(request: httpx.Request) -> str:
    """Extract the dimension being scored from a judge request body's user content.

    The rendered user content contains ``Dimension rubric (<dim>):`` — parse it so
    a handler can route per-dimension responses deterministically.
    """
    body = json.loads(request.content)
    user = body["messages"][1]["content"]
    marker = "Dimension rubric ("
    start = user.index(marker) + len(marker)
    end = user.index("):", start)
    return user[start:end]


def _per_dimension_handler(values: dict[str, float]):
    """Return a MockTransport handler that answers each dimension with its float."""
    def handler(request: httpx.Request) -> httpx.Response:
        dim = _dim_from_request(request)
        content = str(values.get(dim, 0.0))
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

    return handler


def _referenced_flow() -> XyneRawFlow:
    """A flow carrying a reference_answer in metadata plus Q/A/citations."""
    flow = _flow(
        answer="Paris is the capital of France.",
        citations=[{"snippet": "Paris, the capital of France, sits on the Seine."}],
        request_messages=[{"role": "user", "content": "What is the capital of France?"}],
    )
    flow.metadata["reference_answer"] = "Paris is the capital of France."
    return flow


@pytest.mark.asyncio
async def test_llm_judge_multi_dim_composite_correct() -> None:
    transport = httpx.MockTransport(_per_dimension_handler(DIM_VALUES))
    scorer = LLMJudgeScorer(
        config={"judge_base_url": "http://judge.local/v1", "_transport": transport}
    )
    score = await scorer.score_async(_referenced_flow())
    # All four dims enabled, weight 1.0 each: (0.9+0.8+0.7+0.6)/4 = 0.75
    assert score == pytest.approx(0.75)


@pytest.mark.asyncio
async def test_llm_judge_dimension_weights_shift_composite() -> None:
    transport = httpx.MockTransport(_per_dimension_handler(DIM_VALUES))
    scorer = LLMJudgeScorer(
        config={
            "judge_base_url": "http://judge.local/v1",
            "_transport": transport,
            "dimension_weights": {"quality": 2.0},
        }
    )
    score = await scorer.score_async(_referenced_flow())
    # dims quantize to {1.0, 1.0, 0.5, 0.5}; weights: quality=2, others=1
    # -> (2*1.0 + 1.0 + 0.5 + 0.5)/(2+1+1+1) = 4.0/5 = 0.8
    assert score == pytest.approx(0.8)


@pytest.mark.asyncio
async def test_llm_judge_sync_score_bridge_matches_async_composite() -> None:
    transport = httpx.MockTransport(_per_dimension_handler(DIM_VALUES))
    scorer = LLMJudgeScorer(
        config={"judge_base_url": "http://judge.local/v1", "_transport": transport}
    )
    flow = _referenced_flow()
    await_score = await scorer.score_async(flow)
    sync_score = scorer.score(flow)  # sync bridge (called outside a running loop)
    assert sync_score == pytest.approx(0.75)
    assert sync_score == pytest.approx(await_score)


@pytest.mark.asyncio
async def test_llm_judge_scorer_reuse_across_sync_bridge_no_deadlock() -> None:
    """Locked regression: reuse ONE scorer across sync-bridge calls from inside a running loop.

    Each `score()` runs its async dimension calls on a fresh loop in a worker
    thread (a live loop is running here). With max_concurrency=2 the four
    dimension POSTs contend, so the semaphore binds to a loop. Reusing the same
    instance across two calls must NOT raise a cross-loop RuntimeError or an
    IndexError, and must return the correct composite both times.
    """
    transport = httpx.MockTransport(_per_dimension_handler(DIM_VALUES))
    scorer = LLMJudgeScorer(
        config={
            "judge_base_url": "http://judge.local/v1",
            "_transport": transport,
            "max_concurrency": 2,
        }
    )
    flow = _referenced_flow()
    first = scorer.score(flow)
    second = scorer.score(flow)
    assert first == pytest.approx(0.75)
    assert second == pytest.approx(0.75)


def _make_tracking_transport(peak: list[int], current: list[int]) -> httpx.MockTransport:
    async def handler(request: httpx.Request) -> httpx.Response:
        current[0] += 1
        peak[0] = max(peak[0], current[0])
        try:
            await asyncio.sleep(0.01)
            return httpx.Response(
                200, json={"choices": [{"message": {"content": "1.0"}}]}
            )
        finally:
            current[0] -= 1

    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_llm_judge_concurrency_respects_max_concurrency() -> None:
    peak: list[int] = [0]
    current: list[int] = [0]
    transport = _make_tracking_transport(peak, current)
    scorer = LLMJudgeScorer(
        config={
            "judge_base_url": "http://judge.local/v1",
            "_transport": transport,
            "max_concurrency": 2,
        }
    )
    await scorer.score_async(_referenced_flow())
    assert peak[0] <= 2


@pytest.mark.asyncio
async def test_llm_judge_default_concurrency_cap_is_twenty() -> None:
    peak: list[int] = [0]
    current: list[int] = [0]
    transport = _make_tracking_transport(peak, current)
    scorer = LLMJudgeScorer(
        config={"judge_base_url": "http://judge.local/v1", "_transport": transport}
    )
    await scorer.score_async(_referenced_flow())
    # The semaphore must be loose enough to run all four dimensions concurrently
    # (default cap 20), so peak reaches 4 — never clamped by a smaller default.
    assert peak[0] == 4
    assert scorer._max_concurrency == 20


@pytest.mark.asyncio
async def test_llm_judge_disabled_dimension_excluded_from_composite() -> None:
    # Disable correctness -> only quality/groundedness/citation_accuracy count.
    transport = httpx.MockTransport(_per_dimension_handler(DIM_VALUES))
    scorer = LLMJudgeScorer(
        config={
            "judge_base_url": "http://judge.local/v1",
            "_transport": transport,
            "enable_correctness": False,
        }
    )
    score = await scorer.score_async(_referenced_flow())
    # dims quantize to {1.0, 0.5, 0.5} (correctness disabled) -> 2.0/3
    assert score == pytest.approx((1.0 + 0.5 + 0.5) / 3)  # 0.6666...


@pytest.mark.asyncio
async def test_llm_judge_all_disabled_returns_zero_without_requests() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append("boom")
        return httpx.Response(200, json={"choices": [{"message": {"content": 1.0}}]})

    transport = httpx.MockTransport(handler)
    scorer = LLMJudgeScorer(
        config={
            "judge_base_url": "http://judge.local/v1",
            "_transport": transport,
            "enable_quality": False,
            "enable_correctness": False,
            "enable_groundedness": False,
            "enable_citation_accuracy": False,
        }
    )
    assert await scorer.score_async(_referenced_flow()) == 0.0
    assert calls == []  # no request was made


# --------------------------------------------------------------------------- #
# Registry round-trip for the new config keys
# --------------------------------------------------------------------------- #


def test_llm_judge_registered_under_llm_judge_and_all_scorers() -> None:
    assert "llm_judge" in SCORER_REGISTRY
    assert SCORER_REGISTRY["llm_judge"] is LLMJudgeScorer
    assert ALL_SCORERS["llm_judge"] is LLMJudgeScorer


def test_llm_judge_constructible_with_all_new_config_keys() -> None:
    transport = httpx.MockTransport(_per_dimension_handler(DIM_VALUES))
    scorer = LLMJudgeScorer(
        config={
            "judge_base_url": "http://judge.local/v1",
            "judge_api_key": "sk-test",
            "judge_model": "judge-model-x",
            "prompt_template": "Q:{question} A:{answer} Ref:{reference}",
            "timeout": 5.0,
            "_transport": transport,
            "max_concurrency": 3,
            "dimension_weights": {"quality": 2.0, "correctness": 0.5},
            "enable_quality": True,
            "enable_correctness": True,
            "enable_groundedness": True,
            "enable_citation_accuracy": True,
        }
    )
    assert scorer.name == "llm_judge"
    assert scorer._model == "judge-model-x"
    assert scorer._max_concurrency == 3
    assert scorer._dimension_weights["quality"] == 2.0
    assert scorer._enabled_dims["quality"] is True


# --------------------------------------------------------------------------- #
# Prompt rendering (deterministic request-body assertion)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_llm_judge_renders_qa_citations_reference_and_rubric() -> None:
    captured: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": 0.5}}]})

    transport = httpx.MockTransport(handler)
    scorer = LLMJudgeScorer(
        config={
            "judge_base_url": "http://judge.local/v1",
            "_transport": transport,
            "judge_model": "judge-model-x",
        }
    )
    flow = _referenced_flow()
    await scorer.score_async(flow)

    assert len(captured) == 4  # one request per enabled dimension
    body = captured[0]
    assert body["model"] == "judge-model-x"
    assert body["temperature"] == 0.0
    assert body["messages"][0]["role"] == "system"
    user = body["messages"][1]["content"]

    # Question, answer, and cited snippet all appear in the rendered content.
    assert "What is the capital of France?" in user
    assert "Paris is the capital of France." in user
    assert "1. Paris, the capital of France, sits on the Seine." in user
    # Reference/ground-truth answer path is exercised.
    assert "Reference (ground truth) answer: Paris is the capital of France." in user
    # The dimension rubric is inlined.
    assert "Quality: judge the overall quality of the answer" in user

    # Every one of the four dimensions is asked, each with its own rubric.
    all_user = "\n".join(b["messages"][1]["content"] for b in captured)
    for dim in DIM_VALUES:
        assert f"Dimension rubric ({dim}):" in all_user


# --------------------------------------------------------------------------- #
# Citation rendering / score extraction / request body (regression fixes)
# --------------------------------------------------------------------------- #


def test_llm_judge_render_citations_uses_chunk_key() -> None:
    """Real/live data store the snippet text under ``chunk``, not ``snippet``."""
    rendered = _render_citations([{"chunk": "Paris sits on the Seine."}])
    assert "1. Paris sits on the Seine." in rendered
    assert "(none)" not in rendered


def test_llm_judge_render_citations_falls_back_gracefully_no_text_keys() -> None:
    # A citation with no recognized text key renders as an empty numbered line,
    # never crashes, and does not fabricate "(none)" while other lines exist.
    rendered = _render_citations([{"docId": "doc-1"}, {"chunk": "real chunk"}])
    assert "2. real chunk" in rendered
    assert "(none)" not in rendered


def test_llm_judge_render_citations_resolves_tool_evidence() -> None:
    flow = _flow(
        citations=[{"docId": "doc-1", "chunk": 7}],
        retrieved_chunks=[
            {
                "docId": "doc-1",
                "chunk": 7,
                "source_text": "The cited source says leave is capped at ten days.",
            }
        ],
    )
    rendered = _render_citations(flow.citations, flow=flow)
    assert "[doc-1#7]" in rendered
    assert "leave is capped at ten days" in rendered


def test_llm_judge_render_citations_keeps_identifier_without_text() -> None:
    rendered = _render_citations([{"docId": "doc-1", "chunk": 7}])
    assert rendered == "1. [doc-1#7]"


def test_llm_judge_render_citations_empty_input_is_none() -> None:
    assert _render_citations([]) == "(none)"


def test_llm_judge_extract_score_prefers_trailing_labeled_number() -> None:
    # A trailing "Score: 0.85" must win over an earlier stray decimal.
    text = "The answer is solid overall, maybe 0.4. Score: 0.85"
    # 0.85 quantizes to 1.0; had the stray 0.4 won, it would be 0.5.
    assert _extract_score(text) == pytest.approx(1.0)


def test_llm_judge_extract_score_last_label_wins() -> None:
    text = "Score: 0.2 reconsidered ... Final Score: 0.9"
    # 0.9 quantizes to 1.0; had the earlier 0.2 won, it would be 0.0.
    assert _extract_score(text) == pytest.approx(1.0)


def test_llm_judge_extract_score_unparseable_is_none() -> None:
    assert _extract_score("not a number at all") is None


def test_llm_judge_quantize_maps_to_discrete_scale() -> None:
    assert _quantize(1.0) == 1.0
    assert _quantize(0.0) == 0.0
    assert _quantize(0.5) == 0.5
    assert _quantize(0.75) == 1.0
    assert _quantize(0.3) == 0.5
    assert _quantize(0.25) == 0.0
    assert _quantize(0.4) == 0.5
    assert _quantize(1.3) == 1.0
    assert _quantize(-0.2) == 0.0
    assert _quantize(0.6) == 0.5


def test_llm_judge_extract_score_quantizes_labeled_number() -> None:
    # Any parsed float snaps to the nearest of {0.0, 0.5, 1.0}.
    assert _extract_score("Score: 0.85") == pytest.approx(1.0)
    assert _extract_score("Score: 0.3") == pytest.approx(0.5)


def test_llm_judge_extract_score_quantizes_bare_number() -> None:
    assert _extract_score("0.25") == pytest.approx(0.0)
    assert _extract_score("0.6") == pytest.approx(0.5)
    assert _extract_score("1.3") == pytest.approx(1.0)
    assert _extract_score("-0.2") == pytest.approx(0.0)


@pytest.mark.asyncio
async def test_llm_judge_matches_manual_labeled_examples_offline() -> None:
    """Regression harness for the hand-labeled 0/0.5/1 judge calibration set."""
    fixture = Path(__file__).parent / "fixtures" / "multidim_judge_labeled.json"
    examples = json.loads(fixture.read_text(encoding="utf-8"))

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        user = body["messages"][1]["content"]
        dimension = user[user.index("Dimension rubric (") + len("Dimension rubric ("):]
        dimension = dimension[:dimension.index("):")]
        for case in examples:
            if case["answer"] in user:
                return httpx.Response(
                    200,
                    json={"choices": [{"message": {"content": f"Score: {case['label'][dimension]}"}}]},
                )
        raise AssertionError("judge request did not contain a labeled example")

    scorer = LLMJudgeScorer(
        config={
            "judge_base_url": "http://judge.local/v1",
            "_transport": httpx.MockTransport(handler),
        }
    )
    for case in examples:
        flow = _flow(
            answer=case["answer"],
            citations=[{"docId": "doc-1", "chunk": 7}],
            retrieved_chunks=[{"docId": "doc-1", "chunk": 7, "source_text": case["citation"]}],
            request_messages=[{"role": "user", "content": case["question"]}],
        )
        actual = await scorer.score_async(flow)
        expected = sum(case["label"].values()) / 4.0
        assert actual == pytest.approx(expected), case["id"]


@pytest.mark.asyncio
async def test_llm_judge_request_body_has_max_tokens_and_labeled_instruction() -> None:
    captured: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": 0.5}}]})

    transport = httpx.MockTransport(handler)
    scorer = LLMJudgeScorer(
        config={"judge_base_url": "http://judge.local/v1", "_transport": transport}
    )
    await scorer.score_async(_referenced_flow())

    body = captured[0]
    assert body["max_tokens"] == DEFAULT_MAX_TOKENS

    override_transport = httpx.MockTransport(handler)
    override_scorer = LLMJudgeScorer(
        config={
            "judge_base_url": "http://judge.local/v1",
            "_transport": override_transport,
            "max_tokens": 1024,
        }
    )
    await override_scorer.score_async(_referenced_flow())
    # The current local Nemotron judge deliberately raises legacy 1k/2k/4k
    # caps to 16k so reasoning does not truncate before the final score.
    assert captured[-1]["max_tokens"] == DEFAULT_MAX_TOKENS

    system = body["messages"][0]["content"]
    user = body["messages"][1]["content"]
    assert "Score: <0.0, 0.5, or 1.0>" in system
    assert "Score: <0.0, 0.5, or 1.0>" in user
