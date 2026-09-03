#!/usr/bin/env python3
import json
import os
import re
import socket
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


NODE_ID = os.getenv("NODE_ID", socket.gethostname())
PORT = int(os.getenv("PORT", "8000"))
REDIS_HOST = os.getenv("REDIS_HOST", "xyne-redis")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
RESULT_STREAM = os.getenv("DOCLING_RESULTS_STREAM", "docling:results")
RESULT_KEY_PREFIX = os.getenv("DOCLING_RESULT_KEY_PREFIX", "docling:async:result")
GLOBAL_ACTIVE_KEY = os.getenv("DOCLING_WRAPPER_GLOBAL_ACTIVE_KEY", "docling:async:global:active")
A100_URL = os.getenv("A100_URL", "http://xyne-a100-lb:8000").rstrip("/")
PROCESS_SECONDS = float(os.getenv("SIM_PROCESS_SECONDS", "1.0"))
MAX_INFLIGHT = int(os.getenv("SIM_MAX_INFLIGHT", "32"))

active_jobs: set[str] = set()
active_lock = threading.Lock()


def encode_redis_command(*args: str) -> bytes:
  out = [f"*{len(args)}\r\n".encode()]
  for arg in args:
    encoded = str(arg).encode()
    out.append(f"${len(encoded)}\r\n".encode())
    out.append(encoded)
    out.append(b"\r\n")
  return b"".join(out)


def read_redis_response(sock: socket.socket):
  prefix = sock.recv(1)
  if not prefix:
    raise RuntimeError("empty Redis response")
  line = b""
  while not line.endswith(b"\r\n"):
    chunk = sock.recv(1)
    if not chunk:
      raise RuntimeError("truncated Redis response")
    line += chunk
  text = line[:-2].decode(errors="replace")
  if prefix == b"+":
    return text
  if prefix == b":":
    return int(text)
  if prefix == b"-":
    raise RuntimeError(text)
  if prefix == b"$":
    size = int(text)
    if size < 0:
      return None
    data = b""
    while len(data) < size + 2:
      data += sock.recv(size + 2 - len(data))
    return data[:size].decode(errors="replace")
  if prefix == b"*":
    return [read_redis_response(sock) for _ in range(int(text))]
  raise RuntimeError(f"unsupported Redis response prefix {prefix!r}")


def redis_command(*args: str):
  with socket.create_connection((REDIS_HOST, REDIS_PORT), timeout=3) as sock:
    sock.sendall(encode_redis_command(*args))
    return read_redis_response(sock)


def field_value(body: bytes, name: str, fallback: str = "") -> str:
  pattern = rb'name="' + re.escape(name.encode()) + rb'"\r\n\r\n(.*?)\r\n--'
  match = re.search(pattern, body, flags=re.S)
  if not match:
    return fallback
  return match.group(1).decode(errors="replace").strip()


def filename_value(body: bytes) -> str:
  match = re.search(rb'filename="([^"]+)"', body)
  if not match:
    return "simulated.pdf"
  return match.group(1).decode(errors="replace")


def docling_response(job_id: str, file_name: str, doc_id: str):
  return {
    "metadata": {
      "doc_id": doc_id,
      "filename": file_name,
      "num_pages": 1,
      "num_images": 0,
      "processing_time": PROCESS_SECONDS,
      "has_toc": False,
      "vlm": {
        "enabled": True,
        "preset": "xyne-5090-a100-sim",
        "model": "xyne-a100-lb",
        "tables_replaced": 0,
        "pictures_replaced": 0,
        "scanned_pages_ocrd": 1,
      },
    },
    "toc": {"entries": []},
    "chunks": [
      {
        "text": f"Simulated OCR result from {NODE_ID} for {file_name}. job_id={job_id}",
        "headings": [],
        "page_numbers": [1],
      }
    ],
    "image_chunks": [],
    "images": {},
  }


def complete_job(job_id: str, file_id: str, doc_id: str, vespa_doc_id: str, file_name: str):
  try:
    try:
      urllib.request.urlopen(f"{A100_URL}/metrics", timeout=3).read(1024)
    except Exception:
      pass
    time.sleep(PROCESS_SECONDS)
    result_key = f"{RESULT_KEY_PREFIX}:{job_id}"
    redis_command("SET", result_key, json.dumps(docling_response(job_id, file_name, doc_id)))
    redis_command(
      "XADD",
      RESULT_STREAM,
      "*",
      "job_id",
      job_id,
      "file_id",
      file_id,
      "doc_id",
      doc_id,
      "vespa_doc_id",
      vespa_doc_id,
      "status",
      "ok",
      "result_key",
      result_key,
      "wrapper_node",
      NODE_ID,
    )
  finally:
    redis_command("ZREM", GLOBAL_ACTIVE_KEY, job_id)
    with active_lock:
      active_jobs.discard(job_id)


class Handler(BaseHTTPRequestHandler):
  server_version = "xyne-wrapper-sim/1.0"

  def send_json(self, status: int, payload: dict):
    body = json.dumps(payload).encode()
    self.send_response(status)
    self.send_header("content-type", "application/json")
    self.send_header("content-length", str(len(body)))
    self.end_headers()
    self.wfile.write(body)

  def do_GET(self):
    if self.path == "/health":
      self.send_response(200)
      self.send_header("content-type", "text/plain")
      self.end_headers()
      self.wfile.write(b"ok\n")
      return
    if self.path == "/instance_status":
      with active_lock:
        active_count = len(active_jobs)
      self.send_json(
        200,
        {
          "node_id": NODE_ID,
          "status": "healthy",
          "active_jobs": active_count,
          "max_inflight": MAX_INFLIGHT,
          "a100_url": A100_URL,
        },
      )
      return
    self.send_error(404)

  def do_POST(self):
    if self.path != "/process_async":
      self.send_error(404)
      return
    with active_lock:
      if len(active_jobs) >= MAX_INFLIGHT:
        self.send_json(429, {"status": "busy", "node_id": NODE_ID})
        return

    length = int(self.headers.get("content-length", "0") or "0")
    body = self.rfile.read(length)
    now = str(int(time.time() * 1000))
    job_id = field_value(body, "job_id", f"sim:{NODE_ID}:{now}")
    file_id = field_value(body, "file_id", f"file:{job_id}")
    doc_id = field_value(body, "doc_id", f"doc:{job_id}")
    vespa_doc_id = field_value(body, "vespa_doc_id", f"vespa:{job_id}")
    file_name = filename_value(body)

    with active_lock:
      active_jobs.add(job_id)
    redis_command("ZADD", GLOBAL_ACTIVE_KEY, now, job_id)
    threading.Thread(
      target=complete_job,
      args=(job_id, file_id, doc_id, vespa_doc_id, file_name),
      daemon=True,
    ).start()
    self.send_json(202, {"status": "accepted", "job_id": job_id, "node_id": NODE_ID})

  def log_message(self, fmt, *args):
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {NODE_ID} {fmt % args}", flush=True)


ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
