from __future__ import annotations

import json

import pytest

from polar.xyne.types import XyneRawFlow


def _minimal_flow() -> XyneRawFlow:
    return XyneRawFlow(
        conversation_id="conv-1",
        run_id="run-1",
        request_messages=[{"role": "user", "content": "hi"}],
        answer="hello world",
    )


def test_to_json_round_trip_is_lossless() -> None:
    flow = _minimal_flow()
    flow.citations = [
        {
            "docId": "doc-1",
            "itemId": "item-1",
            "clId": "cl-1",
            "page_title": "Page Title",
            "chunkIndex": "3",
            "relevance": 0.87,
            "snippet": "some snippet",
        }
    ]
    flow.latency_ms = 123.45
    flow.wall_clock_ms = 999.9
    flow.llm_calls = 4
    flow.finish_reason = "tool_calls"

    restored = XyneRawFlow.from_json(flow.to_json())

    assert restored.to_dict() == flow.to_dict()


def test_to_dict_round_trip_is_lossless() -> None:
    flow = XyneRawFlow(
        conversation_id="conv-2",
        run_id="run-2",
        request_messages=[{"role": "assistant", "content": "a"}],
        answer="answer two",
        debug_events=[{"kind": "tool_call"}],
        nested_runs=[{"runId": "sub-1"}],
    )

    restored = XyneRawFlow.from_dict(flow.to_dict())

    assert restored.to_dict() == flow.to_dict()


def test_from_json_extra_unknown_key_goes_to_extras() -> None:
    data = _minimal_flow().to_dict()
    data["future_field"] = {"some": "value"}

    flow = XyneRawFlow.from_json(json.dumps(data))

    assert flow.extras["future_field"] == {"some": "value"}
    assert flow.answer == "hello world"


def test_from_json_extra_unknown_key_survives_round_trip() -> None:
    data = _minimal_flow().to_dict()
    data["future_field"] = 42

    restored = XyneRawFlow.from_json(json.dumps(data)).to_dict()

    assert restored["future_field"] == 42


def test_from_json_missing_required_key_raises_value_error() -> None:
    data = _minimal_flow().to_dict()
    del data["answer"]

    with pytest.raises(ValueError, match="answer"):
        XyneRawFlow.from_json(json.dumps(data))


def test_from_json_missing_conversation_id_raises_value_error() -> None:
    data = _minimal_flow().to_dict()
    del data["conversation_id"]

    with pytest.raises(ValueError, match="conversation_id"):
        XyneRawFlow.from_json(json.dumps(data))


def test_from_json_malformed_json_raises_clear_error() -> None:
    with pytest.raises((ValueError, json.JSONDecodeError)):
        XyneRawFlow.from_json('{"answer": "a"')


def test_from_json_empty_string_raises_clear_error() -> None:
    with pytest.raises((ValueError, json.JSONDecodeError)):
        XyneRawFlow.from_json("")


def test_from_json_non_object_raises_value_error() -> None:
    with pytest.raises(ValueError, match="object"):
        XyneRawFlow.from_json("[1, 2, 3]")


def test_missing_optional_keys_use_defaults() -> None:
    data = _minimal_flow().to_dict()
    del data["citations"]
    del data["error"]

    flow = XyneRawFlow.from_dict(data)

    assert flow.citations == []
    assert flow.error is None
    assert flow.llm_calls == 0
