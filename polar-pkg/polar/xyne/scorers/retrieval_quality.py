"""Retrieval-quality scorer over the evidence actually used by Xyne.

The Xyne harness retrieves directly through Vespa tools and normally has no
sub-agent runs. Reward retrieval using three observable signals instead:

* successful retrieval-tool execution (40%),
* best normalized Vespa relevance among retrieved chunks (30%), and
* cited chunks that resolve back to retrieved evidence (30%).

This avoids the previous constant 0.5 reward created by treating an empty
sub-agent list as a successful retrieval.
"""

from __future__ import annotations

from polar.xyne.reward_pipeline import XyneScorer, register_scorer
from polar.xyne.types import XyneRawFlow

__all__ = ["RetrievalQualityScorer"]

NAME = "retrieval_quality"

_TOOL_WEIGHT = 0.4
_EVIDENCE_WEIGHT = 0.3
_CITATION_WEIGHT = 0.3
_RETRIEVAL_TOOL_MARKERS = ("search", "getchunks", "proximity", "foldertree")


def _retrieval_tool_success(flow: XyneRawFlow) -> float:
    calls = [
        call for call in flow.tool_calls
        if isinstance(call, dict)
        and any(marker in str(call.get("toolName") or "").casefold()
                for marker in _RETRIEVAL_TOOL_MARKERS)
    ]
    if not calls:
        return 0.0
    successful = sum(
        1 for call in calls
        if not call.get("isError")
        and str(call.get("status") or "completed").casefold()
        not in {"failed", "error", "cancelled", "canceled"}
        and call.get("result") not in (None, "", [], {})
    )
    return successful / len(calls)


def _best_evidence_relevance(flow: XyneRawFlow) -> float:
    values = [
        float(chunk["relevance"])
        for chunk in flow.retrieved_chunks
        if isinstance(chunk, dict)
        and isinstance(chunk.get("relevance"), (int, float))
    ]
    if not values:
        return 0.0
    return max(0.0, min(1.0, max(values)))


def _citation_evidence_coverage(flow: XyneRawFlow) -> float:
    if not flow.citations:
        return 0.0
    evidence = {
        (item.get("docId"), item.get("chunk", item.get("chunkIndex")))
        for item in flow.retrieved_chunks
        if isinstance(item, dict)
    }
    resolved = sum(
        1 for citation in flow.citations
        if isinstance(citation, dict)
        and (citation.get("docId"), citation.get("chunk", citation.get("chunkIndex")))
        in evidence
    )
    return resolved / len(flow.citations)


@register_scorer(NAME)
class RetrievalQualityScorer(XyneScorer):
    """Combined retrieval execution, evidence relevance, and citation coverage."""

    name = NAME

    def __init__(
        self,
        config: dict | None = None,
        *,
        weight: float = 1.0,
        enabled: bool = True,
    ) -> None:
        cfg = config or {}
        super().__init__(
            weight=float(cfg.get("weight", weight)),
            enabled=bool(cfg.get("enabled", enabled)),
        )
    def score(self, flow: XyneRawFlow) -> float:
        score = (
            _TOOL_WEIGHT * _retrieval_tool_success(flow)
            + _EVIDENCE_WEIGHT * _best_evidence_relevance(flow)
            + _CITATION_WEIGHT * _citation_evidence_coverage(flow)
        )
        return min(1.0, max(0.0, score))
