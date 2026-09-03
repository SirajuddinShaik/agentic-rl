#!/usr/bin/env python3
import json
import os
import socket
import threading
import time
import urllib.error
import urllib.request
import uuid
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


NODE_ID = os.getenv("NODE_ID", socket.gethostname())
PORT = int(os.getenv("PORT", "8000"))
REDIS_HOST = os.getenv("REDIS_HOST", "xyne-redis")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
RESULT_STREAM = os.getenv("DOCLING_RESULTS_STREAM", "docling:results")
RESULT_KEY_PREFIX = os.getenv("DOCLING_RESULT_KEY_PREFIX", "docling:async:result")
GLOBAL_ACTIVE_KEY = os.getenv(
  "DOCLING_WRAPPER_GLOBAL_ACTIVE_KEY",
  "docling:async:global:active",
)
DOCLING_PROCESS_URL = os.getenv(
  "DOCLING_PROCESS_URL",
  "http://docling-ocr:8000/process",
).rstrip("/")
PROCESS_TIMEOUT_SECONDS = float(os.getenv("DOCLING_PROCESS_TIMEOUT_SECONDS", "900"))
MAX_INFLIGHT = int(os.getenv("WRAPPER_MAX_INFLIGHT", "4"))

active_jobs: set[str] = set()
active_lock = threading.Lock()


def prometheus_label_value(value: str) -> str:
  return value.replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def wrapper_metrics_text() -> bytes:
  with active_lock:
    active_count = len(active_jobs)
  available_slots = max(MAX_INFLIGHT - active_count, 0)
  active_instances = 1 if active_count > 0 else 0
  idle_instances = 1 if active_count == 0 else 0
  global_admission_enabled = 1 if available_slots > 0 else 0
  labels = f'node_id="{prometheus_label_value(NODE_ID)}"'
  lines = [
    "# HELP lighton_ocr_wrapper_up Whether the OCR wrapper process is up.",
    "# TYPE lighton_ocr_wrapper_up gauge",
    f"lighton_ocr_wrapper_up{{{labels}}} 1",
    "# HELP lighton_ocr_wrapper_active_instances Active wrapper instances on this node.",
    "# TYPE lighton_ocr_wrapper_active_instances gauge",
    f"lighton_ocr_wrapper_active_instances{{{labels}}} {active_instances}",
    "# HELP lighton_ocr_wrapper_idle_instances Idle wrapper instances on this node.",
    "# TYPE lighton_ocr_wrapper_idle_instances gauge",
    f"lighton_ocr_wrapper_idle_instances{{{labels}}} {idle_instances}",
    "# HELP lighton_ocr_wrapper_configured_instances Configured wrapper instances on this node.",
    "# TYPE lighton_ocr_wrapper_configured_instances gauge",
    f"lighton_ocr_wrapper_configured_instances{{{labels}}} 1",
    "# HELP lighton_ocr_wrapper_global_admission_enabled Whether this wrapper can admit more jobs.",
    "# TYPE lighton_ocr_wrapper_global_admission_enabled gauge",
    f"lighton_ocr_wrapper_global_admission_enabled{{{labels}}} {global_admission_enabled}",
    "# HELP lighton_ocr_wrapper_global_max_inflight Global max inflight jobs configured for this wrapper.",
    "# TYPE lighton_ocr_wrapper_global_max_inflight gauge",
    f"lighton_ocr_wrapper_global_max_inflight{{{labels}}} {MAX_INFLIGHT}",
    "# HELP lighton_ocr_wrapper_active_jobs Active jobs currently running on this wrapper.",
    "# TYPE lighton_ocr_wrapper_active_jobs gauge",
    f"lighton_ocr_wrapper_active_jobs{{{labels}}} {active_count}",
    "# HELP lighton_ocr_wrapper_max_inflight Max inflight jobs configured for this wrapper.",
    "# TYPE lighton_ocr_wrapper_max_inflight gauge",
    f"lighton_ocr_wrapper_max_inflight{{{labels}}} {MAX_INFLIGHT}",
    "# HELP lighton_ocr_wrapper_available_slots Available inflight job slots on this wrapper.",
    "# TYPE lighton_ocr_wrapper_available_slots gauge",
    f"lighton_ocr_wrapper_available_slots{{{labels}}} {available_slots}",
    "",
  ]
  return "\n".join(lines).encode()


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
  with socket.create_connection((REDIS_HOST, REDIS_PORT), timeout=5) as sock:
    sock.sendall(encode_redis_command(*args))
    return read_redis_response(sock)


def parse_multipart(body: bytes, content_type: str):
  raw = (
    f"Content-Type: {content_type}\r\n"
    "MIME-Version: 1.0\r\n\r\n"
  ).encode() + body
  message = BytesParser(policy=email_policy).parsebytes(raw)
  fields: dict[str, str] = {}
  file_name = "document.pdf"
  file_bytes: bytes | None = None

  for part in message.iter_parts():
    disposition = part.get("content-disposition", "")
    name = part.get_param("name", header="content-disposition")
    if not name or "form-data" not in disposition:
      continue
    payload = part.get_payload(decode=True) or b""
    filename = part.get_filename()
    if filename:
      file_name = filename
      file_bytes = payload
    else:
      fields[name] = payload.decode(errors="replace")

  if file_bytes is None:
    raise ValueError("missing multipart file")
  return fields, file_name, file_bytes


def multipart_form(fields: dict[str, str], file_name: str, file_bytes: bytes):
  boundary = f"xyne-lighton-{uuid.uuid4().hex}"
  chunks: list[bytes] = []
  for key, value in fields.items():
    chunks.append(f"--{boundary}\r\n".encode())
    chunks.append(
      f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode(),
    )
    chunks.append(str(value).encode())
    chunks.append(b"\r\n")
  chunks.append(f"--{boundary}\r\n".encode())
  chunks.append(
    (
      'Content-Disposition: form-data; name="file"; '
      f'filename="{file_name}"\r\n'
      "Content-Type: application/pdf\r\n\r\n"
    ).encode(),
  )
  chunks.append(file_bytes)
  chunks.append(b"\r\n")
  chunks.append(f"--{boundary}--\r\n".encode())
  return boundary, b"".join(chunks)


def call_docling_process(file_name: str, file_bytes: bytes, doc_id: str):
  boundary, payload = multipart_form(
    {"doc_id": doc_id},
    file_name,
    file_bytes,
  )
  request = urllib.request.Request(
    DOCLING_PROCESS_URL,
    data=payload,
    method="POST",
    headers={
      "Content-Type": f"multipart/form-data; boundary={boundary}",
      "Content-Length": str(len(payload)),
    },
  )
  with urllib.request.urlopen(request, timeout=PROCESS_TIMEOUT_SECONDS) as response:
    raw = response.read()
  return json.loads(raw.decode())


def publish_result(
  job_id: str,
  file_id: str,
  doc_id: str,
  vespa_doc_id: str,
  result: dict,
):
  result_key = f"{RESULT_KEY_PREFIX}:{job_id}"
  redis_command("SET", result_key, json.dumps(result))
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


def publish_failure(
  job_id: str,
  file_id: str,
  doc_id: str,
  vespa_doc_id: str,
  error: str,
):
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
    "failed",
    "error",
    error[:1000],
    "wrapper_node",
    NODE_ID,
  )


def complete_job(
  job_id: str,
  file_id: str,
  doc_id: str,
  vespa_doc_id: str,
  file_name: str,
  file_bytes: bytes,
):
  started = time.time()
  try:
    result = call_docling_process(file_name, file_bytes, doc_id)
    publish_result(job_id, file_id, doc_id, vespa_doc_id, result)
    elapsed_ms = int((time.time() - started) * 1000)
    print(
      f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} "
      f"{NODE_ID} completed job_id={job_id} file={file_name!r} "
      f"elapsed_ms={elapsed_ms}",
      flush=True,
    )
  except Exception as exc:
    error = str(exc)
    if isinstance(exc, urllib.error.HTTPError):
      try:
        error = f"{exc} {exc.read(1000).decode(errors='replace')}"
      except Exception:
        error = str(exc)
    publish_failure(job_id, file_id, doc_id, vespa_doc_id, error)
    print(
      f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} "
      f"{NODE_ID} failed job_id={job_id} error={error}",
      flush=True,
    )
  finally:
    redis_command("ZREM", GLOBAL_ACTIVE_KEY, job_id)
    with active_lock:
      active_jobs.discard(job_id)


class Handler(BaseHTTPRequestHandler):
  server_version = "xyne-lighton-wrapper/1.0"

  def send_json(self, status: int, payload: dict):
    body = json.dumps(payload).encode()
    self.send_response(status)
    self.send_header("content-type", "application/json")
    self.send_header("content-length", str(len(body)))
    self.end_headers()
    self.wfile.write(body)

  def do_GET(self):
    if self.path == "/health":
      try:
        urllib.request.urlopen(
          DOCLING_PROCESS_URL.rsplit("/", 1)[0] + "/health",
          timeout=5,
        ).read(1024)
        self.send_response(200)
        self.send_header("content-type", "text/plain")
        self.end_headers()
        self.wfile.write(b"ok\n")
      except Exception as exc:
        self.send_json(503, {"status": "unhealthy", "error": str(exc)})
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
          "docling_process_url": DOCLING_PROCESS_URL,
        },
      )
      return
    if self.path == "/metrics":
      body = wrapper_metrics_text()
      self.send_response(200)
      self.send_header("content-type", "text/plain; version=0.0.4; charset=utf-8")
      self.send_header("content-length", str(len(body)))
      self.end_headers()
      self.wfile.write(body)
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
    try:
      fields, file_name, file_bytes = parse_multipart(
        body,
        self.headers.get("content-type", ""),
      )
    except Exception as exc:
      self.send_json(400, {"status": "invalid_request", "error": str(exc)})
      return

    now = str(int(time.time() * 1000))
    job_id = fields.get("job_id") or f"lighton:{NODE_ID}:{now}"
    file_id = fields.get("file_id") or f"file:{job_id}"
    doc_id = fields.get("doc_id") or f"doc:{job_id}"
    vespa_doc_id = fields.get("vespa_doc_id") or f"vespa:{job_id}"

    with active_lock:
      active_jobs.add(job_id)
    redis_command("ZADD", GLOBAL_ACTIVE_KEY, now, job_id)
    threading.Thread(
      target=complete_job,
      args=(job_id, file_id, doc_id, vespa_doc_id, file_name, file_bytes),
      daemon=True,
    ).start()
    self.send_json(202, {"status": "accepted", "job_id": job_id, "node_id": NODE_ID})

  def log_message(self, fmt, *args):
    print(
      f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} "
      f"{NODE_ID} {fmt % args}",
      flush=True,
    )


ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
