#!/usr/bin/env python3
import json
import os
import socket
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


NODE_ID = os.getenv("NODE_ID", socket.gethostname())
MODEL = os.getenv("VLLM_MODEL", "lightonai/LightOnOCR-2-1B-bbox")
PORT = int(os.getenv("PORT", "8000"))
started_at = time.time()
request_count = 0


def prometheus_label_value(value: str) -> str:
  return value.replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def metrics_text() -> bytes:
  labels = (
    f'model_name="{prometheus_label_value(MODEL)}",'
    f'node_id="{prometheus_label_value(NODE_ID)}"'
  )
  uptime = max(time.time() - started_at, 0)
  lines = [
    "# HELP vllm:num_requests_running Number of requests currently running on GPU.",
    "# TYPE vllm:num_requests_running gauge",
    f"vllm:num_requests_running{{{labels}}} 0",
    "# HELP vllm:num_requests_waiting Number of requests waiting to be processed.",
    "# TYPE vllm:num_requests_waiting gauge",
    f"vllm:num_requests_waiting{{{labels}}} 0",
    "# HELP vllm:gpu_cache_usage_perc GPU KV-cache usage percentage.",
    "# TYPE vllm:gpu_cache_usage_perc gauge",
    f"vllm:gpu_cache_usage_perc{{{labels}}} 0",
    "# HELP vllm:request_success_total Total successful mock vLLM requests.",
    "# TYPE vllm:request_success_total counter",
    f"vllm:request_success_total{{{labels}}} {request_count}",
    "# HELP xyne_mock_vllm_bbox_up Whether the local bbox OCR mock is up.",
    "# TYPE xyne_mock_vllm_bbox_up gauge",
    f"xyne_mock_vllm_bbox_up{{{labels}}} 1",
    "# HELP process_start_time_seconds Start time of the mock OCR process.",
    "# TYPE process_start_time_seconds gauge",
    f"process_start_time_seconds{{{labels}}} {started_at}",
    "# HELP process_uptime_seconds Uptime of the mock OCR process.",
    "# TYPE process_uptime_seconds gauge",
    f"process_uptime_seconds{{{labels}}} {uptime}",
    "",
  ]
  return "\n".join(lines).encode()


class Handler(BaseHTTPRequestHandler):
  server_version = "xyne-mock-vllm-bbox/1.0"

  def send_json(self, status: int, payload: dict):
    body = json.dumps(payload).encode()
    self.send_response(status)
    self.send_header("content-type", "application/json")
    self.send_header("content-length", str(len(body)))
    self.end_headers()
    self.wfile.write(body)

  def do_GET(self):
    if self.path in ("/health", "/"):
      self.send_response(200)
      self.send_header("content-type", "text/plain")
      self.end_headers()
      self.wfile.write(b"ok\n")
      return
    if self.path == "/metrics":
      body = metrics_text()
      self.send_response(200)
      self.send_header("content-type", "text/plain; version=0.0.4; charset=utf-8")
      self.send_header("content-length", str(len(body)))
      self.end_headers()
      self.wfile.write(body)
      return
    if self.path == "/v1/models":
      self.send_json(200, {"object": "list", "data": [{"id": MODEL, "object": "model"}]})
      return
    self.send_error(404)

  def do_POST(self):
    global request_count
    if self.path != "/v1/chat/completions":
      self.send_error(404)
      return
    length = int(self.headers.get("content-length", "0") or "0")
    if length:
      self.rfile.read(length)
    request_count += 1
    self.send_json(
      200,
      {
        "id": f"mock-{NODE_ID}-{request_count}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": MODEL,
        "choices": [
          {
            "index": 0,
            "message": {
              "role": "assistant",
              "content": "Mock OCR-BBox response.",
            },
            "finish_reason": "stop",
          },
        ],
      },
    )

  def log_message(self, fmt, *args):
    print(
      f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} "
      f"{NODE_ID} {fmt % args}",
      flush=True,
    )


ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
