from __future__ import annotations

import pytest

from polar.xyne.reward_pipeline import (
    SCORER_REGISTRY,
    RewardPipeline,
    XyneRewardConfig,
    XyneScorer,
    build_pipeline,
    register_scorer,
)
from polar.xyne.types import XyneRawFlow


class FakeScorer(XyneScorer):
    """Test double returning a fixed score."""

    def __init__(self, score: float, name: str = "fake", **kwargs) -> None:
        super().__init__(**kwargs)
        self.name = name
        self._score = score

    def score(self, flow: XyneRawFlow) -> float:
        return self._score


def _flow() -> XyneRawFlow:
    return XyneRawFlow(
        conversation_id="conv-1",
        run_id="run-1",
        request_messages=[{"role": "user", "content": "hi"}],
        answer="hello world",
    )


def test_single_enabled_scorer_returns_its_score() -> None:
    pipeline = RewardPipeline()
    pipeline.add(FakeScorer(score=0.7, weight=1.0, enabled=True))

    assert pipeline.run(_flow()) == pytest.approx(0.7)


def test_two_scorers_weighted_average() -> None:
    # weights (2, 1) and scores (0.0, 1.0) -> (2*0.0 + 1*1.0) / 3 = 1/3
    pipeline = RewardPipeline()
    pipeline.add(FakeScorer(score=0.0, weight=2.0, enabled=True))
    pipeline.add(FakeScorer(score=1.0, weight=1.0, enabled=True))

    assert pipeline.run(_flow()) == pytest.approx(1.0 / 3.0)


def test_all_scorers_disabled_returns_zero() -> None:
    pipeline = RewardPipeline()
    pipeline.add(FakeScorer(score=0.9, weight=1.0, enabled=False))
    pipeline.add(FakeScorer(score=0.8, weight=1.0, enabled=False))

    assert pipeline.run(_flow()) == 0.0


def test_empty_pipeline_returns_zero() -> None:
    assert RewardPipeline().run(_flow()) == 0.0


def test_config_defaults_weight_and_enabled() -> None:
    config = XyneRewardConfig.from_dict(
        {"scorers": [{"name": "fake", "score": 0.5}]}
    )
    scorer_cfg = config.scorers[0]

    assert scorer_cfg.weight == 1.0
    assert scorer_cfg.enabled is True


def test_unregistered_scorer_raises_value_error() -> None:
    with pytest.raises(ValueError, match="no scorer registered"):
        build_pipeline({"scorers": [{"name": "does_not_exist"}]})


def test_per_scorer_scores_returns_enabled_names_only() -> None:
    pipeline = RewardPipeline()
    pipeline.add(FakeScorer(score=0.2, weight=1.0, enabled=True))
    pipeline.add(FakeScorer(score=0.8, weight=1.0, enabled=False))

    assert pipeline.per_scorer_scores(_flow()) == {"fake": 0.2}


def test_register_scorer_powers_build_pipeline() -> None:
    name = "test_fake_completion"

    @register_scorer(name)
    class _FakeCompletionScorer(XyneScorer):
        name = "test_fake_completion"

        def score(self, flow: XyneRawFlow) -> float:
            return 0.5

    try:
        pipeline = build_pipeline({"scorers": [{"name": name, "weight": 2.0}]})

        assert SCORER_REGISTRY[name] is _FakeCompletionScorer
        assert pipeline.run(_flow()) == pytest.approx(0.5)
    finally:
        SCORER_REGISTRY.pop(name, None)
