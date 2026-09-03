"""Pure data container for one agentic Xyne run.

This module is intentionally dependency-free: it is a plain stdlib dataclass
so it can be imported anywhere (harness, evaluator, submit) without pulling in
pydantic or any other polar.* internal. It holds every observable artifact of
one agentic Xyne run and knows how to serialize/deserialize itself losslessly,
tolerating unknown and missing fields.
"""

from __future__ import annotations

import dataclasses
import json
from typing import Any

# Field names present in a real Xyne citation payload (from
# nonAgenticAsk.ts `searchToCitation` + chunk-level citation data). `relevance`
# is a float in 0..1, the rest are strings. Every key is optional to tolerate
# citations emitted with a subset of fields.
CITATION_FIELDS = (
    "docId",
    "itemId",
    "clId",
    "page_title",
    "chunkIndex",
    "relevance",
    "snippet",
    "source_text",
)

_REQUIRED_FIELDS = ("conversation_id", "run_id", "request_messages", "answer")


@dataclasses.dataclass
class XyneRawFlow:
    """Everything observable about one agentic Xyne run."""

    conversation_id: str
    run_id: str
    request_messages: list[dict[str, Any]]
    answer: str
    citations: list[dict[str, Any]] = dataclasses.field(default_factory=list)
    debug_events: list[dict[str, Any]] = dataclasses.field(default_factory=list)
    nested_runs: list[dict[str, Any]] = dataclasses.field(default_factory=list)
    error: str | None = None
    latency_ms: float = 0.0
    wall_clock_ms: float = 0.0
    llm_calls: int = 0
    finish_reason: str | None = None
    metadata: dict[str, Any] = dataclasses.field(default_factory=dict)
    # Real-time dump fields (mapped first-class instead of falling into `extras`).
    tool_calls: list[dict[str, Any]] = dataclasses.field(default_factory=list)
    tool_use_blocks: list[dict[str, Any]] = dataclasses.field(default_factory=list)
    tool_result_blocks: list[dict[str, Any]] = dataclasses.field(default_factory=list)
    # Normalized, one-record-per-call telemetry. This remains useful when the
    # backend stores a tool result in /dump.toolCalls but omits a message block.
    tool_events: list[dict[str, Any]] = dataclasses.field(default_factory=list)
    # Retrieved source records are kept separate from answer citations: a tool
    # can retrieve a chunk without the assistant citing it in the final answer.
    retrieved_chunks: list[dict[str, Any]] = dataclasses.field(default_factory=list)
    sub_agents: list[dict[str, Any]] = dataclasses.field(default_factory=list)
    thinking: list[str] = dataclasses.field(default_factory=list)
    messages: list[dict[str, Any]] = dataclasses.field(default_factory=list)
    runs: list[dict[str, Any]] = dataclasses.field(default_factory=list)
    token_usage: dict[str, Any] = dataclasses.field(default_factory=dict)
    extras: dict[str, Any] = dataclasses.field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a plain dict, lossless over every named field.

        `extras` are merged into the returned dict so unknown fields captured
        during `from_dict`/`from_json` survive the round-trip.
        """
        d: dict[str, Any] = dataclasses.asdict(self)
        merged = d.pop("extras", {})
        merged.update(d)
        return merged

    def to_json(self) -> str:
        """Serialize to a JSON string, lossless over every named field."""
        return json.dumps(self.to_dict())

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "XyneRawFlow":
        """Parse a dict back into an :class:`XyneRawFlow`.

        - Missing required positional keys raise a clear :class:`ValueError`.
        - Missing optional keys fall back to defaults.
        - Extra unknown keys are collected into ``extras`` rather than dropped.
        """
        for field in _REQUIRED_FIELDS:
            if field not in d:
                raise ValueError(f"XyneRawFlow requires field {field!r}")

        known = {f.name for f in dataclasses.fields(cls)}
        extras = {k: v for k, v in d.items() if k not in known}

        payload: dict[str, Any] = {}
        for f in dataclasses.fields(cls):
            if f.name in d:
                payload[f.name] = d[f.name]
            elif f.default is not dataclasses.MISSING:
                payload[f.name] = f.default
            elif f.default_factory is not dataclasses.MISSING:  # type: ignore[misc]
                payload[f.name] = f.default_factory()
        payload["extras"] = extras
        return cls(**payload)

    @classmethod
    def from_json(cls, json_str: str) -> "XyneRawFlow":
        """Parse a JSON string back into an :class:`XyneRawFlow`.

        Malformed JSON raises :class:`json.JSONDecodeError`; a JSON value that
        is not an object, or a missing required key, raises :class:`ValueError`.
        """
        data = json.loads(json_str)
        if not isinstance(data, dict):
            raise ValueError("XyneRawFlow.from_json expects a JSON object")
        return cls.from_dict(data)
