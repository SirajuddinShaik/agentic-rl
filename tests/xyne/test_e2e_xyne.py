"""End-to-end integration test for the Xyne RL rollout path.

Chains the REAL components together to prove the integration end-to-end,
without any live infra (no real Xyne backend, docker container, LLM, Keycloak,
Postgres, or Vespa):

1. ``XyneRawFlow`` — a realistic raw agentic run payload.
2. ``XyneHarness.postprocess`` — reads ``cat <RAW_PATH>`` out of a FAKE
   ``BaseRuntime`` (whose ``exec`` returns the raw-flow JSON) and injects
   ``metadata["xyne_raw"]`` into an ``AgentRunResult``.
3. Builder -> Trajectory — ``PrefixMergingBuilder`` turns a ``CompletionSession``
   into a real ``Trajectory`` with a non-empty ``traces`` list (mirroring how
   the gateway reconstructs a training trace), and the raw flow is merged into
   ``trajectory.metadata["xyne_raw"]`` (mirroring how the node merges the
   harness output into the trajectory).
4. ``SessionResult`` — the run result wraps that trajectory.
5. ``XyneCompositeEvaluator.evaluate(trajectory)`` — scores all 8 built-in
   scorers; ``llm_judge`` uses an injected ``httpx.MockTransport`` so it never
   makes a network call.

Everything is local and deterministic; there are no sleeps, no polls, and no
timing dependence. A failure path (missing ``xyne_raw`` -> ``outcome_reward``
0.0 without raising) guards the "Xyne container unreachable -> reward 0.0"
QA scenario.
"""

from __future__ import annotations

import json

import httpx
import pytest

from polar.agent.models import AgentRunResult
from polar.rollout.models import SessionResult, SessionStatus
from polar.runtime.models import ExecResult
from polar.trajectory.builder.prefix_merging import PrefixMergingBuilder
from polar.trajectory.models import CompletionRecord, CompletionSession
from polar.xyne.evaluator import XyneCompositeEvaluator
from polar.xyne.harness import XyneHarness
from polar.xyne.types import XyneRawFlow

# Every built-in scorer, listed verbatim per reward-pipeline contract.
ALL_8_SCORERS = [
    {"name": "completion"},
    {"name": "answer_format"},
    {"name": "citation_presence"},
    {"name": "citation_relevance"},
    {"name": "citation_accuracy"},
    {"name": "retrieval_quality"},
    {"name": "subagent_success"},
    {"name": "llm_judge"},
]

# itemIds of the citations the mock flow grounds on. Used both to build the
# citations and as `expected_doc_ids` so citation_accuracy scores positively.
EXPECTED_DOC_IDS = ["item-101", "item-102"]


class FakeRuntime:
    """Minimal BaseRuntime test double: async ``exec`` returning canned results.

    Only the surface ``XyneHarness.postprocess`` uses (``exec``) is needed; it
    is deliberately not a ``BaseRuntime`` subclass so the test cannot
    accidentally trigger any real container lifecycle.
    """

    def __init__(self) -> None:
        self.commands: list[str] = []
        self._cat_content: str = ""
        self._cat_rc: int = 0
        self._cat_stderr: str = ""

    def set_cat(self, content: str, *, rc: int = 0, stderr: str = "") -> None:
        self._cat_content = content
        self._cat_rc = rc
        self._cat_stderr = stderr

    async def exec(self, command: str, **kwargs) -> ExecResult:  # noqa: A002
        self.commands.append(command)
        if command.startswith("cat "):
            return ExecResult(
                stdout=self._cat_content,
                stderr=self._cat_stderr,
                return_code=self._cat_rc,
            )
        return ExecResult(stdout="", stderr="", return_code=0)


def _raw_flow_payload() -> dict:
    """A realistic XyneRawFlow dict: answer + citations + debug + nested runs."""
    return {
        "conversation_id": "conv-e2e-1",
        "run_id": "run-e2e-1",
        "request_messages": [
            {"role": "user", "content": "What is the leave policy?"},
        ],
        "answer": (
            "Employees accrue 24 days of annual leave per year, with a "
            "rollover cap of 10 days into the following year."
        ),
        "citations": [
            {
                "docId": "doc-A",
                "itemId": "item-101",
                "clId": "cl-1",
                "page_title": "Leave Policy",
                "chunkIndex": 3,
                "relevance": 0.95,
                "snippet": "Annual leave entitlement is 24 days.",
            },
            {
                "docId": "doc-B",
                "itemId": "item-102",
                "clId": "cl-2",
                "page_title": "Leave Rollover",
                "chunkIndex": 1,
                "relevance": 0.9,
                "snippet": "Unused leave may roll over up to 10 days.",
            },
        ],
        "debug_events": [
            {"kind": "retrieval", "n": 2},
            {"kind": "answer", "finish_reason": "tool_calls"},
        ],
        "nested_runs": [
            {"runId": "sub-1", "status": "completed"},
            {"runId": "sub-2", "status": "completed"},
        ],
        "error": None,
        "latency_ms": 420.0,
        "wall_clock_ms": 500.0,
        "llm_calls": 2,
        "finish_reason": "tool_calls",
    }


def _build_payload() -> dict:
    """Evaluator config: all 8 scorers + expected ids + a mocked judge."""
    def judge_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"choices": [{"message": {"content": "0.8"}}]}
        )
    return {
        "expected_doc_ids": EXPECTED_DOC_IDS,
        "judge": {
            "base_url": "http://judge.local/v1",
            "api_key": "test-key",
            "model": "gpt-4o-mini",
            "weight": 0.5,
        },
        "scorers": [
            entry
            if entry["name"] != "llm_judge"
            else {**entry, "_transport": httpx.MockTransport(judge_handler)}
            for entry in ALL_8_SCORERS
        ],
    }


async def _run_harness_to_raw_metadata() -> dict:
    """Drive XyneHarness.postprocess against a FakeRuntime and return the
    ``result.metadata`` dict with ``xyne_raw`` populated."""
    runtime = FakeRuntime()
    runtime.set_cat(json.dumps(_raw_flow_payload()))
    result = AgentRunResult(status="completed", return_code=0)

    harness = XyneHarness.__new__(XyneHarness)  # no constructor-side effects
    # postprocess only touches `result`/`runtime`; bypass __init__ (which reads
    # self.settings/env and renders the helper source — none used here).
    await harness.postprocess(runtime, result)

    assert "xyne_raw_error" not in result.metadata, result.metadata
    return result.metadata


async def _build_session_result(raw_metadata: dict) -> SessionResult:
    """Build a Trajectory with a real trace (prefix-merging builder) whose
    metadata carries ``xyne_raw``, wrapped in a COMPLETED SessionResult."""
    completion = CompletionRecord(
        completion_id="c1",
        timestamp="2026-08-10T00:00:00Z",
        request={
            "messages": [
                {"role": "system", "content": "You are Xyne."},
                {"role": "user", "content": "What is the leave policy?"},
            ]
        },
        response={
            "choices": [
                {
                    "input_token_ids": [1, 2, 3, 4],
                    "message": {
                        "role": "assistant",
                        "content": "24 days annual leave.",
                    },
                    "finish_reason": "stop",
                    "token_ids": [5, 6, 7, 8],
                }
            ]
        },
        metadata={},
    )
    session = CompletionSession(
        session_id="s-c1",
        created_at="2026-08-10T00:00:00Z",
        completion_count=1,
        task_id="task-e2e",
        model_used="nemotron-30b-a3b",
        api_type="openai",
        metadata={},
        completions=[completion],
    )
    builder = PrefixMergingBuilder()
    trajectory = await builder.build(session)
    # Merge the raw flow into the trajectory metadata (the node merges the
    # harness output into the trajectory before evaluation).
    trajectory.metadata["xyne_raw"] = raw_metadata["xyne_raw"]
    trajectory.metadata["xyne_raw_path"] = raw_metadata["xyne_raw_path"]

    return SessionResult(
        session_id="s-c1",
        task_id="task-e2e",
        status=SessionStatus.COMPLETED,
        trajectory=trajectory,
    )


# --------------------------------------------------------------------------- #
# Plan assertion 1: SessionResult.trajectory.traces non-empty
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_e2e_happy_path_chains_harness_builder_evaluator() -> None:
    # 1. Harness -> raw flow injected into run metadata (fake runtime, no docker).
    raw_metadata = await _run_harness_to_raw_metadata()
    assert "xyne_raw" in raw_metadata

    # 2. Builder -> real Trajectory with non-empty traces; merged raw flow.
    session_result = await _build_session_result(raw_metadata)
    trajectory = session_result.trajectory

    # Plan assertion (1): traces non-empty.
    assert trajectory.traces, "trajectory.traces must be non-empty after builder"
    assert trajectory.status == "COMPLETED"

    # Plan assertion (2): xyne_raw carries the four required keys.
    xyne_raw = trajectory.metadata["xyne_raw"]
    for key in ("answer", "citations", "debug_events", "nested_runs"):
        assert key in xyne_raw, f"xyne_raw missing key {key!r}"
    assert xyne_raw["answer"]  # non-empty answer
    assert xyne_raw["citations"], "expected >=1 citation"
    assert isinstance(xyne_raw["debug_events"], list)
    assert isinstance(xyne_raw["nested_runs"], list)

    # 3. Evaluator over the trajectory (all 8 scorers + mocked judge).
    evaluator = XyneCompositeEvaluator(**_build_payload())
    eval_result = await evaluator.evaluate(trajectory)

    # Plan assertion (3): per_scorer has all 8 built-in names.
    per_scorer = eval_result.metadata["per_scorer"]
    assert set(per_scorer) == {
        "completion",
        "answer_format",
        "citation_presence",
        "citation_relevance",
        "citation_accuracy",
        "retrieval_quality",
        "subagent_success",
        "llm_judge",
    }

    # The citation-accuracy scorer is positive because expected_doc_ids match
    # the citation itemIds -> proves the config forwarding worked E2E.
    assert per_scorer["citation_accuracy"] == pytest.approx(1.0)
    # llm_judge returns the canned mock float (0.8), quantized to the discrete
    # 1.0 (no network ever touched).
    assert per_scorer["llm_judge"] == pytest.approx(1.0)

    # Plan assertion (4): outcome_reward is a meaningful composite in [0,1].
    reward = eval_result.outcome_reward
    assert reward is not None
    assert 0.0 <= reward <= 1.0
    # With every scorer scoring positively, the composite must be > 0 and
    # reflect a genuinely merged reward (not a degenerate 0.0).
    assert reward > 0.0


@pytest.mark.asyncio
async def test_e2e_raw_flow_round_trips_through_types() -> None:
    """The raw JSON the harness injects parses back into a valid XyneRawFlow."""
    payload = _raw_flow_payload()
    flow = XyneRawFlow.from_dict(payload)
    assert flow.conversation_id == "conv-e2e-1"
    assert flow.run_id == "run-e2e-1"
    assert len(flow.citations) == 2
    assert len(flow.nested_runs) == 2
    assert flow.error is None
    # from_dict -> to_dict -> from_json round-trips losslessly.
    assert XyneRawFlow.from_json(flow.to_json()).to_dict() == flow.to_dict()


@pytest.mark.asyncio
async def test_e2e_failure_missing_xyne_raw_returns_zero() -> None:
    """Xyne unreachable -> no xyne_raw -> reward 0.0, evaluator never raises."""
    trajectory = (
        await _build_session_result(
            {
                "xyne_raw_path": "/polar/session/xyne_raw.json",
                "xyne_raw": _raw_flow_payload(),
            }
        )
    ).trajectory
    # Simulate the harness failing to read the raw flow: drop xyne_raw.
    trajectory.metadata.pop("xyne_raw", None)

    evaluator = XyneCompositeEvaluator(**_build_payload())
    eval_result = await evaluator.evaluate(trajectory)

    assert eval_result.outcome_reward == 0.0
    assert "error" in eval_result.metadata
    # No traces are mutated and no exception escapes.
    assert eval_result.trace_rewards is None
