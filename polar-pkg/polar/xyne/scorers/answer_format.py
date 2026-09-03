"""Answer-format scorer: penalizes empty answers and errored runs.

An answer is "well formed" only if the model produced non-whitespace content
(``answer`` stripped is non-empty) AND the run did not error. Both conditions
must hold; a run that errored is not rewarded even if it emitted partial text.
"""

from __future__ import annotations

from polar.xyne.reward_pipeline import XyneScorer, register_scorer
from polar.xyne.types import XyneRawFlow

__all__ = ["AnswerFormatScorer"]

NAME = "answer_format"


@register_scorer(NAME)
class AnswerFormatScorer(XyneScorer):
    """1.0 iff ``answer`` is non-empty (stripped) and ``flow.error is None``."""

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
        answer_present = bool(flow.answer and flow.answer.strip())
        return 1.0 if (answer_present and flow.error is None) else 0.0
