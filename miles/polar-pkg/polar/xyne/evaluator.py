"""Composite Xyne evaluator: turn a raw Xyne flow into one scalar reward.

This module implements the evaluator strategy referenced by the plan/Todo 8 as
``EvaluatorSpec.strategy = "polar.xyne.evaluator:XyneCompositeEvaluator"``
(the registry treats a strategy containing ``:`` as an import path). It reads
the raw flow the harness injected into ``trajectory.metadata["xyne_raw"]``,
parses it into a :class:`~polar.xyne.types.XyneRawFlow`, runs every configured
scorer through a :class:`~polar.xyne.reward_pipeline.RewardPipeline`, and
returns a single weighted-average reward via :class:`EvalResult`.

This evaluator NEVER calls Xyne, NEVER mutates ``trajectory.traces``, and it
is asynchronous (matching :meth:`BaseTrajectoryEvaluator.evaluate`); the
individual scorers' ``score()`` methods are synchronous and are invoked
directly (they are pure over the flow, with the sole exception of
``llm_judge``, which only touches the network when a judge is configured).

Configuration contract (Todo 8 must consume this)
-------------------------------------------------
The evaluator is instantiated by the registry as ``cls(**spec.config)`` (see
``StrategyRegistry.create``), so ``__init__`` receives the evaluator config as
keyword arguments and stores it verbatim on ``self.config``. The config is a
reward-pipeline config with two layers:

1. **Reward config** — ``scorers`` is a list of per-scorer entries
   ``{"name": str, "weight": float, "enabled": bool, **per_scorer}``. The
   ``name`` must be a registered scorer (one of the 8 built-ins, or any scorer
   registered via :func:`~polar.xyne.reward_pipeline.register_scorer`).
2. **Per-scorer hints** — the pipeline builder in
   :mod:`polar.xyne.reward_pipeline` does *not* forward unknown keys from a
   scorer entry (``XyneRewardConfig.from_dict`` only parses name/weight/
   enabled), so this evaluator collects the per-scorer config itself and
   hands it to the scorer's ``__init__(config=...)`` directly. Two kinds of
   hints are supported, in increasing precedence:

   - **Top-level keys** forwarded to the affected scorers:
       - ``expected_doc_ids`` (list) -> ``citation_accuracy``
       - ``judge`` (dict) -> ``llm_judge``
   - **Per-scorer entries** under ``scorers`` may carry their own keys
     (e.g. ``{"name": "llm_judge", "judge_base_url": ..., "_transport": ...}``
     or ``{"name": "citation_accuracy", "expected_doc_ids": [...]}``); those
     override the top-level hints for that scorer.

   So a minimal Todo-8 config looks like::

       {
         "expected_doc_ids": ["doc-1", "doc-2"],
         "judge": {"base_url": "http://judge:8080/v1", "api_key": "...",
                   "model": "gpt-4o-mini", "weight": 0.5},
         "scorers": [
           {"name": "completion", "weight": 1.0},
           {"name": "citation_accuracy", "weight": 1.0},
           {"name": "llm_judge", "weight": 0.5},
           ...
         ],
       }

   The ``judge`` dict keys are normalized to the ``llm_judge`` scorer's
   expected names: ``base_url`` -> ``judge_base_url``, ``api_key`` ->
   ``judge_api_key``, ``model`` -> ``judge_model`` (``weight`` is applied as
   the scorer's weight). A ``weight`` nested in ``judge`` also overrides the
   ``llm_judge`` entry's weight when the entry does not set one.

   When ``expected_doc_ids`` / a judge config are absent, the matching scorers
   run in their documented default mode (citation_accuracy -> 1.0 no-penalty;
   llm_judge -> 0.0 without making any network call).

Bounded ``metadata["raw_flow"]``
--------------------------------
The raw flow carried by :class:`XyneRawFlow` does not itself embed LLM token
IDs (``llm_calls`` is just a count; token IDs live in ``trajectory.traces``,
which this evaluator never touches). "Trimming" therefore means keeping the
metadata bounded: this evaluator caps the lengths of the potentially huge
``debug_events`` and ``nested_runs`` lists (and serializes via
``XyneRawFlow.to_dict()`` for a lossless, JSON-friendly snapshot).
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

from polar.trajectory.evaluator.base import BaseTrajectoryEvaluator
from polar.trajectory.models import EvalResult, Trajectory

# Importing polar.xyne.scorers registers all 8 built-in scorers into
# SCORER_REGISTRY (its __init__ imports each module to fire @register_scorer).
# This MUST happen before build_pipeline is called.
from polar.xyne import reward_pipeline
from polar.xyne.reward_pipeline import RewardPipeline, XyneRewardConfig, XyneScorer
from polar.xyne.scorers import ALL_SCORERS  # noqa: F401  (fires registration)
from polar.xyne.types import XyneRawFlow

__all__ = ["XyneCompositeEvaluator"]

logger = logging.getLogger(__name__)

# Length caps for trimming raw-flow metadata before attaching to EvalResult.
_MAX_DEBUG_EVENTS = 100
_MAX_NESTED_RUNS = 100
_MAX_REQUEST_MESSAGES = 20

# ---------------------------------------------------------------------------
# Per-scorer config plumbing
# ---------------------------------------------------------------------------


def _copy_capped(values: Any, limit: int) -> Any:
    """Return ``values`` truncated to ``limit`` elements (or as-is if not a list)."""
    if isinstance(values, list) and len(values) > limit:
        return values[:limit]
    return values


def _trim_flow(flow: XyneRawFlow) -> dict[str, Any]:
    """Serialize a flow for metadata, bounding the potentially huge lists."""
    data = flow.to_dict()
    if isinstance(data.get("debug_events"), list):
        data["debug_events"] = _copy_capped(data["debug_events"], _MAX_DEBUG_EVENTS)
    if isinstance(data.get("nested_runs"), list):
        data["nested_runs"] = _copy_capped(data["nested_runs"], _MAX_NESTED_RUNS)
    if isinstance(data.get("request_messages"), list):
        data["request_messages"] = _copy_capped(
            data["request_messages"], _MAX_REQUEST_MESSAGES
        )
    return data


def _parse_raw(raw: Any) -> XyneRawFlow:
    """Parse ``metadata["xyne_raw"]`` which may be a dict or a JSON string."""
    if isinstance(raw, dict):
        return XyneRawFlow.from_dict(raw)
    if isinstance(raw, str):
        return XyneRawFlow.from_json(raw)
    raise ValueError("xyne_raw must be a dict or JSON string")


def _detect_incomplete_agentic(flow: XyneRawFlow) -> str | None:
    """Detect stopReason=toolUse with no executed/persisted tools.

    Gateway completions often show ``finish_reason=tool_calls`` while the
    Xyne ``/dump`` has empty ``toolCalls`` and only a planning stub answer.
    Those turns must not earn completion/format/efficiency baseline reward.
    """
    meta = flow.metadata if isinstance(flow.metadata, dict) else {}
    marked = meta.get("incomplete_agentic")
    if isinstance(marked, str) and marked.strip():
        return marked.strip()
    if flow.tool_calls or flow.tool_use_blocks:
        return None
    stop: str | None = None
    if isinstance(flow.finish_reason, str) and flow.finish_reason.strip():
        stop = flow.finish_reason.strip()
    for event in flow.debug_events or []:
        if not isinstance(event, dict):
            continue
        raw = event.get("stopReason") or event.get("finish_reason")
        if isinstance(raw, str) and raw.strip():
            stop = raw.strip()
    if not stop:
        return None
    normalized = stop.replace("_", "").casefold()
    if normalized in {"tooluse", "toolcalls"}:
        return (
            f"incomplete agentic: stopReason={stop} but toolCalls empty"
        )
    return None


def _normalize_judge(judge: Any) -> dict[str, Any]:
    """Normalize a user-facing ``judge`` dict to llm_judge scorer config keys."""
    if not isinstance(judge, dict):
        return {}
    cfg: dict[str, Any] = {}
    if judge.get("base_url"):
        cfg["judge_base_url"] = judge["base_url"]
    if judge.get("api_key"):
        cfg["judge_api_key"] = judge["api_key"]
    if judge.get("model"):
        cfg["judge_model"] = judge["model"]
    # Pass through any explicitly-named judge config keys (e.g. _transport,
    # prompt_template, timeout) that callers may set directly.
    for key in ("judge_base_url", "judge_api_key", "judge_model", "prompt_template",
                "timeout", "_transport", "dimension_weights", "max_concurrency",
                "max_tokens"):
        if key not in judge:
            continue
        # envsubst of unset XYNE_JUDGE_MAX_* leaves YAML null; skip so
        # llm_judge can apply its documented defaults.
        if key in ("max_tokens", "max_concurrency") and judge[key] in (None, ""):
            continue
        cfg[key] = judge[key]
    # Pass through any per-dimension enable toggles (enable_quality,
    # enable_correctness, ...) verbatim, so the llm_judge scorer can read them.
    for key in judge:
        if str(key).startswith("enable_"):
            cfg[key] = judge[key]
    # The gateway can point judge traffic at its colocated inference router
    # without requiring trainer-specific config changes.
    if base_url := os.environ.get("POLAR_XYNE_JUDGE_BASE_URL"):
        cfg["judge_base_url"] = base_url
    if model := os.environ.get("POLAR_XYNE_JUDGE_MODEL"):
        cfg["judge_model"] = model
    if api_key := os.environ.get("POLAR_XYNE_JUDGE_API_KEY"):
        cfg["judge_api_key"] = api_key
    return cfg


def _build_pipeline(config: dict[str, Any]) -> RewardPipeline:
    """Build a RewardPipeline forwarding per-scorer config (additive seam).

    ``build_pipeline`` in reward_pipeline does not forward unknown per-scorer
    keys (T4 known limitation), so this helper re-implements the construction
    loop locally: it parses the normalized scorer entries and hands each scorer
    a per-scorer config dict directly. Weight/enabled come from the normalized
    entry; per-scorer config aggregates (a) top-level hints and (b) the
    entry's own keys.
    """
    parsed: XyneRewardConfig = XyneRewardConfig.from_dict(config)
    top_expected = config.get("expected_doc_ids")
    top_expected_chunks = config.get("expected_chunk_ids")
    top_reference = config.get("reference_answer")
    top_judge = _normalize_judge(config.get("judge"))

    # Raw per-scorer entries (unedited) keyed by name for lookup.
    raw_entries = {
        str(entry.get("name")): entry
        for entry in config.get("scorers", [])
        if isinstance(entry, dict) and entry.get("name")
    }

    pipeline = RewardPipeline()
    for scorer_cfg in parsed.scorers:
        cls = reward_pipeline.SCORER_REGISTRY.get(scorer_cfg.name)
        if cls is None:
            raise ValueError(
                f"no scorer registered under name {scorer_cfg.name!r}"
            )
        pipeline.add(
            _instantiate_scorer(
                cls,
                name=scorer_cfg.name,
                weight=scorer_cfg.weight,
                enabled=scorer_cfg.enabled,
                top_expected=top_expected,
                top_expected_chunks=top_expected_chunks,
                top_reference=top_reference,
                top_judge=top_judge,
                entry=raw_entries.get(scorer_cfg.name, {}),
            )
        )
    return pipeline


def _instantiate_scorer(
    cls: type[XyneScorer],
    *,
    name: str,
    weight: float,
    enabled: bool,
    top_expected: Any,
    top_expected_chunks: Any,
    top_reference: Any,
    top_judge: dict[str, Any],
    entry: dict[str, Any],
) -> XyneScorer:
    """Construct one scorer with its per-scorer config dict."""
    per_scorer: dict[str, Any] = {}

    if name == "citation_accuracy":
        expected = entry.get("expected_doc_ids", top_expected)
        if expected is not None:
            per_scorer["expected_doc_ids"] = expected

    if name in {
        "gold_evidence_coverage",
        "citation_evidence_coverage",
        "tool_evidence_utility",
    }:
        expected = entry.get("expected_doc_ids", top_expected)
        expected_chunks = entry.get("expected_chunk_ids", top_expected_chunks)
        if expected is not None:
            per_scorer["expected_doc_ids"] = expected
        if expected_chunks is not None:
            per_scorer["expected_chunk_ids"] = expected_chunks
        for key in (
            "exact_weight",
            "coverage_weight",
            "semantic_enabled",
            "vespa_document_url",
            "vespa_timeout",
            "vector_cache_documents",
            "_vector_provider",
        ):
            if key in entry:
                per_scorer[key] = entry[key]

    if name == "embedding_similarity":
        reference = entry.get("reference_answer", top_reference)
        if reference is not None:
            per_scorer["reference_answer"] = reference
        for key in ("method", "model"):
            if key in entry:
                per_scorer[key] = entry[key]

    if name == "llm_judge":
        judge = dict(top_judge)
        # Entry-level judge keys override top-level normalized judge config.
        for key in ("judge_base_url", "judge_api_key", "judge_model",
                    "prompt_template", "timeout", "_transport",
                    "dimension_weights", "max_concurrency", "max_tokens"):
            if key in entry:
                judge[key] = entry[key]
        # Forward any per-scorer enable_<dim> toggle so it overrides the
        # top-level normalized config for this scorer.
        for key in entry:
            if str(key).startswith("enable_"):
                judge[key] = entry[key]
        if judge:
            per_scorer.update(judge)
        # A weight nested in the top-level judge dict applies to llm_judge
        # (unless the entry set its own weight, which it cannot here — the
        # normalized entry weight already passed in `weight`).
        if top_judge.get("weight") is not None and "weight" not in per_scorer:
            per_scorer["weight"] = top_judge["weight"]

    if name == "token_efficiency":
        # Token counts/budget come through the per-scorer entry as config; the
        # evaluator injects the trajectory-derived totals before building.
        for key in ("total_completion_tokens", "total_prompt_tokens",
                    "budget_tokens"):
            if key in entry:
                per_scorer[key] = entry[key]

    return cls(config=per_scorer, weight=weight, enabled=enabled)


def _inject_token_counts(
    config: dict[str, Any], trajectory: Trajectory
) -> dict[str, Any]:
    """Merge trajectory-derived token totals into the token_efficiency entry.

    Recomputes the completion/prompt token totals over ``trajectory.traces``
    and merges them into the raw ``token_efficiency`` scorer entry (under
    ``total_completion_tokens`` / ``total_prompt_tokens``) so the scorer can
    read them from its per-scorer config. Returns a shallow copy and never
    mutates the caller's config (which is reused across evaluations). Entries
    that already set a count win, so an explicit config always overrides.
    """
    scorers = config.get("scorers")
    if not isinstance(scorers, list):
        return config

    has_token = any(
        isinstance(e, dict) and e.get("name") == "token_efficiency"
        for e in scorers
    )
    if not has_token:
        return config

    total_completion = sum(
        len(t.response_ids) for t in trajectory.traces if t.response_ids
    )
    total_prompt = sum(
        len(t.prompt_ids) for t in trajectory.traces if t.prompt_ids
    )

    new_scorers: list[Any] = []
    for entry in scorers:
        if isinstance(entry, dict) and entry.get("name") == "token_efficiency":
            merged = dict(entry)
            merged.setdefault("total_completion_tokens", total_completion)
            merged.setdefault("total_prompt_tokens", total_prompt)
            new_scorers.append(merged)
        else:
            new_scorers.append(entry)

    new_config = dict(config)
    new_config["scorers"] = new_scorers
    return new_config


class XyneCompositeEvaluator(BaseTrajectoryEvaluator):
    """Composite reward evaluator for one raw Xyne agentic flow.

    Reads ``trajectory.metadata["xyne_raw"]``, parses it into an
    :class:`XyneRawFlow`, runs a configured :class:`RewardPipeline`, and
    returns a weighted-average reward. Returns ``0.0`` (via ``outcome_reward``)
    when the raw flow is missing or malformed — it never raises out of
    :meth:`evaluate`.
    """

    def __init__(self, **config: Any) -> None:
        super().__init__(**config)
        # `config` mirrors EvaluatorSpec.config (registry: cls(**spec.config)).
        self.config: dict[str, Any] = dict(config)

    async def evaluate(self, trajectory: Trajectory, **runtime: Any) -> EvalResult:
        raw = trajectory.metadata.get("xyne_raw")
        if raw is None:
            # Issue 37: Check if partial metadata exists (tool calls, chunks)
            # even without a full xyne_raw flow. Log the reason for observability.
            partial_meta = {}
            traj_meta = trajectory.metadata.get("trajectory_metadata") or {}
            ev = traj_meta.get("evaluation") or {}
            if ev.get("result_timeout"):
                partial_meta["reason"] = "session_timeout"
            elif trajectory.metadata.get("xyne_raw_error"):
                partial_meta["reason"] = "raw_read_error"
                partial_meta["detail"] = str(trajectory.metadata.get("xyne_raw_error"))
            elif trajectory.metadata.get("xyne_exec_error"):
                partial_meta["reason"] = "exec_error"
            else:
                partial_meta["reason"] = "no_raw_flow"
            return EvalResult(outcome_reward=0.0, metadata={"error": "missing xyne_raw", **partial_meta})

        try:
            flow = _parse_raw(raw)
            # The gold answer belongs to the task/evaluator config, not the
            # Xyne HTTP dump. Attach it to this local flow copy so both the
            # deterministic similarity scorer and the LLM judge compare
            # against the same reference without mutating the trajectory.
            reference = self.config.get("reference_answer")
            if isinstance(reference, str) and reference.strip():
                flow.metadata = dict(flow.metadata)
                flow.metadata.setdefault("reference_answer", reference)

            # Completion/format are safety gates, not positive reward. A
            # failed or empty run must never receive a baseline merely because
            # other heuristic scorers defaulted optimistically.
            # Also gate incomplete agentic turns: stopReason=toolUse with no
            # executed tools (planning stub only) — same as fetch_flow's
            # incomplete_agentic marker when present on the raw dump.
            incomplete = _detect_incomplete_agentic(flow)
            if (
                flow.error is not None
                or incomplete
                or not (flow.answer and flow.answer.strip())
            ):
                return EvalResult(
                    outcome_reward=0.0,
                    metadata={
                        "failure_gate": True,
                        "raw_flow": _trim_flow(flow),
                        **(
                            {"incomplete_agentic": incomplete}
                            if incomplete
                            else {}
                        ),
                    },
                )
            pipeline = _build_pipeline(_inject_token_counts(self.config, trajectory))
            composite, per_scorer = await asyncio.to_thread(
                pipeline.run_with_scores, flow
            )
        except Exception as exc:
            # Never raise out of evaluation; malformed input -> 0.0.
            logger.exception("XyneCompositeEvaluator failed")
            return EvalResult(
                outcome_reward=0.0,
                metadata={
                    "error": "failed to evaluate",
                    "exception": f"{type(exc).__name__}: {exc}",
                },
            )

        try:
            scorer_io = pipeline.scorer_details()
        except Exception:
            scorer_io = {}
        # Include gold/doc IDs and reference in metadata so the trainer can
        # compute MI, NDCG, gold_coverage, diversity, and shared_answer.
        import logging as _log
        _log.getLogger(__name__).warning("EVALUATOR_CONFIG_DEBUG: expected_doc_ids=%s expected_chunk_ids=%s reference=%s config_keys=%s", self.config.get("expected_doc_ids"), self.config.get("expected_chunk_ids"), str(self.config.get("reference_answer"))[:100], list(self.config.keys()))
        # Extract gold IDs from config first
        gold_meta: dict[str, Any] = {}
        expected_docs = self.config.get("expected_doc_ids")
        expected_chunks = self.config.get("expected_chunk_ids")
        reference = self.config.get("reference_answer")
        # Fallback: extract gold IDs from the scorer objects themselves
        if not expected_docs or not expected_chunks:
            for scorer in pipeline._scorers:
                if scorer.name == "gold_evidence_coverage":
                    if not expected_chunks and getattr(scorer, "gold_chunks", None):
                        expected_chunks = sorted(scorer.gold_chunks)
                    if not expected_docs and getattr(scorer, "gold_documents", None):
                        expected_docs = sorted(scorer.gold_documents)
                    break
        if not reference:
            for scorer in pipeline._scorers:
                if scorer.name == "embedding_similarity":
                    ref = getattr(scorer, "reference_answer", None)
                    if ref:
                        reference = ref
                    break
        expected_docs = self.config.get("expected_doc_ids")
        expected_chunks = self.config.get("expected_chunk_ids")
        reference = self.config.get("reference_answer")
        if expected_docs:
            gold_meta["expected_doc_ids"] = expected_docs
        if expected_chunks:
            gold_meta["gold_chunk_ids"] = expected_chunks
        if reference:
            gold_meta["reference_answer"] = reference

        metadata: dict[str, Any] = {
            "per_scorer": per_scorer,
            "raw_flow": _trim_flow(flow),
            "scorer_io": scorer_io,
            **gold_meta,
        }
        return EvalResult(outcome_reward=float(composite), metadata=metadata)
