#!/usr/bin/env python3
"""
test_with_polar.py

Full-pipeline test: submit a task to the Polar rollout server (:8080),
poll for completion, and display the trajectory + composite score.

This tests the END-TO-END chain:
  rollout server → gateway node → harness.run_steps() → LocalRuntime exec
  → LITELLM proxy (session-id injection) → xyne-harness-standalone-never-delete backend → helper
  → postprocess (xyne_raw) → XyneCompositeEvaluator → composite score

Usage:
  python3 test_with_polar.py [NUM_QUESTIONS] [MODEL]

  NUM_QUESTIONS  default 1
  MODEL          if set, reboots xyne-harness-standalone-never-delete to use this model via grid.ai
                 (kimi-latest, glm-latest, glm-flash-experimental, kimi-k3)

Examples:
  python3 test_with_polar.py                          # 1 question, current model
  python3 test_with_polar.py 3 kimi-latest            # 3 questions, switch to kimi
  python3 test_with_polar.py 2 glm-flash-experimental # 2 questions, switch to glm-flash
"""

import json
import os
import sys
import time
import subprocess
import urllib.request
import urllib.error

TRAIN_DATA = "/data/siraj/xyne_s/xyne_qa_train.jsonl"
ROLLOUT_URL = "http://127.0.0.1:8080"
BACKEND_URL = "http://localhost:3001"
XYNE_SERVER_DIR = "/data/siraj/xyne_s/xyne-search"
AGENT_CLI_DIR = "/data/siraj/ARL/miles/tmp/swegym_agent_cli/opt_node"
RUNTIME_IMAGE = "polar-xyne-runtime:withwait"
TOKEN = os.environ["XYNE_ACCESS_TOKEN"]
ACCESS_TOKEN_SECRET = os.environ["ACCESS_TOKEN_SECRET"]
JWT_SECRET = os.environ["JWT_SECRET"]
XYNE_API_KEY = os.environ["XYNE_API_KEY"]
JUSPAY_API_KEY = os.environ.get("JUSPAY_API_KEY", "")
SCORERS = [
    {"name": "completion", "weight": 1.0},
    {"name": "answer_format", "weight": 0.5},
    {"name": "retrieval_quality", "weight": 0.5},
    {
        "method": "f1",
        "name": "embedding_similarity",
        "reference_answer": "{sample.label}",
        "weight": 2.0,
    },
    {"budget": 8, "name": "tool_call_efficiency", "weight": 1.0},
    {"budget_tokens": 4096, "name": "token_efficiency", "weight": 1.0},
]


def _post_json(url: str, payload: dict, timeout: int = 10) -> tuple[int, dict]:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, {"raw": body}
    except Exception as e:
        return 0, {"error": str(e)}


def _get_json(url: str, timeout: int = 10) -> tuple[int, dict]:
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, {"raw": body}
    except Exception as e:
        return 0, {"error": str(e)}


def reboot_xyne_server(model: str) -> None:
    print(f"  Rebooting xyne-harness-standalone-never-delete with model={model} via grid.ai...")
    subprocess.run(["docker", "rm", "-f", "xyne-harness-standalone-never-delete"],
                   capture_output=True, check=False)
    subprocess.run([
        "docker", "run", "-d", "--name", "xyne-harness-standalone-never-delete",
        "--network", "host",
        "-v", f"{XYNE_SERVER_DIR}:/workspace/xyne/server:rw",
        "-w", "/workspace/xyne/server/server",
        "--entrypoint", "sleep",
        RUNTIME_IMAGE, "infinity",
    ], capture_output=True, check=True)

    env_exports = (
        f"export BACKENDV2_PORT=3001 DATABASE_HOST=localhost DATABASE_PORT=15432 "
        f'DATABASE_URL="postgresql://xyne:xyne@localhost:15432/xyne?sslmode=disable" '
        f"VESPA_FEED_PORT=18080 VESPA_HOST=localhost VESPA_QUERY_PORT=18081 "
        f"VESPA_REQUIRED=false NODE_ENV=production HOST=http://localhost:3001 "
        f'LITELLM_API_KEY="{JUSPAY_API_KEY}" '
        f'LITELLM_BASE_URL="https://grid.ai.juspay.net/" '
        f'LITELLM_BEST_AGENTIC_MODEL="{model}" '
        f'LITELLM_BEST_MODEL="{model}" '
        f'LITELLM_FAST_MODEL="{model}" '
        f'LITELLM_SQL_INFERENCE_MODEL="{model}" '
        f'ACCESS_TOKEN_SECRET="{ACCESS_TOKEN_SECRET}" '
        f'JWT_SECRET="{JWT_SECRET}" '
        f"GOOGLE_PROD_REDIRECT_URI=http://localhost:3001/v1/auth/callback"
    )
    cmd = f'{env_exports}; cd /workspace/xyne/server/server && nohup bun app/server.ts >/tmp/xyne-harness-standalone-never-delete.log 2>&1 & echo "PID $!"'
    subprocess.run(["docker", "exec", "xyne-harness-standalone-never-delete", "bash", "-c", cmd],
                   capture_output=True, check=False)

    print("  Waiting for backend health...", end=" ", flush=True)
    for i in range(30):
        st, _ = _get_json(f"{BACKEND_URL}/v2/health", timeout=3)
        if st == 200:
            print(f"OK ({i*2}s)")
            return
        time.sleep(2)
    print("TIMEOUT — backend not healthy")


def build_task_request(task_id: str, prompt: str, label: str,
                       doc_ids: list, metadata: dict) -> dict:
    return {
        "task_id": task_id,
        "instruction": prompt,
        "num_samples": 1,
        "timeout_seconds": 600.0,
        "agent": {
            "import_path": "polar.xyne.harness:XyneHarness",
            "model_name": "nemotron-30b-a3b",
            "settings": {
                "api_key": XYNE_API_KEY,
                "base_url": "http://localhost:3001",
                "boot_port": "3001",
                "health_interval_sec": 2,
                "health_timeout_sec": 120,
                "server_dir": "/workspace/xyne/server/server",
                "env_source": "/dev/null",
                "auth_email": "shaik.s@juspay.in",
                "auth_role": "SuperAdmin",
                "auth_workspace": os.environ["XYNE_AUTH_WORKSPACE"],
                "skip_boot": True,
            },
            "env": {
                "ACCESS_TOKEN_SECRET": ACCESS_TOKEN_SECRET,
                "DATABASE_HOST": "localhost",
                "DATABASE_PORT": "15432",
                "DATABASE_URL": "postgresql://xyne:xyne@localhost:15432/xyne?sslmode=disable",
                "JWT_SECRET": JWT_SECRET,
                "LITELLM_API_KEY": "dummy-polar-gateway",
                "LITELLM_BASE_URL": "http://127.0.0.1:8100",
                "LITELLM_BEST_AGENTIC_MODEL": "nemotron",
                "LITELLM_BEST_MODEL": "nemotron",
                "LITELLM_FAST_MODEL": "nemotron",
                "LITELLM_SQL_INFERENCE_MODEL": "nemotron",
                "NODE_ENV": "production",
                "HOST": "http://localhost:3001",
                "GOOGLE_PROD_REDIRECT_URI": "http://localhost:3001/v1/auth/callback",
                "VESPA_FEED_PORT": "18080",
                "VESPA_HOST": "localhost",
                "VESPA_QUERY_PORT": "18081",
                "VESPA_REQUIRED": "false",
                "XYNE_ACCESS_TOKEN": TOKEN,
            },
        },
        "builder": {"strategy": "prefix_merging"},
        "evaluator": {
            "strategy": "polar.xyne.evaluator:XyneCompositeEvaluator",
            "config": {
                "expected_doc_ids": doc_ids,
                "reference_answer": label,
                "scorers": SCORERS,
            },
        },
        "runtime": {
            "backend": "docker",
            "image": RUNTIME_IMAGE,
            "import_path": "polar.runtime.local:LocalRuntime",
            "env": {
                "HOME": "/polar/session/home",
                "PATH": "/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            },
            "prepare": [
                {
                    "type": "exec",
                    "command": "mkdir -p /polar/session/logs/agent /polar/session/home",
                }
            ],
            "network": "host",
            "workdir": "/polar/session",
        },
        "metadata": metadata,
    }


def submit_and_wait(task_request: dict, poll_interval: float = 3.0,
                    max_wait: float = 600.0) -> dict | None:
    task_id = task_request["task_id"]
    st, resp = _post_json(f"{ROLLOUT_URL}/rollout/task/submit", task_request, timeout=15)
    if st != 200:
        print(f"  SUBMIT FAILED (status={st}): {json.dumps(resp, indent=2)[:500]}")
        return None
    print(f"  Submitted task_id={task_id}")

    elapsed = 0.0
    while elapsed < max_wait:
        time.sleep(poll_interval)
        elapsed += poll_interval
        st, resp = _get_json(f"{ROLLOUT_URL}/rollout/task/{task_id}", timeout=10)
        if st != 200:
            print(f"  Poll error (status={st}): {resp}")
            continue
        status = resp.get("status", "?")
        completed = resp.get("completed_sessions", 0)
        total = resp.get("total_sessions", 0)
        results = resp.get("results", [])
        print(f"  [{elapsed:.0f}s] status={status} sessions={completed}/{total} results={len(results)}")

        if status in ("completed", "failed", "cancelled", "error"):
            return resp
    print(f"  TIMEOUT after {max_wait}s")
    return None


def print_result(result: dict) -> None:
    traj = result.get("trajectory", {})
    meta = traj.get("metadata", {})

    print(f"\n  --- Session Result ---")
    print(f"  session_id:   {result.get('session_id','?')}")
    print(f"  status:       {result.get('status','?')}")
    print(f"  error:        {result.get('error','None')}")

    traces = traj.get("traces", [])
    print(f"  traces:       {len(traces)}")
    if traces:
        for i, t in enumerate(traces):
            resp_ids = t.get("response_ids", [])
            print(f"    trace[{i}]: response_tokens={len(resp_ids)}")

    eval_meta = meta.get("evaluation", {})
    outcome_reward = eval_meta.get("outcome_reward")
    print(f"  outcome_reward (score): {outcome_reward}")

    xyne_raw = meta.get("xyne_raw")
    if xyne_raw:
        if isinstance(xyne_raw, str):
            xyne_raw = json.loads(xyne_raw)
        ans = xyne_raw.get("answer", "")
        print(f"  xyne_raw.conversation_id: {xyne_raw.get('conversation_id','?')}")
        print(f"  xyne_raw.run_id:         {xyne_raw.get('run_id','?')}")
        print(f"  xyne_raw.error:          {xyne_raw.get('error','None')}")
        print(f"  xyne_raw.answer_len:     {len(ans)}")
        print(f"  xyne_raw.answer_preview: {ans[:400]}")
    else:
        print(f"  xyne_raw: MISSING")
        if meta.get("xyne_raw_error"):
            print(f"  xyne_raw_error: {meta['xyne_raw_error']}")

    per_scorer = eval_meta.get("per_scorer", {})
    if per_scorer:
        print(f"\n  Per-scorer scores:")
        for name, score in per_scorer.items():
            print(f"    {name}: {score}")


def main() -> None:
    num_questions = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    model = sys.argv[2] if len(sys.argv) > 2 else ""

    print("=" * 55)
    print("  XYNE HARNESS TEST — WITH POLAR (full pipeline)")
    print(f"  Questions: {num_questions}")
    print(f"  Model: {model or 'current (Nemotron via sglang)'}")
    print("=" * 55)
    print()

    # --- Check prerequisites ---
    print("[1/3] Checking prerequisites...")
    st, _ = _get_json(f"{ROLLOUT_URL}/health", timeout=5)
    if st != 200:
        print(f"  ERROR: rollout server :8080 not healthy (status={st})")
        print("  Start the trainer first: docker exec miles-never-delete ... run_xyne_qa_fsdp.sh")
        sys.exit(1)
    print(f"  Rollout server :8080 = OK")

    st, _ = _get_json(f"{BACKEND_URL}/v2/health", timeout=5)
    if st != 200:
        print(f"  ERROR: xyne-harness-standalone-never-delete :3001 not healthy (status={st})")
        sys.exit(1)
    print(f"  Xyne backend  :3001 = OK")

    st, _ = _get_json("http://127.0.0.1:8100/v1/models", timeout=5)
    if st != 200:
        print(f"  WARN: Polar gateway :8100 not responding (status={st})")
    else:
        print(f"  Polar gateway :8100 = OK")
    print()

    # --- Optionally reboot xyne-harness-standalone-never-delete with a different model ---
    if model:
        print("[2/3] Rebooting xyne-harness-standalone-never-delete for model switch...")
        reboot_xyne_server(model)
    else:
        print("[2/3] Using existing xyne-harness-standalone-never-delete (no model switch)")
    print()

    # --- Read training prompts ---
    print(f"[3/3] Submitting {num_questions} task(s) to Polar rollout server...\n")
    prompts = []
    with open(TRAIN_DATA) as f:
        for i, line in enumerate(f):
            if i >= num_questions:
                break
            d = json.loads(line)
            md = d.get("metadata", {})
            if isinstance(md, str):
                md = json.loads(md)
            prompts.append({
                "prompt": d["prompt"],
                "label": d.get("label", ""),
                "doc_ids": md.get("doc_ids", []),
                "metadata": md,
            })

    success = 0
    fail = 0
    for i, p in enumerate(prompts):
        task_id = f"test-polar-{i}-{int(time.time())}"
        print(f"--- Question {i+1}/{num_questions} ---")
        print(f"Q: {p['prompt'][:120]}...")
        print(f"Expected: {p['label'][:120]}...")
        print()

        req = build_task_request(
            task_id=task_id,
            prompt=p["prompt"],
            label=p["label"],
            doc_ids=p["doc_ids"],
            metadata=p["metadata"],
        )
        result = submit_and_wait(req)
        if result and result.get("results"):
            for r in result["results"]:
                print_result(r)
                eval_meta = r.get("trajectory", {}).get("metadata", {}).get("evaluation", {})
                score = eval_meta.get("outcome_reward")
                if score is not None and score > 0:
                    success += 1
                else:
                    fail += 1
        else:
            print("  NO RESULTS returned")
            fail += 1
        print()

    print("=" * 55)
    print(f"  RESULTS: {success} nonzero score, {fail} zero/failed")
    print("=" * 55)
    if success > 0:
        print("  Pipeline is WORKING — composite score > 0 achieved.")
    else:
        print("  Pipeline NOT producing rewards yet.")
        print("  Check: LITELLM proxy (:18100) during rollout,")
        print("         xyne_raw in trajectory metadata,")
        print("         rollout server logs at docker exec miles-never-delete ...")
    print()
    print("  Rollout artifacts:")
    print("  ls -t /data/siraj/logs/xyne_grpo/rollouts/task_polar-*/ses_sk-polar-*.json")


if __name__ == "__main__":
    main()
