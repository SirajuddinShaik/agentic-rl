#!/usr/bin/env bash
# test_without_polar.sh
# Standalone test: run the Xyne helper directly against the persistent xyne-harness-standalone-never-delete
# backend (no Polar rollout server, no LITELLM proxy, no GRPO session attribution).
#
# This proves the backend + helper + auth chain works and produces real answers.
# The LLM model used is whatever the xyne-harness-standalone-never-delete backend is configured with
# (Nemotron via sglang :30100, or you can point it at grid.ai models).
#
# Usage:
#   bash test_without_polar.sh [NUM_QUESTIONS] [MODEL]
#   NUM_QUESTIONS defaults to 3
#   MODEL: if set, reboots xyne-harness-standalone-never-delete to use this model via grid.ai
#          (e.g. kimi-latest, glm-latest, glm-flash-experimental)
#
# Examples:
#   bash test_without_polar.sh                  # 3 questions, current model
#   bash test_without_polar.sh 5 kimi-latest    # 5 questions, switch to kimi
#   bash test_without_polar.sh 3 glm-flash-experimental

set -euo pipefail

NUM_QUESTIONS="${1:-3}"
MODEL="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER_SOURCE="/data/siraj/ARL/miles/polar-pkg/polar/xyne/xyne_fetch_flow.py"
TRAIN_DATA="/data/siraj/xyne_s/xyne_qa_train.jsonl"
CONTAINER="xyne-harness-standalone-never-delete"
BACKEND_URL="http://localhost:3001"
AGENT_ID="nj5ednjmpfx9qt56s6wiocu6"
TOKEN="${XYNE_ACCESS_TOKEN:?Set XYNE_ACCESS_TOKEN}"
ACCESS_TOKEN_SECRET="${ACCESS_TOKEN_SECRET:?Set ACCESS_TOKEN_SECRET}"
JWT_SECRET="${JWT_SECRET:?Set JWT_SECRET}"
JUSPAY_API_KEY="${JUSPAY_API_KEY:-${juspayapikey:-}}"
GRID_BASE_URL="${GRID_BASE_URL:-https://grid.ai.juspay.net/}"
OUTPUT_DIR="${OUTPUT_DIR:-/data/siraj/xyne_s/flow_dumps}"
PRINT_FULL_DUMP="${PRINT_FULL_DUMP:-0}"

echo "============================================"
echo "  XYNE HARNESS TEST — WITHOUT POLAR"
echo "  Questions: $NUM_QUESTIONS"
echo "  Model: ${MODEL:-current (Nemotron)}"
echo "============================================"
echo ""

# --- Optionally reboot xyne-harness-standalone-never-delete with a different model ---
if [[ -n "$MODEL" ]]; then
    if [[ -z "${JUSPAY_API_KEY:-}" ]]; then
        echo "ERROR: MODEL=$MODEL requires JUSPAY_API_KEY (or juspayapikey); export it before rebooting the container."
        exit 2
    fi
    echo "[1/4] Rebooting xyne-harness-standalone-never-delete with model=$MODEL (via grid.ai)..."
    docker rm -f "$CONTAINER" 2>/dev/null || true
    docker run -d --name "$CONTAINER" --network host \
        -v /data/siraj/xyne_s/xyne-search:/workspace/xyne/server:rw \
        -w /workspace/xyne/server/server \
        --entrypoint sleep polar-xyne-runtime:withwait infinity >/dev/null 2>&1

    docker exec -e MODEL="$MODEL" "$CONTAINER" bash -c '
        export BACKENDV2_PORT=3001 DATABASE_HOST=localhost DATABASE_PORT=15432
        export DATABASE_URL="postgresql://xyne:xyne@localhost:15432/xyne?sslmode=disable"
        export VESPA_FEED_PORT=18080 VESPA_HOST=localhost VESPA_QUERY_PORT=18081 VESPA_REQUIRED=false
        export NODE_ENV=production HOST=http://localhost:3001
        export MODELS_LIST="${MODEL},glm-latest,kimi-latest,glm-flash-experimental,open-fast"
        export LITELLM_API_KEY="'"$JUSPAY_API_KEY"'"
        export LITELLM_BASE_URL="'"$GRID_BASE_URL"'"
        export LITELLM_BEST_AGENTIC_MODEL="'"$MODEL"'"
        export LITELLM_BEST_MODEL="'"$MODEL"'"
        export LITELLM_FAST_MODEL="'"$MODEL"'"
        export LITELLM_SQL_INFERENCE_MODEL="'"$MODEL"'"
        export LITELLM_DEEP_RESEARCH_MODEL="'"$MODEL"'"
        export LITELLM_WEB_SEARCH_MODEL="'"$MODEL"'"
        export LITELLM_FOLLOWUP_MODEL="'"$MODEL"'"
        export ACCESS_TOKEN_SECRET="'"$ACCESS_TOKEN_SECRET"'"
        export JWT_SECRET="'"$JWT_SECRET"'"
        export GOOGLE_PROD_REDIRECT_URI=http://localhost:3001/v1/auth/callback
        cd /workspace/xyne/server/server
        nohup bun app/server.ts >/tmp/xyne-harness-standalone-never-delete.log 2>&1 &
        echo "backend PID $!"
    '
    echo "  Waiting for backend health..."
    for i in $(seq 1 30); do
        if curl -sf -o /dev/null -m 2 "$BACKEND_URL/v2/health" 2>/dev/null; then
            echo "  Health: OK (took ${i}s)"
            break
        fi
        sleep 2
    done
    curl -sf -o /dev/null -w "  Health check: %{http_code}\n" "$BACKEND_URL/v2/health"

    echo "  Enabling native retrieval tools on the default SEBI agent..."
    RETRIEVAL_TOOLS='["vespaSearch","getChunks","searchWithinDoc","proximitySearch","documentSearch","getFolderTree"]'
    if ! docker exec siraj-xyne-db psql -U xyne -d xyne -v ON_ERROR_STOP=1 -Atc \
        "UPDATE agents SET tools='$RETRIEVAL_TOOLS'::jsonb, updated_at=NOW() WHERE is_default=true AND deleted_at IS NULL; SELECT tools FROM agents WHERE is_default=true AND deleted_at IS NULL;" \
        | grep -Fq 'getFolderTree'; then
        echo "  ERROR: Could not enable retrieval tools on the default agent in Postgres."
        exit 1
    fi
    echo "  Native retrieval tools: $RETRIEVAL_TOOLS"
else
    echo "[1/4] Using existing xyne-harness-standalone-never-delete (model=Nemotron via sglang)..."
    HEALTH=$(curl -sf -o /dev/null -w "%{http_code}" "$BACKEND_URL/v2/health" 2>/dev/null || echo "000")
    if [[ "$HEALTH" != "200" ]]; then
        echo "  ERROR: xyne-harness-standalone-never-delete not healthy (health=$HEALTH). Start it first:"
        echo "  docker run -d --name xyne-harness-standalone-never-delete --network host ..."
        exit 1
    fi
    echo "  Health: OK"
fi

if [[ -z "$TOKEN" ]]; then
    echo "ERROR: XYNE_ACCESS_TOKEN is not set. The helper needs the access-token cookie."
    exit 2
fi
mkdir -p "$OUTPUT_DIR"

# --- Copy helper into container ---
echo "[2/4] Copying helper into container..."
docker cp "$HELPER_SOURCE" "$CONTAINER:/polar/session/xyne_fetch_flow.py" 2>/dev/null || true
docker exec "$CONTAINER" mkdir -p /polar/session 2>/dev/null || true
docker cp "$HELPER_SOURCE" "$CONTAINER:/polar/session/xyne_fetch_flow.py"
echo "  Done"

# --- Run questions ---
echo "[3/4] Running $NUM_QUESTIONS test questions..."
echo ""

SUCCESS=0
FAIL=0

head -n "$NUM_QUESTIONS" "$TRAIN_DATA" | python3 -c "
import sys, json
for line in sys.stdin:
    d = json.loads(line)
    print(json.dumps({'prompt': d['prompt'], 'label': d.get('label','')}))
" | while IFS= read -r line; do
    QUESTION=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['prompt'])")
    LABEL=$(echo "$line" | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['label'][:200])")

    echo "------------------------------------------------------------"
    echo "Q: ${QUESTION:0:120}..."
    echo "Expected: ${LABEL:0:120}..."
    echo ""

    OUTPUT_BASENAME="test_raw_$(date +%s%N).json"
    OUTPUT_FILE="/polar/session/$OUTPUT_BASENAME"
    HOST_OUTPUT_FILE="$OUTPUT_DIR/$OUTPUT_BASENAME"
    HELPER_ARGS=(
        --instruction "$QUESTION"
        --output "$OUTPUT_FILE"
        --base-url "$BACKEND_URL"
        --agent-id "$AGENT_ID"
        --timeout 300
    )
    if ! docker exec -e XYNE_ACCESS_TOKEN="$TOKEN" "$CONTAINER" \
        python3 /polar/session/xyne_fetch_flow.py \
        "${HELPER_ARGS[@]}"; then
        echo "ERROR: helper failed for this question; container output path: $OUTPUT_FILE"
        continue
    fi
    docker cp "$CONTAINER:$OUTPUT_FILE" "$HOST_OUTPUT_FILE" >/dev/null

    echo ""
    echo "--- Raw flow result ---"
    python3 - "$HOST_OUTPUT_FILE" "$PRINT_FULL_DUMP" <<'PY'
import json, sys
path = sys.argv[1]
print_full = sys.argv[2] == '1'
with open(path, encoding='utf-8') as f:
    d = json.load(f)
print(f"conversation_id: {d.get('conversation_id', '?')}")
print(f"run_id:         {d.get('run_id', '?')}")
print(f"error:          {d.get('error', 'None')}")
print(f"latency_ms:     {d.get('latency_ms', '?')}")
ans = d.get('answer','')
print(f'answer_len:     {len(ans)}')
print(f'answer_preview: {ans[:500]}')
print(f"tool_calls:     {len(d.get('tool_calls', []))}")
print(f"tool_use:      {len(d.get('tool_use_blocks', []))}")
print(f"tool_results:   {len(d.get('tool_result_blocks', []))}")
print(f"citations:      {len(d.get('citations', []))}")
print(f"sub_agents:     {len(d.get('sub_agents', []))}")
print(f"messages:       {len(d.get('messages', []))}")
print(f"runs:           {len(d.get('runs', []))}")
print(f"thinking:       {len(d.get('thinking', []))}")
print(f"token_usage:    {d.get('token_usage', {})}")
print(f'full_dump:      {path}')
if print_full:
    print(json.dumps(d, ensure_ascii=False, indent=2))
PY
    echo ""
done

echo "[4/4] Done. Check answers above for quality."
echo "Full dumps are stored under: $OUTPUT_DIR"
echo ""
echo "NOTE: Without Polar, there is no GRPO session attribution."
echo "      The LITELLM proxy is not started, so LLM completions"
echo "      are not captured as traces. This test only verifies"
echo "      that the backend + helper + auth produce real answers."
