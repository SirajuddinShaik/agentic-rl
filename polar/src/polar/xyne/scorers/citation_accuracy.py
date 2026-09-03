"""Citation-accuracy scorer: how many citations match expected document IDs.

The scorer answers "did the agent ground on the documents we expected?" via the
config key ``expected_doc_ids`` (a list or set of document identifiers). A
citation matches if its ``itemId`` OR ``docId`` is in the expected set.

Semantics (documented and locked by tests):

- ``expected_doc_ids`` empty -> ``1.0``. No expectation means no penalty; an
  empty expectation set is not a failure to meet.
- Expected set non-empty and no citations match -> ``0.0``.
- Expected set non-empty -> document-set F1 between cited and expected IDs.
  This rewards coverage while penalizing unrelated citation spam.

Citations that are non-dict or carry no identifier simply never match and are
counted in the denominator, dragging the fraction down.
"""

from __future__ import annotations

from collections.abc import Mapping

from polar.xyne.reward_pipeline import XyneScorer, register_scorer
from polar.xyne.types import XyneRawFlow

__all__ = ["CitationAccuracyScorer"]

NAME = "citation_accuracy"


def _citation_id(item: object) -> str | None:
    """Return the identifier used for matching: itemId, else docId, else None."""
    if not isinstance(item, Mapping):
        return None
    item_id = item.get("itemId")
    if isinstance(item_id, str) and item_id:
        return item_id
    doc_id = item.get("docId")
    if isinstance(doc_id, str) and doc_id:
        return doc_id
    return None


@register_scorer(NAME)
class CitationAccuracyScorer(XyneScorer):
    """Fraction of citations whose itemId/docId is in the expected set."""

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
        raw = cfg.get("expected_doc_ids", [])
        self._expected: set[str] = {
            str(v) for v in raw if v is not None
        } if isinstance(raw, (list, tuple, set, frozenset)) else set()

    def score(self, flow: XyneRawFlow) -> float:
        if not self._expected:
            return 1.0
        citations = flow.citations
        if not citations:
            return 0.0
        cited = {
            identifier for item in citations
            if (identifier := _citation_id(item)) is not None
        }
        matched = len(cited & self._expected)
        if matched == 0 or not cited:
            return 0.0
        precision = matched / len(cited)
        recall = matched / len(self._expected)
        return 2.0 * precision * recall / (precision + recall)
