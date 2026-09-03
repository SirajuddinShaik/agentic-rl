"""Pluggable reward pipeline for Xyne.

This module defines the *framework* for composing a scalar reward from a set
of pluggable per-aspect scorers. It deliberately implements **no** scorer
logic (completion, format, citations, ... are added by todo 4). It only owns
the seam that lets new scorers register with zero changes to this file.

Registry / plugin mechanism
---------------------------
Scorers plug in through a module-level registry plus a decorator::

    SCORER_REGISTRY: dict[str, type[XyneScorer]]

    @register_scorer("completion")
    class CompletionScorer(XyneScorer):
        ...

New scorers register in one place (the decorator at class-definition time)
and are picked up automatically by :func:`build_pipeline` via ``name``.

Reward composition
------------------
:meth:`RewardPipeline.run` returns the **weighted average** of all enabled
scorers::

    reward = sum(weight_i * score_i) / sum(weight_i)

If no scorer is enabled, or every enabled scorer has weight 0 (empty weight
sum), ``run`` returns ``0.0``.

Config tolerance
----------------
Each scorer config entry may omit fields:

- ``weight`` defaults to ``1.0``
- ``enabled`` defaults to ``True``

An unregister decoder raises :class:`ValueError`: a config naming a scorer
with no registered class is a configuration error best surfaced eagerly at
build time, rather than silently dropping an intended reward signal.

Decisions (see issue #T3)
-------------------------
- Unregistered scorer name -> ``ValueError`` on :func:`build_pipeline`.
- ``run`` is synchronous because every scorer is pure over
  :class:`~polar.xyne.types.XyneRawFlow`; the async evaluator (todo 5) awaits
  nothing here.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, TypeVar

if TYPE_CHECKING:
    from polar.xyne.types import XyneRawFlow

XyneScorerT = TypeVar("XyneScorerT", bound="XyneScorer")


class XyneScorer(ABC):
    """Abstract base for a single per-aspect reward signal.

    Concrete scorers subclass this and implement :meth:`score`, returning a
    float in ``0.0..1.0``. Construction is driven by a config dict so fields
    default sensibly and remain JSON-friendly.
    """

    name: str

    def __init__(self, weight: float = 1.0, enabled: bool = True) -> None:
        self.weight = float(weight)
        self.enabled = bool(enabled)

    @abstractmethod
    def score(self, flow: "XyneRawFlow") -> float:
        """Return a reward in ``0.0..1.0`` for one raw Xyne flow."""


# Registry of name -> scorer class. Filled by :func:`register_scorer`.
SCORER_REGISTRY: dict[str, type[XyneScorer]] = {}


def register_scorer(name: str) -> Callable[[type[XyneScorerT]], type[XyneScorerT]]:
    """Class decorator registering a scorer class under ``name``.

    Registration is idempotent per name for the same class; registering two
    distinct classes under one name raises :class:`ValueError` to surface a
    config collision early.
    """

    def _decorate(cls: type[XyneScorerT]) -> type[XyneScorerT]:
        existing = SCORER_REGISTRY.get(name)
        if existing is not None and existing is not cls:
            raise ValueError(
                f"scorer name {name!r} already registered to {existing.__name__!r}"
            )
        SCORER_REGISTRY[name] = cls
        return cls

    return _decorate


@dataclass(frozen=True, slots=True)
class XyneScorerConfig:
    """Normalized config for one scorer entry."""

    name: str
    weight: float = 1.0
    enabled: bool = True


@dataclass(frozen=True, slots=True)
class XyneRewardConfig:
    """Parsed reward-pipeline configuration.

    ``scorers`` is a list of normalized :class:`XyneScorerConfig`; ``judge``
    is reserved for the LLM-judge story (todo 4) and carried through opaque.
    """

    scorers: list[XyneScorerConfig] = field(default_factory=list)
    judge: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "XyneRewardConfig":
        """Parse a JSON-ish config dict, applying documented defaults.

        Each entry under ``scorers`` tolerates missing ``weight`` (default
        ``1.0``) and missing ``enabled`` (default ``True``). Unknown keys in an
        entry are ignored.
        """
        raw_scorers = raw.get("scorers", [])
        scorers = [
            XyneScorerConfig(
                name=entry["name"],
                weight=float(entry.get("weight", 1.0)),
                enabled=bool(entry.get("enabled", True)),
            )
            for entry in raw_scorers
        ]
        return cls(scorers=scorers, judge=dict(raw.get("judge", {})))


class RewardPipeline:
    """Composes enabled scorers into a single weighted-average reward.

    Build directly (``RewardPipeline()`` + :meth:`add`) or via the config
    helper :func:`build_pipeline`.
    """

    def __init__(self) -> None:
        self._scorers: list[XyneScorer] = []

    def add(self, scorer: XyneScorer) -> None:
        """Append a configured scorer to the pipeline (in order)."""
        self._scorers.append(scorer)

    def _enabled_scorers(self) -> list[XyneScorer]:
        return [s for s in self._scorers if s.enabled]

    def run(self, flow: "XyneRawFlow") -> float:
        """Return the weighted average of enabled scorers' scores.

        Returns ``0.0`` when no scorer is enabled or when the sum of enabled
        weights is zero (a division-by-zero guard).
        """
        composite, _ = self.run_with_scores(flow)
        return composite

    def run_with_scores(self, flow: "XyneRawFlow") -> tuple[float, dict[str, float]]:
        """Evaluate each enabled scorer once and return composite plus details."""
        relevant = self._enabled_scorers()
        evaluated = [(scorer, scorer.score(flow)) for scorer in relevant]
        scores = {scorer.name: score for scorer, score in evaluated}
        total_weight = sum(scorer.weight for scorer in relevant)
        if total_weight == 0.0:
            return 0.0, scores
        # Use each evaluated instance's own score. Looking it back up by name
        # corrupts the numerator when a config accidentally repeats a scorer.
        weighted = sum(scorer.weight * score for scorer, score in evaluated)
        return weighted / total_weight, scores

    def per_scorer_scores(self, flow: "XyneRawFlow") -> dict[str, float]:
        """Return ``{scorer_name: score}`` over all enabled scorers.

        Used by the evaluator (todo 5) to populate ``EvalResult.metadata``.
        """
        _, scores = self.run_with_scores(flow)
        return scores

    def scorer_details(self) -> dict[str, Any]:
        """Collect raw per-scorer diagnostics (e.g. LLM-judge input/output).

        Non-fatal: any scorer without ``raw_io`` is skipped; exceptions are
        swallowed so diagnostics never break evaluation.
        """
        details: dict[str, Any] = {}
        for scorer in self._scorers:
            getter = getattr(scorer, "raw_io", None)
            if not callable(getter):
                continue
            try:
                io = getter()
            except Exception:
                continue
            if io:
                details.setdefault(scorer.name, {}).update(io)
        return details





def build_pipeline(config: XyneRewardConfig | dict[str, Any]) -> RewardPipeline:
    """Build a :class:`RewardPipeline` from a reward config.

    Accepts either an ``XyneRewardConfig`` or a raw JSON-ish ``dict`` (parsed
    via :meth:`XyneRewardConfig.from_dict`). Raised :class:`ValueError` for a
    scorer name with no registered class documents the registry contract.
    """
    parsed = (
        config if isinstance(config, XyneRewardConfig) else XyneRewardConfig.from_dict(config)
    )
    pipeline = RewardPipeline()
    for scorer_cfg in parsed.scorers:
        scorer_cls = SCORER_REGISTRY.get(scorer_cfg.name)
        if scorer_cls is None:
            raise ValueError(f"no scorer registered under name {scorer_cfg.name!r}")
        pipeline.add(
            scorer_cls(weight=scorer_cfg.weight, enabled=scorer_cfg.enabled)
        )
    return pipeline
