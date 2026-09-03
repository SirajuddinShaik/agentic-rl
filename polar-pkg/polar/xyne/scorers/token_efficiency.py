"""Token-efficiency scorer: penalize runs that generate excessive tokens.

The completion-token count reaches this scorer through two channels, in
priority order:

1. **Raw-flow telemetry** — :class:`XyneRawFlow` carries a first-class
   ``token_usage`` dict (from the last MAIN-run assistant message's
   ``stats.tokenUsage``). This is authoritative because trajectory traces may
   duplicate cumulative prefixes.
2. **Config fallback** — evaluator-computed trace totals are used only when
   raw-flow telemetry is absent.

The completion-token count ``c`` is mapped to a ``[0, 1]`` score with a
configurable ``budget_tokens`` (int, default 4096):

    score = budget_tokens / (budget_tokens + c)

When neither a config-injected count nor a non-empty ``flow.token_usage`` is
available (telemetry not measured), the scorer returns ``1.0`` (neutral) and
never penalizes — a run must not be punished for a count that was not
measured. The token count and budget are kept on ``last_count`` /
``budget_tokens`` so tests can assert them.
"""

from __future__ import annotations

from polar.xyne.reward_pipeline import XyneScorer, register_scorer
from polar.xyne.types import XyneRawFlow

__all__ = ["TokenEfficiencyScorer"]

NAME = "token_efficiency"

_DEFAULT_BUDGET_TOKENS = 4096


@register_scorer(NAME)
class TokenEfficiencyScorer(XyneScorer):
    """Reward token efficiency as a function of completion tokens vs a budget."""

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
        raw_budget = cfg.get("budget_tokens", _DEFAULT_BUDGET_TOKENS)
        self.budget_tokens = int(raw_budget) if raw_budget is not None else _DEFAULT_BUDGET_TOKENS
        raw_count = cfg.get("total_completion_tokens")
        self._count: int | None = (
            int(raw_count) if raw_count is not None else None
        )
        self.input_weight = float(cfg.get("input_weight", 0.05))
        self.last_count: int | None = self._count

    def score(self, flow: XyneRawFlow) -> float:
        count: int | None = None
        tu = flow.token_usage
        if tu:
            output = tu.get("output", tu.get("output_tokens", 0))
            prompt = tu.get("input", tu.get("input_tokens", 0))
            try:
                count = int(float(output) + self.input_weight * float(prompt))
            except (TypeError, ValueError):
                count = None
        if count is None:
            count = self._count
        self.last_count = count
        if count is None:
            return 1.0
        budget = self.budget_tokens
        if budget <= 0:
            return 0.0
        return budget / (budget + max(0, count))
