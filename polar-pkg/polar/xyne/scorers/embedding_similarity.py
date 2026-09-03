"""Embedding-similarity scorer: how close is the generated answer to a reference.

This scorer compares the run's ``answer`` to a reference answer supplied via
the config key ``reference_answer`` and returns a similarity in ``[0, 1]``.

Two methods are supported, selected by the optional config key ``method``:

- ``"f1"`` (default): dependency-free SQuAD-style token-overlap F1. Tokens are
  produced by lowercasing and splitting on non-word characters (whitespace and
  punctuation), then the multiset-precision/recall F1 of the overlap between
  the generated and reference tokens is computed.
- ``"embedding"``: cosine similarity of sentence embeddings via
  ``sentence-transformers`` (model per config key ``model``, default
  ``"all-MiniLM-L6-v2"``). The import is lazy (inside :meth:`score`) and
  guarded by :class:`ImportError`; if ``sentence-transformers`` is not
  installed it falls back to the F1 method rather than raising. This keeps the
  module pure-stdlib at import time — ``sentence-transformers`` is never a
  hard dependency.

Guards (never raises, bounded [0,1]):

- ``reference_answer`` missing or empty -> ``0.0``.
- ``flow.answer`` empty -> ``0.0``.

This scorer needs no trajectory context; the reference is static config, so it
can be instantiated purely from the per-scorer config dict.
"""

from __future__ import annotations

import re
from collections import Counter

from polar.xyne.reward_pipeline import XyneScorer, register_scorer
from polar.xyne.types import XyneRawFlow

__all__ = ["EmbeddingSimilarityScorer"]

NAME = "embedding_similarity"

# Match word characters only, so both whitespace and punctuation are dropped.
_WORD_RE = re.compile(r"\w+")


def _tokens(text: str) -> list[str]:
    """SQuAD-style tokenization: lowercase, split on non-word characters."""
    return [t.lower() for t in _WORD_RE.findall(text)]


def _f1_overlap(gold_tokens: list[str], pred_tokens: list[str]) -> float:
    """SQuAD F1 over two token lists (multiset precision/recall overlap)."""
    if not gold_tokens or not pred_tokens:
        return 0.0
    gold_count = Counter(gold_tokens)
    pred_count = Counter(pred_tokens)

    common = sum((gold_count & pred_count).values())
    if common == 0:
        return 0.0
    precision = common / len(pred_tokens)
    recall = common / len(gold_tokens)
    if precision + recall == 0.0:
        return 0.0
    return 2.0 * precision * recall / (precision + recall)


@register_scorer(NAME)
class EmbeddingSimilarityScorer(XyneScorer):
    """Similarity of ``flow.answer`` to the configured reference answer."""

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
        raw_ref = cfg.get("reference_answer")
        self._reference = str(raw_ref).strip() if isinstance(raw_ref, str) else ""
        self._method = str(cfg.get("method", "f1")).lower()
        self._model = str(cfg.get("model", "all-MiniLM-L6-v2"))

    def score(self, flow: XyneRawFlow) -> float:
        answer = flow.answer
        if not answer or not answer.strip():
            return 0.0
        if not self._reference:
            return 0.0

        if self._method == "embedding":
            try:
                return self._embedding_similarity(flow.answer)
            except ImportError:
                # sentence-transformers not installed -> fall back to F1.
                pass
        return _f1_overlap(
            _tokens(self._reference), _tokens(flow.answer)
        )

    def _embedding_similarity(self, answer: str) -> float:
        """Cosine similarity of the two answers' sentence embeddings.

        Lazily imports ``sentence_transformers`` (raising :class:`ImportError`
        if unavailable so :meth:`score` can fall back) and builds the model
        once, caching it on the instance.
        """
        # Lazy, optional import: never required at module load time.
        from sentence_transformers import SentenceTransformer  # type: ignore[import-not-found]

        model = getattr(self, "_embedding_model", None)
        if model is None:
            model = SentenceTransformer(self._model)
            self._embedding_model = model

        vectors = model.encode([self._reference, answer])
        a, b = vectors[0], vectors[1]
        if a.size == 0 or b.size == 0:
            return 0.0
        dot = float(sum(x * y for x, y in zip(a, b)))
        na = sum(x * x for x in a) ** 0.5
        nb = sum(y * y for y in b) ** 0.5
        if na == 0.0 or nb == 0.0:
            return 0.0
        return max(0.0, min(1.0, dot / (na * nb)))
