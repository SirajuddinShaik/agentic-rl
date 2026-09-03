"""Tool-call efficiency scorer: penalize runs that make excessive tool calls.

The number of tool invocations is parsed defensively from the opaque
``flow.debug_events`` and ``flow.nested_runs`` structures. A debug event counts
as a tool call when:

- it has a ``type``/``name`` key whose value is one of the known tool-call
  markers (``"tool_call"``, ``"tool_use"``, ``"toolCall"``, ``"tool_use"``), or
- it carries both a ``name`` and an ``arguments`` key (an Anthropic/OpenAI
  style tool-use payload).

``debug_events`` and ``nested_runs`` are treated as potentially-overlapping
views of the same work (a sub-agent run may also surface as a tool-call event),
so the total tool count is the *maximum* of the events-based count and the
``nested_runs`` length — using the nested-run count as a defensive floor.

The raw count ``c`` is mapped to a ``[0, 1]`` score with a configurable
``budget`` (int, default 8):

    score = budget / (budget + c)

Every additional call therefore changes the signal; the first eight calls no
longer receive an indistinguishable perfect score. The last
observed count is stored on ``last_count`` so tests can assert the parsing.
"""

from __future__ import annotations

from collections.abc import Mapping

from polar.xyne.reward_pipeline import XyneScorer, register_scorer
from polar.xyne.types import XyneRawFlow

__all__ = ["ToolCallEfficiencyScorer"]

NAME = "tool_call_efficiency"

# Marker values that indicate a dict describes a tool call via a "type" key.
_TOOL_KINDS = frozenset(
    {"tool_call", "tool_use", "toolCall", "tool_use_start", "function_call"}
)
# Marker keys that indicate a dict describes a tool call by their presence.
_TOOL_TYPE_KEYS = ("type", "kind", "event")


def _is_tool_event(item: object) -> bool:
    """Return True if ``item`` looks like a tool-call record."""
    if not isinstance(item, Mapping):
        return False
    # A dict carrying both a name and arguments is a tool-use payload.
    has_name = isinstance(item.get("name"), str) and item.get("name")
    has_args = "arguments" in item or "args" in item or "input" in item
    if has_name and has_args:
        return True
    # A "type"/"kind"/"event" value that names a tool call.
    for key in _TOOL_TYPE_KEYS:
        value = item.get(key)
        if isinstance(value, str) and value.lower() in _TOOL_KINDS:
            return True
    return False


def count_tool_calls(
    *,
    tool_calls: list | None = None,
    tool_use_blocks: list | None = None,
    debug_events: list | None = None,
    nested_runs: list | None = None,
) -> int:
    """Count tool invocations across the first-class and legacy dump views.

    ``tool_calls`` and ``tool_use_blocks`` are the new first-class fields that
    the real-time dump format populates (a tool call surfaces in both, hence
    using the max to avoid double-counting). ``debug_events`` and
    ``nested_runs`` are retained as a backward-compatible fallback for older
    dumps that only carry the legacy structures.

    Each view may represent the same underlying work, so the total is the
    *maximum* across all four views.
    """
    tool_calls = tool_calls or []
    tool_use_blocks = tool_use_blocks or []
    debug_events = debug_events or []
    nested_runs = nested_runs or []

    events_count = sum(1 for ev in debug_events if _is_tool_event(ev))
    nested_count = len(nested_runs)
    return max(
        len(tool_calls),
        len(tool_use_blocks),
        events_count,
        nested_count,
    )


@register_scorer(NAME)
class ToolCallEfficiencyScorer(XyneScorer):
    """Reward efficiency as a function of the tool-call count vs a budget."""

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
        self.budget = int(cfg.get("budget", 8))
        self.last_count: int = 0

    def score(self, flow: XyneRawFlow) -> float:
        count = count_tool_calls(
            tool_calls=flow.tool_calls,
            tool_use_blocks=flow.tool_use_blocks,
            debug_events=flow.debug_events,
            nested_runs=flow.nested_runs,
        )
        self.last_count = count
        budget = self.budget
        if budget <= 0:
            return 0.0
        return budget / (budget + count)
