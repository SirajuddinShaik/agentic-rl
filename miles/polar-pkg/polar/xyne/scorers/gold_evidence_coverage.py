"""Reward retrieval coverage against dataset-provided gold evidence."""

from __future__ import annotations

from typing import Any

from polar.xyne.reward_pipeline import XyneScorer, register_scorer
from polar.xyne.scorers.evidence_common import (
    document_id,
    evidence_coverage,
    expected_chunk_ids,
    retrieved_chunk_ids,
    vector_provider_from_config,
)
from polar.xyne.types import XyneRawFlow

NAME = "gold_evidence_coverage"


@register_scorer(NAME)
class GoldEvidenceCoverageScorer(XyneScorer):
    """Combine exact chunk recall with similarity to neighboring Vespa chunks."""

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
        values = cfg.get("expected_doc_ids", [])
        if not isinstance(values, (list, tuple, set, frozenset)):
            values = []
        self.gold_documents = {
            str(value) for value in values if value
        }
        self.exact_weight = float(cfg.get("exact_weight", 0.5))
        self.vector_provider = vector_provider_from_config(cfg)
        self.last_metrics: dict[str, float] = {}

    def score(self, flow: XyneRawFlow) -> float:
        observed = retrieved_chunk_ids(flow)
        if self.gold_chunks:
            score, exact, semantic = evidence_coverage(
                observed,
                self.gold_chunks,
                self.vector_provider,
                exact_weight=self.exact_weight,
            )
            self.last_metrics = {
                "combined": score,
                "exact_recall": exact,
                "semantic_recall": semantic,
            }
            return score

        if not self.gold_documents:
            self.last_metrics = {"document_recall": 0.0}
            return 0.0
        observed_documents = {document_id(chunk) for chunk in observed}
        score = len(observed_documents & self.gold_documents) / len(self.gold_documents)
        self.last_metrics = {"document_recall": score}
        return score


__all__ = ["GoldEvidenceCoverageScorer"]
