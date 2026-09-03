"""Unit tests for polar.xyne.harness.XyneHarness.

Uses a mocked BaseRuntime — no live Xyne, Docker, or network LLM calls.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from polar.agent.models import AgentRunResult, AgentSpec
from polar.runtime.models import ExecResult
from polar.xyne.harness import RAW_PATH, XyneHarness
from polar.xyne.xyne_fetch_flow import _build_unified_result, _main_run_terminal

HELPER_FILE = Path(__file__).resolve().parents[2] / "src" / "polar" / "xyne" / "xyne_fetch_flow.py"


class FakeRuntime:
    """Minimal BaseRuntime test double recording exec commands and returning
    canned ExecResults. Not a BaseRuntime subclass — only the surface the
    harness uses (``exec``) is needed."""

    def __init__(self) -> None:
        self.commands: list[str] = []
        self.canned: dict[str, ExecResult | None] = {}
        self.default_result = ExecResult(stdout="", stderr="", return_code=0)

    def set_cat(self, content: str, rc: int = 0) -> None:
        self.canned["__cat__"] = ExecResult(
            stdout=content, stderr="" if rc == 0 else "missing", return_code=rc
        )

    async def exec(self, command: str, **kwargs) -> ExecResult:  # noqa: A002
        self.commands.append(command)
        if command.startswith("cat ") and "__cat__" in self.canned:
            return self.canned["__cat__"]
        return self.default_result


def _spec(**overrides) -> AgentSpec:
    settings = {"api_key": "sekret", "server_dir": "/opt/xyne", **overrides.pop("settings", {})}
    return AgentSpec(
        import_path="polar.xyne.harness:XyneHarness", settings=settings, **overrides
    )


def _harness(**overrides) -> XyneHarness:
    return XyneHarness(_spec(**overrides))


def _postprocess(harness, runtime, result) -> None:
    asyncio.run(harness.postprocess(runtime, result))


def test_xyne_harness_run_steps_single_command_with_expected_markers() -> None:
    harness = _harness()
    steps = harness.run_steps("find me the docs")
    assert len(steps) == 1
    command = steps[0].command
    # Contract: one self-contained cmd that embeds the fetch helper, waits for
    # the Xyne backend health, and drives the chat-conversations API.
    assert "xyne_fetch_flow.py" in command
    assert "/v2/chat/conversations" in command
    assert "wait-for-xyne.sh" in command
    # The helper runs with a bounded timeout.
    assert "--timeout 300" in command
    # Instruction is embedded verbatim and shell-quoted.
    assert "--instruction 'find me the docs'" in command
    # The helper source is embedded (so the runtime gets a working fetcher).
    assert "XYNE_FETCH_EOF" in command
    # Auth key is carried via env, not leaked into the command.
    assert steps[0].env["XYNE_API_KEY"] == "sekret"
    assert "sekret" not in command


def test_xyne_harness_run_steps_bounded_health_timeout_fails_cleanly() -> None:
    harness = _harness(settings={"health_timeout_sec": 5, "health_interval_sec": 1})
    command = harness.run_steps("hi")[0].command
    # The health poll must be bounded (-t N) and, on timeout, exit non-zero so
    # node.py's _run_exec_inputs marks the step failed.
    assert "wait-for-xyne.sh" in command
    assert "-t 5" in command
    assert "exit 1" in command


def test_xyne_harness_postprocess_injects_raw_flow() -> None:
    runtime = FakeRuntime()
    raw = {
        "conversation_id": "conv-1",
        "run_id": "run-1",
        "request_messages": [{"role": "user", "content": "hi"}],
        "answer": "hello world",
        "citations": [{"docId": "d1", "relevance": 0.9}],
        "debug_events": [{"kind": "tool_call"}],
        "nested_runs": [],
        "error": None,
        "latency_ms": 12.3,
        "wall_clock_ms": 20.0,
        "llm_calls": 0,
        "finish_reason": None,
        "metadata": {},
    }
    runtime.set_cat(json.dumps(raw))

    result = AgentRunResult(status="completed", return_code=0)
    _postprocess(_harness(), runtime, result)

    assert result.metadata["xyne_raw_path"] == RAW_PATH
    assert result.metadata["xyne_raw"] == raw
    assert "xyne_raw_error" not in result.metadata


def test_xyne_harness_postprocess_relocates_raw_path_from_metadata() -> None:
    runtime = FakeRuntime()
    runtime.set_cat(
        json.dumps(
            {
                "conversation_id": "c",
                "run_id": "r",
                "request_messages": [],
                "answer": "a",
            }
        )
    )
    alt_path = "/custom/raw.json"
    result = AgentRunResult(
        status="completed", return_code=0, metadata={"xyne_raw_path": alt_path}
    )

    _postprocess(_harness(), runtime, result)

    assert result.metadata["xyne_raw_path"] == alt_path
    assert result.metadata["xyne_raw"]["conversation_id"] == "c"
    # The runtime was asked to cat the relocated path.
    assert runtime.commands and runtime.commands[-1].endswith(alt_path)


def test_xyne_harness_postprocess_missing_file_no_raise() -> None:
    runtime = FakeRuntime()
    runtime.set_cat("", rc=1)
    result = AgentRunResult(status="failed", return_code=1)

    _postprocess(_harness(), runtime, result)

    assert "xyne_raw" not in result.metadata
    assert "xyne_raw_error" in result.metadata
    assert result.status == "failed"


def test_xyne_harness_postprocess_invalid_json_no_raise() -> None:
    runtime = FakeRuntime()
    runtime.set_cat("not json {", rc=0)
    result = AgentRunResult(status="completed", return_code=0)

    _postprocess(_harness(), runtime, result)

    assert "xyne_raw" not in result.metadata
    assert "xyne_raw_error" in result.metadata
    assert "JSON" in result.metadata["xyne_raw_error"]


def test_xyne_harness_api_key_defaults_empty() -> None:
    # No settings api_key and no env -> the key stays empty (Xyne may run
    # without auth); the harness must not invent one.
    agent_spec = AgentSpec(import_path="polar.xyne.harness:XyneHarness")
    harness = XyneHarness(agent_spec)
    assert harness._api_key == ""


class _XyneMockHandler(BaseHTTPRequestHandler):
    request_log: list[str] = []

    def log_message(self, *args) -> None:  # noqa: A002
        pass

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802
        self.request_log.append(f"POST {self.path}")
        length = int(self.headers.get("Content-Length", 0))
        self.rfile.read(length)
        if self.path == "/v2/chat/conversations":
            self._json(200, {"id": "conv-99", "conversation_id": "conv-99"})
        elif self.path == "/v2/chat/conversations/conv-99/messages":
            self._json(
                200,
                {
                    "runId": "run-99",
                    "answer": "the agentic answer",
                    "citations": [{"docId": "d1", "relevance": 0.8}],
                    "finishReason": "tool_calls",
                },
            )
        else:
            self._json(404, {"error": "unknown"})

    def do_GET(self) -> None:  # noqa: N802
        self.request_log.append(f"GET {self.path}")
        if self.path.startswith("/v2/chat/conversations/conv-99/debug-events"):
            self._json(
                200,
                {
                    "events": [{"kind": "tool_call", "nestedRuns": [{"runId": "sub-1"}]}],
                    "nested_runs": [],
                },
            )
        elif self.path == "/v2/chat/conversations/conv-99/messages":
            # The fetch flow polls this GET until the assistant's final answer
            # appears (contract: _as_items -> _final_assistant_answer). Serve the
            # completed answer on the first poll so the loop breaks immediately.
            self._json(
                200,
                {
                    "items": [
                        {
                            "id": "msg-1",
                            "role": "assistant",
                            "text": "the agentic answer",
                        }
                    ]
                },
            )
        elif self.path.startswith("/v2/chat/conversations/conv-99/dump"):
            # The fetch flow reassembles answer/citations from the full-turn DB
            # snapshot (<conversation>/dump), so serve the shape _build_unified_result
            # extracts: an assistant MAIN-run text block for the answer and a
            # "[docId#chunk]" citation token (on any block) for the citations list.
            self._json(
                200,
                {
                    "messages": [
                        {"id": "m-user", "role": "user",
                         "content": [{"kind": "text", "text": "find docs"}]},
                        {"id": "m-assist", "role": "assistant", "runId": "run-99",
                         "blocks": [{"kind": "text", "text": "the agentic answer"}]},
                        {"id": "m-cite", "role": "system",
                         "blocks": [{"kind": "text", "text": "see [d1#1] here"}]},
                    ],
                    "runs": [{"id": "run-99", "parentRunId": None}],
                    "toolCalls": [],
                },
            )
        else:
            self._json(404, {"error": "unknown"})


@pytest.fixture()
def xyne_mock_server():
    cls = _XyneMockHandler
    cls.request_log = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), cls)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()


def test_helper_script_full_flow_writes_raw_json(xyne_mock_server, tmp_path) -> None:
    """Run the standalone helper as a subprocess against a local mock backend and
    assert the emitted JSON matches the XyneRawFlow shape / the request flow."""
    output = tmp_path / "raw.json"
    port = xyne_mock_server.server_address[1]

    proc = subprocess.run(
        [
            sys.executable,
            str(HELPER_FILE),
            "--instruction",
            "find docs",
            "--output",
            str(output),
            "--base-url",
            f"http://127.0.0.1:{port}",
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr

    flow = json.loads(output.read_text())
    assert flow["conversation_id"] == "conv-99"
    assert flow["run_id"] == "run-99"
    assert flow["answer"] == "the agentic answer"
    assert flow["request_messages"] == [{"role": "user", "content": "find docs"}]
    assert flow["citations"][0]["docId"] == "d1"
    assert flow["finish_reason"] == "tool_calls"
    assert any(e.get("kind") == "tool_call" for e in flow["debug_events"])
    # Nested runs recovered from the debug-event payload.
    assert flow["nested_runs"] == [{"runId": "sub-1"}]
    # Required XyneRawFlow keys are all present.
    for key in ("conversation_id", "run_id", "request_messages", "answer"):
        assert key in flow
    # The expected HTTP flow was exercised against the backend.
    log = xyne_mock_server.RequestHandlerClass.request_log
    assert any("POST /v2/chat/conversations" in p for p in log)
    assert any("/messages" in p for p in log)
    assert any("GET /v2/chat/conversations/conv-99/debug-events" in p for p in log)


def test_helper_script_missing_args_fails_detected(tmp_path) -> None:
    """Adversarial (a): malformed input — missing required args must fail loudly
    (argparse exits non-zero) rather than silently succeed."""
    proc = subprocess.run(
        [sys.executable, str(HELPER_FILE)],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode != 0
    assert "--instruction" in proc.stderr


def test_unified_result_preserves_tool_results_and_retrieved_chunk_text() -> None:
    """A dump-only tool result must still yield complete reward telemetry."""
    dump = {
        "messages": [
            {
                "id": "assistant-1",
                "role": "assistant",
                "runId": "run-1",
                "blocks": [
                    {
                        "kind": "text",
                        "text": "The answer is grounded [doc-1#7].",
                    },
                    {"kind": "tool_use", "toolCallId": "call-1", "toolName": "vespaSearch", "args": {"query": "leave"}},
                ],
            }
        ],
        "runs": [{"id": "run-1", "status": "completed"}],
        "toolCalls": [
            {
                "id": "call-1",
                "toolName": "vespaSearch",
                "args": {"query": "leave"},
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": '<chunks><chunk index="7" cite="[doc-1#7]">Leave is capped at ten days.</chunk></chunks>',
                        }
                    ]
                },
                "status": "completed",
            }
        ],
    }
    result = _build_unified_result(dump, [], [], initial_citations=[])

    assert result["tool_events"][0]["toolName"] == "vespaSearch"
    assert result["tool_events"][0]["result"]
    assert result["tool_result_blocks"][0]["toolCallId"] == "call-1"
    assert result["retrieved_chunks"] == [
        {
            "docId": "doc-1",
            "chunk": 7,
            "snippet": "Leave is capped at ten days.",
            "source_text": "Leave is capped at ten days.",
        }
    ]
    assert result["citations"] == [
        {
            "docId": "doc-1",
            "chunk": 7,
            "snippet": "Leave is capped at ten days.",
            "source_text": "Leave is capped at ten days.",
        }
    ]


def test_fetcher_waits_for_terminal_main_run_when_status_is_exposed() -> None:
    assert not _main_run_terminal({"runs": [{"id": "run-1", "status": "running"}]}, "run-1")
    assert _main_run_terminal({"runs": [{"id": "run-1", "status": "completed"}]}, "run-1")


# ---------------------------------------------------------------------------
# FIX A: multi-SID session attribution (n_samples_per_prompt > 1)
#
# The proxy is a single shared process across all concurrent rollout sessions.
# It must resolve each request's OWN session id from the ``[polar-session:<sid>]``
# marker the harness stamps into the routed instruction (which the persistent
# backend echoes into every LiteLLM body) — never a shared single-SID fallback.
# `resolve_session_id` is exercised directly because the harness embeds this
# exact module's source into the runtime proxy (`_render_proxy_source`).
# ---------------------------------------------------------------------------


def _routes_two_sessions():
    nl = "\n"
    a = "solve problem X" + nl + "[polar-session:SID_A]"
    b = "write a poem" + nl + "[polar-session:SID_B]"
    return [
        {"session_id": "SID_A", "instruction": a, "created": 1, "expires": 9e18},
        {"session_id": "SID_B", "instruction": b, "created": 2, "expires": 9e18},
    ]


def test_resolve_session_id_never_misattributes_between_two_concurrent_sessions() -> None:
    from polar.xyne.session_proxy import resolve_session_id

    routes = _routes_two_sessions()
    # Each session's own marker routes to its OWN sid, never the other's.
    assert (
        resolve_session_id(b"prompt\n[polar-session:SID_A]\nmore", registered=routes)
        == "SID_A"
    )
    assert (
        resolve_session_id(b"prompt\n[polar-session:SID_B]\nmore", registered=routes)
        == "SID_B"
    )
    # A request with no unambiguous signal is NOT guessed -> '' (409 upstream),
    # so tokens are never misattributed to a lone session while both are live.
    assert resolve_session_id(b"no marker here", registered=routes) == ""


def test_resolve_session_id_single_surviving_route_is_unambiguous() -> None:
    from polar.xyne.session_proxy import resolve_session_id

    nl = "\n"
    one = [{"session_id": "SID_ONLY", "instruction": "x" + nl + "[polar-session:SID_ONLY]", "created": 1, "expires": 9e18}]
    assert resolve_session_id(b"anything", registered=one) == "SID_ONLY"


def test_resolve_session_id_explicit_header_routes_to_own_session() -> None:
    from polar.xyne.session_proxy import resolve_session_id

    routes = _routes_two_sessions()
    assert (
        resolve_session_id(
            b"no marker",
            headers={"x-session-id": "SID_B"},
            registered=routes,
        )
        == "SID_B"
    )


def test_synth_sse_forwards_tool_calls_deltas() -> None:
    """Regression: stream→nonstream→synth must not drop message.tool_calls.

    Without delta.tool_calls, pi-ai sets stopReason=toolUse but never builds
    toolCall blocks → Vespa never runs → /dump.toolCalls stays empty.
    """
    import json

    from polar.xyne.session_proxy import synth_sse

    body = json.dumps(
        {
            "id": "chatcmpl-test",
            "created": 1,
            "model": "open-fast",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "tool_calls",
                    "message": {
                        "role": "assistant",
                        "content": "I'll search…",
                        "reasoning_content": "plan",
                        "tool_calls": [
                            {
                                "id": "chatcmpl-tool-a",
                                "type": "function",
                                "function": {
                                    "name": "vespaSearch",
                                    "arguments": '{"query": "SEBI"}',
                                },
                            },
                            {
                                "id": "chatcmpl-tool-b",
                                "type": "function",
                                "function": {
                                    "name": "vespaSearch",
                                    "arguments": '{"query": "Spl Case"}',
                                },
                            },
                        ],
                    },
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3},
        }
    ).encode()

    sse = synth_sse(body)
    assert sse is not None
    text = sse.decode()
    assert "vespaSearch" in text
    assert "chatcmpl-tool-a" in text
    assert "chatcmpl-tool-b" in text
    assert '"finish_reason": "tool_calls"' in text or '"finish_reason":"tool_calls"' in text

    events = []
    for line in text.splitlines():
        if line.startswith("data: ") and line[6:].strip() not in ("", "[DONE]"):
            events.append(json.loads(line[6:]))
    tool_deltas = [
        tc
        for ev in events
        for choice in (ev.get("choices") or [])
        for tc in ((choice.get("delta") or {}).get("tool_calls") or [])
    ]
    assert len(tool_deltas) == 2
    assert tool_deltas[0]["index"] == 0
    assert tool_deltas[0]["function"]["name"] == "vespaSearch"
    assert tool_deltas[1]["index"] == 1
    assert '"query": "Spl Case"' in tool_deltas[1]["function"]["arguments"]
