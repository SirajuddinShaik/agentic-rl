"""Citation-presence scorer: rewards runs that retrieved at least one citation.

Grounding is a prerequisite for a good answer here; a run with zero citations
(scored 0.0) failed to ground its response, regardless of how the answer text
reads. The scorer is permissive about citation shape: any non-empty iterable
counts as presence.
"""

from __future__ import annotations

from polar.xyne.reward_pipeline import XyneScorer, register_scorer
from polar.xyne.types import XyneRawFlow

__all__ = ["CitationPresenceScorer"]

NAME = "citation_presence"


@register_scorer(NAME)
class CitationPresenceScorer(XyneScorer):
    """1.0 iff at least one citation has a resolvable document identifier."""

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
        return 1.0 if any(
            isinstance(item, dict)
            and bool(item.get("docId") or item.get("itemId"))
            for item in flow.citations
        ) else 0.0
