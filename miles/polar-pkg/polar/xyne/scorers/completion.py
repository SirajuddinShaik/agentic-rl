"""Completion scorer: whether the agentic run completed without error.

This scorer rewards a run that produced a finished, error-free answer. The
``error`` field of :class:`XyneRawFlow` is the authoritative signal: a run
that raised or was aborted mid-flight carries a non-None error and scores 0.0;
a clean run scores 1.0. There is deliberately no middle ground — completion is
binary.
"""

from __future__ import annotations

from polar.xyne.reward_pipeline import XyneScorer, register_scorer
from polar.xyne.types import XyneRawFlow

__all__ = ["CompletionScorer"]

NAME = "completion"


@register_scorer(NAME)
class CompletionScorer(XyneScorer):
    """1.0 iff the run has no error, else 0.0."""

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
        return 1.0 if flow.error is None else 0.0
