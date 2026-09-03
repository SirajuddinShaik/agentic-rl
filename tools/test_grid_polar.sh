#!/usr/bin/env bash
set -euo pipefail

MODEL="${1:-glm-flash-experimental}"
POLAR_BIN="${POLAR_BIN:-/data/siraj/ARL/.venv/bin/polar}"
CREDENTIALS_FILE="${CREDENTIALS_FILE:-/data/siraj/ARL/miles/miles/examples/polar_swegym_grpo/polar_credentials.env}"
WORK_DIR="$(mktemp -d /tmp/grid-polar-smoke.XXXXXX)"
ROLLOUT_PORT="${ROLLOUT_PORT:-18090}"
GATEWAY_PORT="${GATEWAY_PORT:-18111}"
PROXY_PORT="${PROXY_PORT:-18112}"
SESSION_ID="grid-polar-smoke-$(date +%s)"

if [[ -f "$CREDENTIALS_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$CREDENTIALS_FILE"
  set +a
fi

: "${JUSPAY_API_KEY:?Set JUSPAY_API_KEY or add it to $CREDENTIALS_FILE}"

cleanup() {
  local pid
  for pid in "${GATEWAY_PID:-}" "${ROLLOUT_PID:-}" "${PROXY_PID:-}"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT INT TERM

cat >"$WORK_DIR/grid_proxy.py" <<'PY'
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
import urllib.error
import urllib.request

UPSTREAM = os.environ.get("GRID_BASE_URL", "https://grid.ai.juspay.net").rstrip("/")
API_KEY = os.environ["JUSPAY_API_KEY"]
PORT = int(os.environ["GRID_PROXY_PORT"])


class Handler(BaseHTTPRequestHandler):
    def relay(self):
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length) if length else None
        request = urllib.request.Request(
            UPSTREAM + self.path,
            data=body,
            method=self.command,
            headers={
                "Accept": "application/json",
                "Content-Type": self.headers.get("content-type", "application/json"),
                "Authorization": f"Bearer {API_KEY}",
            },
        )
        try:
            response = urllib.request.urlopen(request, timeout=300)
            status, payload, headers = response.status, response.read(), response.headers
        except urllib.error.HTTPError as error:
            status, payload, headers = error.code, error.read(), error.headers
        self.send_response(status)
        self.send_header("Content-Type", headers.get("content-type", "application/json"))
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_GET = relay
    do_POST = relay

    def log_message(self, format, *args):
        return


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
PY

cat >"$WORK_DIR/topology.yaml" <<YAML
rollout:
  host: 127.0.0.1
  port: $ROLLOUT_PORT
  public_url: http://127.0.0.1:$ROLLOUT_PORT
  save_dir: $WORK_DIR/results

gateway:
  heartbeat_interval_seconds: 1
  nodes:
    - id: grid-smoke-node
      host: 127.0.0.1
      port: $GATEWAY_PORT
      public_url: http://127.0.0.1:$GATEWAY_PORT
      model_served: $MODEL
      max_init_workers: 1
      max_run_workers: 2
      max_postrun_workers: 1
      inference:
        engine: vllm
        base_url: http://127.0.0.1:$PROXY_PORT
YAML

GRID_PROXY_PORT="$PROXY_PORT" python3 "$WORK_DIR/grid_proxy.py" \
  >"$WORK_DIR/grid_proxy.log" 2>&1 &
PROXY_PID=$!

"$POLAR_BIN" serve_rollout -c "$WORK_DIR/topology.yaml" \
  >"$WORK_DIR/rollout.log" 2>&1 &
ROLLOUT_PID=$!

for _ in $(seq 1 30); do
  curl -sf -m 2 "http://127.0.0.1:$ROLLOUT_PORT/health" >/dev/null && break
  sleep 1
done
curl -sf -m 2 "http://127.0.0.1:$ROLLOUT_PORT/health" >/dev/null

"$POLAR_BIN" serve_gateway -c "$WORK_DIR/topology.yaml" --node-id grid-smoke-node \
  >"$WORK_DIR/gateway.log" 2>&1 &
GATEWAY_PID=$!

for _ in $(seq 1 30); do
  curl -sf -m 2 "http://127.0.0.1:$GATEWAY_PORT/health" >/dev/null && break
  sleep 1
done
curl -sf -m 2 "http://127.0.0.1:$GATEWAY_PORT/health" >/dev/null

curl -sf -m 10 -X POST "http://127.0.0.1:$GATEWAY_PORT/sessions" \
  -H 'Content-Type: application/json' \
  -d "{\"session_id\":\"$SESSION_ID\"}" >/dev/null

curl -sf --max-time 300 "http://127.0.0.1:$GATEWAY_PORT/v1/chat/completions" \
  -H "X-Session-Id: $SESSION_ID" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: GRID_POLAR_OK\"}],\"temperature\":0,\"max_tokens\":128}" \
  >"$WORK_DIR/response.json"

CONTENT="$(jq -r '.choices[0].message.content // .choices[0].message.reasoning_content // empty' "$WORK_DIR/response.json")"
CAPTURE_COUNT=0
for _ in $(seq 1 20); do
  CAPTURE_COUNT="$(curl -sf -m 10 "http://127.0.0.1:$GATEWAY_PORT/sessions/$SESSION_ID/completions" | jq '.completions | length')"
  [[ "$CAPTURE_COUNT" -ge 1 ]] && break
  sleep 0.5
done

if [[ -z "$CONTENT" || "$CAPTURE_COUNT" -lt 1 ]]; then
  echo "FAIL: response or Polar capture missing"
  jq . "$WORK_DIR/response.json"
  exit 1
fi

echo "PASS: Grid -> Polar gateway -> Grid"
echo "model=$MODEL"
echo "session=$SESSION_ID"
echo "captured_completions=$CAPTURE_COUNT"
echo "response=$CONTENT"
