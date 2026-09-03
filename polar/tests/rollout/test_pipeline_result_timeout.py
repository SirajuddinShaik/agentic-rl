"""FIX C: a session that never returns a result resolves with reward 0, not a hang.

Regression: the old _wait_for_result only armed its deadline once the gateway
status left REGISTERED. A gateway that accepted a session but never INIT'd it
(dead node, stuck queue) made the poll loop spin forever, so asyncio.gather in
run_batch held the whole GRPO group open indefinitely. This test drives a real
Pipeline against a fake gateway that answers dispatch but never produces a
result or leaves REGISTERED, with POLAR_SESSION_RESULT_TIMEOUT_MS set small,
and asserts the group member resolves with reward 0 within a bounded wall clock.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from polar.rollout.models import AgentSpec, SessionContext, SessionResult, TaskRequest
from polar.rollout.pipeline import Pipeline


class _StuckGateway(BaseHTTPRequestHandler):
    """Gateway stub that accepts dispatch but never returns a terminal result."""

    def log_message(self, *args: Any) -> None:  # noqa: A002
        pass

    def _send_json(self, code: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        if self.path == "/sessions":
            self._send_json(200, {"session_id": "sk-polar-xyz", "status": "REGISTERED"})
        else:
            self._send_json(200, {"ok": True})

    def do_DELETE(self) -> None:  # noqa: N802
        self._send_json(200, {"deleted": True})

    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/sessions/") and "/completions" not in self.path:
            self._send_json(
                200,
                {
                    "status": "REGISTERED",
                    "result": None,
                },
            )
        else:
            self._send_json(404, {"error": "not found"})


class _FakeScheduler:
    """Minimum NodeScheduler surface the pipeline uses."""

    def __init__(self, gateway_url: str, node_id: str) -> None:
        self._gateway_url = gateway_url
        self._node_id = node_id

    def acquire_node(self) -> Any:
        return _Node(self._gateway_url, self._node_id)

    def release_reservation(self, node_id: str) -> None:  # noqa: A002
        pass

    def mark_unhealthy(self, node_id: str) -> None:  # noqa: A002
        pass


class _Node:
    def __init__(self, gateway_url: str, node_id: str) -> None:
        self.gateway_url = gateway_url
        self.node_id = node_id


@pytest.fixture()
def stuck_gateway():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _StuckGateway)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()


def _session(gateway_url: str) -> SessionContext:
    request = TaskRequest(
        task_id="task-grp-1",
        instruction="solve it",
        num_samples=1,
        timeout_seconds=3600.0,
        agent=AgentSpec(import_path="polar.xyne.harness:XyneHarness"),
    )
    return SessionContext(
        session_id="sk-polar-timeout",
        task_id=request.task_id,
        request=request,
    )


def test_group_member_resolves_reward_zero_when_result_never_returns(
    monkeypatch, stuck_gateway
) -> None:
    monkeypatch.setenv("POLAR_SESSION_RESULT_TIMEOUT_MS", "600")
    gateway_url = f"http://127.0.0.1:{stuck_gateway.server_address[1]}"
    pipeline = Pipeline(
        callback_url=f"{gateway_url}/callback",
        save_dir=None,
        scheduler=_FakeScheduler(gateway_url, "test-node"),
        dispatch_poll_interval_seconds=0.05,
    )

    delivered: list[SessionResult] = []

    async def collect() -> list[SessionResult]:
        results = await pipeline.run_batch(
            [_session(gateway_url)],
            on_result=lambda result: delivered.append(result),
        )
        await pipeline.close()
        return results

    start = time.monotonic()
    results = asyncio.run(collect())
    elapsed = time.monotonic() - start

    # Proves the group does NOT hang: it resolves well inside the 30s poll window.
    assert elapsed < 10.0, f"group stalled; took {elapsed:.1f}s"

    assert len(results) == 1
    result = results[0]
    assert result.session_id == "sk-polar-timeout"
    assert result.status == "COMPLETED"
    # The absent result auto-fails the group member with reward 0.
    assert result.trajectory.traces[-1].reward == 0.0
    assert result.trajectory.metadata["evaluation"]["outcome_reward"] == 0.0
    assert result.metadata.get("result_timeout") is True
    # The on_result callback (the group-resolution hook) fired.
    assert len(delivered) == 1
    assert delivered[0].trajectory.traces[-1].reward == 0.0
