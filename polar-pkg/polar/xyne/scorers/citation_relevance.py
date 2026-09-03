"""Citation-relevance scorer: mean of citation ``relevance`` values.

Scores the average retrieval relevance across all citations. Semantics:

- No citations -> ``0.0`` (nothing retrieved to be relevant).
- A citation is included in the mean only if its ``relevance`` is a finite
  number in ``[0, 1]``. Missing/None relevance and non-numeric values are
  treated as ``0.0`` (they contribute nothing relevant).
- A citation that is a non-dict item (or lacks ``relevance``) contributes
  ``0.0`` rather than raising.

The numerator counts every citation as a denominator slot, so malformed
citations drag the score down instead of silently inflating it. The result is
clamped to ``[0.0, 1.0]``.
"""

from __future__ import annotations

from collections.abc import Mapping
from math import isfinite

from polar.xyne.reward_pipeline import XyneScorer, register_scorer
from polar.xyne.types import XyneRawFlow

__all__ = ["CitationRelevanceScorer"]

NAME = "citation_relevance"


def _relevance_of(item: object) -> float:
    """Return a usable relevance in [0,1] for one citation item, else 0.0."""
    if not isinstance(item, Mapping):
        return 0.0
    value = item.get("relevance")
    if isinstance(value, str):
        try:
            value = float(value)
        except ValueError:
            return 0.0
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return 0.0
    if not isfinite(value):
        return 0.0
    return min(1.0, max(0.0, float(value)))


@register_scorer(NAME)
class CitationRelevanceScorer(XyneScorer):
    """Mean citation relevance over all citations, 0.0 when no citations."""

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
        citations = flow.citations
        if not citations:
            return 0.0
        total = sum(_relevance_of(item) for item in citations)
        return min(1.0, max(0.0, total / len(citations)))
