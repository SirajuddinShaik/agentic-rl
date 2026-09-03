"""Reward retrieval calls by their marginal contribution to useful evidence."""

from __future__ import annotations

from typing import Any

from polar.xyne.reward_pipeline import XyneScorer, register_scorer
from polar.xyne.scorers.evidence_common import (
    citation_chunk_ids,
    evidence_coverage,
    expected_chunk_ids,
    retrieval_calls,
    tool_call_chunk_ids,
    vector_provider_from_config,
)
from polar.xyne.types import XyneRawFlow

NAME = "tool_evidence_utility"


@register_scorer(NAME)
class ToolEvidenceUtilityScorer(XyneScorer):
    """Credit calls that add gold evidence or supply a chunk cited in the answer."""

    name = NAME

    def __init__(
        self,
        config: dict[str, Any] | None = None,
        *,
        weight: float = 1.0,
        enabled: bool = True,
    ) -> None:
        cfg = config or {}
        super().__init__(
            weight=float(cfg.get("weight", weight)),
            enabled=bool(cfg.get("enabled", enabled)),
        )
        self.gold_chunks = expected_chunk_ids(cfg.get("expected_chunk_ids"))
        self.exact_weight = float(cfg.get("exact_weight", 0.5))
        self.coverage_weight = max(0.0, min(1.0, float(cfg.get("coverage_weight", 0.75))))
        self.vector_provider = vector_provider_from_config(cfg)
        self.last_metrics: dict[str, float] = {}

    def score(self, flow: XyneRawFlow) -> float:
        calls = retrieval_calls(flow)
        if not calls:
            self.last_metrics = {"calls": 0.0, "useful_call_ratio": 0.0}
            return 0.0

        cited = citation_chunk_ids(flow)
        cumulative: set[str] = set()
        previous_coverage = 0.0
        useful_calls = 0
        for call in calls:
            call_chunks = tool_call_chunk_ids(call)
            new_chunks = call_chunks - cumulative
            cumulative.update(call_chunks)
            coverage = 0.0
            if self.gold_chunks:
                coverage = evidence_coverage(
                    cumulative,
                    self.gold_chunks,
                    self.vector_provider,
                    exact_weight=self.exact_weight,
                )[0]
            adds_evidence = coverage > previous_coverage + 1e-9
            supplies_citation = bool(new_chunks & cited)
            if adds_evidence or supplies_citation:
                useful_calls += 1
            previous_coverage = max(previous_coverage, coverage)

        useful_ratio = useful_calls / len(calls)
        if not self.gold_chunks:
            score = useful_ratio
        else:
            score = (
                self.coverage_weight * previous_coverage
                + (1.0 - self.coverage_weight) * useful_ratio
            )
        self.last_metrics = {
            "calls": float(len(calls)),
            "useful_calls": float(useful_calls),
            "useful_call_ratio": useful_ratio,
            "final_coverage": previous_coverage,
        }
        return max(0.0, min(1.0, score))


__all__ = ["ToolEvidenceUtilityScorer"]
