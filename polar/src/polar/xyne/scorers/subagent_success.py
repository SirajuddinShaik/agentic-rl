"""Sub-agent success scorer: all sub-agents must be error-free.

A run's sub-agents (the ``sub_agents`` list, e.g. from ``listNestedRuns``)
together succeeded iff every single one is free of an ``error`` field.
Semantics (documented and locked by tests):

- No sub-agents -> ``0.0``. The signal is not applicable and must not create
  free positive reward in a harness that does not use sub-agents.
- Some sub-agent has a non-None ``error`` -> ``0.0`` (one failure fails all).
- A sub-agent with no ``error`` field, or ``error`` explicitly ``None``,
  counts as successful. A non-dict item has no ``error`` so it is successful.

Backward compatibility: older dumps only carry the ``nested_runs`` tree. When
``sub_agents`` is empty but ``nested_runs`` is non-empty, we fall back to
evaluating the ``nested_runs`` error check so old dumps still score correctly.
"""

from __future__ import annotations

from collections.abc import Mapping

from polar.xyne.reward_pipeline import XyneScorer, register_scorer
from polar.xyne.types import XyneRawFlow

__all__ = ["SubagentSuccessScorer"]

NAME = "subagent_success"


def _has_error(item: object) -> bool:
    """True if ``item`` (or its nested ``run``) carries a non-None error."""
    if not isinstance(item, Mapping):
        return False
    if item.get("error") is not None:
        return True
    run = item.get("run")
    if isinstance(run, Mapping) and run.get("error") is not None:
        return True
    return False


@register_scorer(NAME)
class SubagentSuccessScorer(XyneScorer):
    """1.0 iff at least one sub-agent ran and every sub-agent is error-free."""

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
        sub_agents = flow.sub_agents
        if sub_agents:
            for agent in sub_agents:
                if _has_error(agent):
                    return 0.0
            return 1.0
        # Fallback for old dumps that only populate nested_runs.
        nested_runs = flow.nested_runs
        if not nested_runs:
            return 0.0
        for run in nested_runs:
            if not isinstance(run, Mapping) or run.get("error") is not None:
                return 0.0
        return 1.0
