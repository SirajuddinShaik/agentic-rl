"""Standalone multi-session LLM proxy for Polar Xyne harness runs.

The Xyne backend (``nonAgenticAsk.ts``) calls an OpenAI-compatible endpoint via
``fetch(${LITELLM_BASE_URL}/v1/chat/completions)``. Polar routes that through this
proxy so the gateway captures every completion and attributes it to the correct
rollout session.

It runs with a bare ``python3`` inside the agent runtime container, so it imports
**only the stdlib**. It does two jobs:

  1. Streaming-mode rewrite. Tool requests keep ``stream:true`` because the
     SGLang ``qwen3_coder`` parser emits complete tool-call deltas only in
     streaming mode. Tool-free requests are made non-streaming and a proper SSE
     stream is synthesized back, keeping LiteLLM's contract while avoiding the
     old SGLang thinking-buffer stall.

  2. Per-request session attribution. The proxy may be shared across many
     concurrent rollout sessions (``n_samples_per_prompt > 1``), so it must
     resolve the *actual* session id of each request, not a single shared
     marker. ``resolve_session_id`` prefers, in order:

       a. an explicit ``[polar-session:<sid>]`` marker in the request body
          (the harness stamps each run's instruction with its own SID, and the
          Xyne backend echoes the full conversation, so the marker travels in
          every body),
       b. an explicit per-request session header when a caller already knows
          its SID,
       c. the single surviving route when exactly one route is registered and
          the body carries no marker/header,
       d. otherwise ``''`` (no match) so the proxy returns 409 rather than
          misattributing a request to the wrong session.

The old single-``[polar-session:<sid>]`` marker approach misattributed concurrent
multi-SID sessions because one shared marker could not disambiguate them; this
module keys off the request's own SID and never silently attributes to a lone
session while other sessions are live.

Start the HTTP server only when run as ``__main__`` so unit tests / other modules
can ``import`` the pure helpers without binding a port. The harness embeds this
exact source into the runtime (``_render_proxy_source``), so the tested logic is
byte-for-byte the proxy that runs.
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlsplit


def _positive_env_int(name: str, default: int) -> int:
    """Read a positive integer override or return the tested default."""
    value = os.environ.get(name)
    if value in (None, ""):
        return default
    try:
        result = int(value)
    except ValueError as exc:
        raise SystemExit(f"{name} must be an integer, got {value!r}") from exc
    if result <= 0:
        raise SystemExit(f"{name} must be positive, got {result}")
    return result


# The current Xyne/Polar training lane binds the shared session proxy on
# :18114 and forwards to the Polar gateway on :8101. These values remain
# configurable so the same stdlib-only proxy can support isolated test lanes.
PROXY_HOST = os.environ.get("POLAR_SESSION_PROXY_HOST", "127.0.0.1")
PROXY_PORT = _positive_env_int("POLAR_SESSION_PROXY_PORT", 18114)
UPSTREAM_URL = os.environ.get(
    "POLAR_SESSION_PROXY_UPSTREAM", "http://127.0.0.1:8101"
).rstrip("/")
_UPSTREAM = urlsplit(UPSTREAM_URL)

ROUTES_PATH = os.environ.get(
    "POLAR_SESSION_ROUTES_PATH", "/tmp/polar_session_routes.json"
)
LOCK_PATH = os.environ.get(
    "POLAR_SESSION_ROUTES_LOCK_PATH", "/tmp/polar_session_routes.lock"
)
REQUEST_TIMEOUT_SECONDS = _positive_env_int(
    "POLAR_SESSION_PROXY_TIMEOUT_SECONDS", 7200
)
DEFAULT_MAX_TOKENS = _positive_env_int(
    "POLAR_SESSION_PROXY_DEFAULT_MAX_TOKENS", 16384
)
MAX_TOKENS = _positive_env_int("POLAR_SESSION_PROXY_MAX_TOKENS", 16384)
_MARKER_RE = re.compile(r"\[polar-session:([^\]\r\n]+)\]")
_SESSION_HEADER_NAMES = ("proxy-x-session-id", "x-session-id", "x_session_id")
# Request headers stripped before forwarding upstream (session identity and
# hop-by-hop headers must not leak as-is).
_STRIP_HEADERS = {
    "host",
    "content-length",
    "connection",
    "authorization",
    "x-api-key",
    "x_session_id",
    "proxy-x-session-id",
}


def routes() -> list[dict]:
    """Return the non-expired registered routes (per-runtime session registry)."""
    try:
        with open(ROUTES_PATH) as handle:
            loaded = json.load(handle)
        if not isinstance(loaded, list):
            return []
        return [
            x
            for x in loaded
            if isinstance(x, dict) and x.get("expires", 0) > time.time()
        ]
    except Exception:  # noqa: BLE001 - file may not exist yet / be mid-rewrite
        return []


def session_id_from_marker(body: bytes) -> str:
    """Pull the request's own SID from a ``[polar-session:<sid>]`` body marker."""
    text = body.decode("utf-8", "replace")
    match = _MARKER_RE.search(text)
    return match.group(1) if match else ""


def session_id_from_headers(headers: dict[str, Any] | None) -> str:
    """Pull an explicit per-request SID from the request headers, if present."""
    if not headers:
        return ""
    for name in _SESSION_HEADER_NAMES:
        value = headers.get(name) or headers.get(name.replace("-", "_"))
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, list) and value:
            first = value[0]
            if isinstance(first, str) and first.strip():
                return first.strip()
    return ""


def _single_surviving_session_id(rr: list[dict]) -> str:
    """The lone live session's id, or ``''`` when zero/multiple are ambiguous."""
    live = [r for r in rr if r.get("session_id")]
    return live[0]["session_id"] if len(live) == 1 else ""


def resolve_session_id(
    body: bytes,
    *,
    headers: dict[str, Any] | None = None,
    registered: list[dict] | None = None,
) -> str:
    """Resolve the *request's own* session id without cross-session misattribution.

    Returns ``''`` when no unambiguous SID can be determined instead of guessing,
    so the caller can return 409 and the run fails cleanly rather than attributing
    tokens to the wrong session.
    """
    # 1. The request's own body marker is authoritative (per-request SID).
    from_marker = session_id_from_marker(body)
    if from_marker:
        return from_marker

    # 2. An explicit per-request header is the next best signal.
    if headers is not None:
        from_header = session_id_from_headers(headers)
        if from_header:
            return from_header

    # 3. Fall back to the route registry, but ONLY when it is unambiguous.
    rr = registered if registered is not None else routes()
    if not rr:
        return ""
    text = body.decode("utf-8", "replace")
    # Longest-instruction first; an exact instruction prefix is a strong signal.
    for route in sorted(
        rr,
        key=lambda x: (len(x.get("instruction", "")), x.get("created", 0)),
        reverse=True,
    ):
        instruction = route.get("instruction")
        if instruction and instruction in text:
            return route.get("session_id", "")
    # A single surviving session is unambiguous; multiple are not.
    return _single_surviving_session_id(rr)
# ---- HTTP server (SSE synthesis + forwarding) ----
def synth_sse(body: bytes) -> bytes | None:
    """Convert a non-stream chat.completion JSON body into an SSE byte stream. None on failure.

    Must forward ``message.tool_calls`` as ``delta.tool_calls`` chunks. Xyne's
    ``@earendil-works/pi-ai`` openai-completions parser only materializes
    ``toolCall`` content blocks from streaming tool deltas; omitting them leaves
    ``stopReason=toolUse`` with an empty tool list, so Vespa never runs and
    ``/dump.toolCalls`` stays empty.
    """
    try:
        j = json.loads(body.decode('utf-8', 'replace'))
        ch = (j.get('choices') or [{}])[0]
        msg = ch.get('message', {}) or {}
        usage = j.get('usage', {}) or {}
        base = {
            'id': j.get('id', 'chatcmpl-x'),
            'object': 'chat.completion.chunk',
            'created': j.get('created', 0),
            'model': j.get('model', 'nemotron'),
        }
        out = b''
        rc = msg.get('reasoning_content')
        if rc:
            c = dict(base)
            c['choices'] = [{'index': 0, 'delta': {'role': 'assistant', 'reasoning_content': rc}, 'finish_reason': None}]
            out += ('data: ' + json.dumps(c, ensure_ascii=False) + '\n\n').encode()
        txt = msg.get('content') or ''
        c = dict(base)
        c['choices'] = [{'index': 0, 'delta': {'role': 'assistant', 'content': txt}, 'finish_reason': None}]
        out += ('data: ' + json.dumps(c, ensure_ascii=False) + '\n\n').encode()
        # Mirror gateway ``_response_to_stream_chunk``: emit indexed tool_calls
        # before the finish_reason chunk so pi-ai can build toolCall blocks.
        tool_calls = msg.get('tool_calls') or []
        if tool_calls:
            tcs = []
            for i, tc in enumerate(tool_calls):
                if not isinstance(tc, dict):
                    continue
                func = tc.get('function') or {}
                if not isinstance(func, dict):
                    func = {}
                tcs.append({
                    'index': i,
                    'id': tc.get('id'),
                    'type': tc.get('type', 'function'),
                    'function': {
                        'name': func.get('name', '') or '',
                        'arguments': func.get('arguments', '') or '',
                    },
                })
            if tcs:
                c = dict(base)
                c['choices'] = [{
                    'index': 0,
                    'delta': {'role': 'assistant', 'tool_calls': tcs},
                    'finish_reason': None,
                }]
                out += ('data: ' + json.dumps(c, ensure_ascii=False) + '\n\n').encode()
        fin = ch.get('finish_reason') or 'stop'
        c = dict(base)
        c['choices'] = [{'index': 0, 'delta': {}, 'finish_reason': fin}]
        if usage:
            c['usage'] = usage
        out += ('data: ' + json.dumps(c, ensure_ascii=False) + '\n\n').encode()
        out += b'data: [DONE]\n\n'
        return out
    except Exception:
        return None


def rewrite_chat_request(body: bytes) -> tuple[bytes, bool, bool]:
    """Normalize a chat request and report its required response mode.

    Returns ``(body, want_stream, tools_stream)``. Tool requests must keep
    ``stream=true`` upstream: SGLang's ``qwen3_coder`` tool-call parser emits
    complete tool-call deltas while streaming. Requests without tools are made
    non-streaming and ``synth_sse`` restores the OpenAI streaming contract to
    Xyne. The 16,384-token guard prevents an unbounded Xyne request from
    exceeding the 80k engine context.
    """
    try:
        request = json.loads(body.decode("utf-8", "replace"))
        if not isinstance(request, dict):
            return body, False, False
    except (UnicodeDecodeError, json.JSONDecodeError):
        return body, False, False

    want_stream = bool(request.get("stream"))
    tools_stream = want_stream and isinstance(request.get("tools"), list) and bool(request["tools"])
    rewritten = False
    if want_stream:
        request["stream"] = tools_stream
        request.pop("stream_options", None)
        rewritten = True

    max_tokens = request.get("max_tokens")
    try:
        if max_tokens in (None, ""):
            completion_tokens = request.get("max_completion_tokens")
            max_tokens = (
                int(completion_tokens)
                if completion_tokens not in (None, "") and int(completion_tokens) > 0
                else DEFAULT_MAX_TOKENS
            )
        else:
            max_tokens = int(max_tokens)
    except (TypeError, ValueError):
        max_tokens = DEFAULT_MAX_TOKENS
    if max_tokens <= 0:
        max_tokens = DEFAULT_MAX_TOKENS
    request["max_tokens"] = min(max_tokens, MAX_TOKENS)
    rewritten = True

    if not rewritten:
        return body, want_stream, tools_stream
    return json.dumps(request).encode("utf-8"), want_stream, tools_stream


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def _p(self):
        if self.command == 'GET' and self.path == '/health':
            self.send_response(200)
            self.send_header('Content-Length', '2')
            self.end_headers()
            self.wfile.write(b'OK')
            return
        n = int(self.headers.get('Content-Length') or 0)
        b = self.rfile.read(n) if n else None
        want_stream = False
        tools_stream = False
        if self.command == 'POST' and b:
            b, want_stream, tools_stream = rewrite_chat_request(b)
        sid = resolve_session_id(b or b'', headers=self.headers)
        public_models = self.command == 'GET' and self.path.startswith('/v1/models')
        if not sid and not public_models:
            self.send_response(409)
            self.send_header('Content-Length', '24')
            self.end_headers()
            self.wfile.write(b'no Polar session matched')
            return
        u = UPSTREAM_URL + self.path
        r = urllib.request.Request(u, data=b, method=self.command)
        if b is not None:
            r.add_header('Content-Length', str(len(b)))
        for k, v in self.headers.items():
            if k.lower() not in ('host', 'content-length', 'connection', 'authorization',
                                 'x-api-key', 'x_session_id', 'proxy-x-session-id'):
                r.add_header(k, v)
        if sid:
            r.add_header('authorization', 'Bearer ' + sid)
            r.add_header('x-session-id', sid)
        try:
            with urllib.request.urlopen(r, timeout=REQUEST_TIMEOUT_SECONDS) as resp:
                body = resp.read()
                if tools_stream and self.path.rstrip('/').endswith('/v1/chat/completions'):
                    # SGLang already returned real SSE tool-call deltas. Forward
                    # them verbatim so the parser output is not reconstructed.
                    self.send_response(200)
                    self.send_header('content-type', 'text/event-stream; charset=utf-8')
                    self.send_header('content-length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                if want_stream and self.path.rstrip('/').endswith('/v1/chat/completions'):
                    sse = synth_sse(body)
                    if sse is not None:
                        self.send_response(200)
                        self.send_header('content-type', 'text/event-stream; charset=utf-8')
                        self.send_header('content-length', str(len(sse)))
                        self.end_headers()
                        self.wfile.write(sse)
                        return
                self.send_response(resp.status)
                ct = resp.headers.get('content-type') or 'application/json'
                self.send_header('content-type', ct)
                self.send_header('content-length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as e:
            payload = e.read()
            self.send_response(e.code)
            self.send_header('content-length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as e:
            payload = str(e).encode()
            self.send_response(502)
            self.send_header('content-length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    do_GET = _p
    do_POST = _p
    do_PUT = _p
    do_DELETE = _p

    def log_message(self, *a, **k):
        pass

def _serve() -> None:
    ThreadingHTTPServer((PROXY_HOST, PROXY_PORT), H).serve_forever()

if __name__ == '__main__':
    _serve()
