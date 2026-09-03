"""Built-in Xyne scorer plug-ins.

Importing this package registers every built-in scorer into
``polar.xyne.reward_pipeline.SCORER_REGISTRY`` via their ``@register_scorer``
decorator, and exposes the full collection as :data:`ALL_SCORERS`.

This is the pluggable seam: to add a NEW scorer, write a module under
``polar.xyne.scorers`` that subclasses :class:`XyneScorer`, decorate it with
``@register_scorer``, and import the module here. No other code needs to change.
"""

from __future__ import annotations

from polar.xyne.reward_pipeline import SCORER_REGISTRY, XyneScorer

# Importing each module runs its @register_scorer, populating SCORER_REGISTRY.
from polar.xyne.scorers import answer_format  # noqa: F401  (registers scorer)
from polar.xyne.scorers import citation_accuracy  # noqa: F401
from polar.xyne.scorers import citation_presence  # noqa: F401
from polar.xyne.scorers import citation_relevance  # noqa: F401
from polar.xyne.scorers import completion  # noqa: F401
from polar.xyne.scorers import embedding_similarity  # noqa: F401
from polar.xyne.scorers import gold_evidence_coverage  # noqa: F401
from polar.xyne.scorers import citation_evidence_coverage  # noqa: F401
from polar.xyne.scorers import llm_judge  # noqa: F401
from polar.xyne.scorers import retrieval_quality  # noqa: F401
from polar.xyne.scorers import subagent_success  # noqa: F401
from polar.xyne.scorers import token_efficiency  # noqa: F401
from polar.xyne.scorers import tool_call_efficiency  # noqa: F401
from polar.xyne.scorers import tool_evidence_utility  # noqa: F401

# All built-in scorers, keyed by canonical name, for pipeline construction.
ALL_SCORERS: dict[str, type[XyneScorer]] = dict(SCORER_REGISTRY)

__all__ = [
    "ALL_SCORERS",
    "SCORER_REGISTRY",
    "XyneScorer",
    "completion",
    "answer_format",
    "citation_presence",
    "citation_relevance",
    "citation_accuracy",
    "retrieval_quality",
    "subagent_success",
    "embedding_similarity",
    "gold_evidence_coverage",
    "citation_evidence_coverage",
    "tool_call_efficiency",
    "tool_evidence_utility",
    "token_efficiency",
    "llm_judge",
]
