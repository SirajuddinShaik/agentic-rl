# HANDOFF — Xyne Full-Flow Capture (+ current blocker: tool_calls=0)

> Purpose: give a fresh agent (or human) everything needed to continue this exact job
> without re-discovering it. Written so you can just pick up where this left off.

---

## 1. PROBLEM STATEMENT

We are training **Nemotron-3-Nano-30B-A3B** with **GRPO** (via Miles/Polar). The reward is a
composite Xyne Q&A evaluator (`XyneCompositeEvaluator`).

To compute that reward we need a helper that, for each agent turn, returns **the full agentic
flow** as a single structured object — everything that happened during the turn:

- the final **answer**,
- every **tool call** (name, args, result, status, error),
- all **citations** (RAG doc references),
- all **sub-agent runs** (each with their own messages / tool calls),
- all **thinking** text,
- full **messages** and **runs** arrays,
- **token usage** stats.

**Why it matters:** the old helper only captured a fraction of the turn because it polled an
endpoint that **hides sub-agent messages**, and it never called the one endpoint that returns the
complete turn.

**The fix:** the Xyne backend already exposes `GET /v2/chat/conversations/:id/dump`, which returns
the *entire* turn — every message with embedded blocks (text, thinking, tool_use, tool_result,
citations), every run (including nested sub-agent runs), and every tool call — in a single response.
We just call it after the turn completes and extract into one unified dict.

### Scope guardrails (MUST NOT)
- **NEVER edit anything under `/data/siraj/xyne_s/xyne-search/`** (backend repo is READ-ONLY).
- Do NOT subscribe to the SSE `/stream` endpoint (redundant — `/dump` gives the same data).
- Do NOT call `GET /v2/kb/files/resolve/:docId` (N+1 call, not needed for training data).
- Do NOT add fields that don't exist in the backend data model.
- Do NOT commit to git (user: "never commit").

---

## 2. WHAT HAS BEEN DONE (completed, verified)

### 2.1 Root cause found
`/data/siraj/test_without_polar.sh` **lines 123–135** only print 6 fields
(`conversation_id`, `run_id`, `error`, `latency_ms`, `answer_len`, `answer_preview`).
The patched helper writes the **full** unified dict to the JSON output file, but the display code
**never reads/prints** the rich fields (`tool_calls`, `citations`, `sub_agents`, `token_usage`,
`messages`, `runs`, `thinking`). This is why the user could never see the tool-call / citation /
session counts in the test output.

### 2.2 Code written (2 files, byte-identical)
Patched the helper to fetch `/dump` and build a unified result object:

| File | Status |
|---|---|
| `/data/siraj/ARL/miles/polar-pkg/polar/xyne/xyne_fetch_flow.py` | ✅ patched (517 lines) |
| `/data/siraj/ARL/ProRL-Agent-Server/src/polar/xyne/xyne_fetch_flow.py` | ✅ identical copy |

New/changed logic:
- `_fetch_dump(conversation_id)` — calls `GET /v2/chat/conversations/{id}/dump`.
- `_build_unified_result(dump, debug_events, nested_runs)` — extracts: **answer, citations,
  tool_calls, tool_use_blocks, tool_result_blocks, sub_agents, thinking, messages, runs,
  token_usage** (plus debug_events, nested_runs as supplements).
- Fixed a bug: skips nested-run assistant messages via `nested_run_ids` (prevents a sub-agent's
  message from becoming the final answer / token_usage).
- Removed dead `llm_calls` / `finish_reason` fields.

Credentials for live runs (needed): JWT token is hardcoded as `XYNE_ACCESS_TOKEN` in
`test_without_polar.sh` **line 30** and in `agent.env` **line 14**. grid.ai key `JUSPAY_API_KEY`.

### 2.3 Test evidence (stored)
- `.omo/evidence/task-3-xyne-full-flow-capture.json` — full captured object (19–20 keys).
- `.omo/evidence/task-3-xyne-full-flow-capture.txt` — human-readable summary.
- Plan: `.omo/plans/xyne-full-flow-capture.md` (all checkboxes `- [x]`).
- Notepad: `.omo/notepads/xyne-full-flow-capture/learnings.md`.

### 2.4 Verification status
- Final Verification Wave **F1–F4: ALL APPROVE**.
- Helper **proven correct** for non-empty data via a synthetic rich-dump unit test (Todo 1):
  citations dedup, tool_calls mapping, sub_agents tree, token_usage all extracted correctly.

---

## 3. THE CURRENT BLOCKER — `tool_calls = 0` in live tests

**The honest, verified finding:**

The live test **returned `tool_calls = 0`** (along with `tool_use_blocks=0`, `tool_result_blocks=0`,
`citations=0`, `sub_agents=0`).

**Why (independently verified via `curl` to the live `/dump` endpoint):**

The persistent harness backend `xyne-harness-standalone-never-delete` is running **without a real
tool-execution backend** (`VESPA_REQUIRED=false`, no real search/tool wiring). Its `/dump` returns:
```
toolCalls: []                         ← empty from the backend itself
assistant block_kinds: ['thinking','text','follow_ups']   ← no tool_use/tool_result blocks
```
Tool invocations appear only as **inline prose in the answer text** — never as structured
`toolCall`s. The helper correctly extracts whatever `/dump` contains (which is empty for this config).

**Conclusion:** This is a **backend/config limitation of the harness**, **NOT a helper bug**.
The extraction logic for non-empty tool calls is proven correct.

### If you need a real non-zero tool-call count, you have 3 options:
1. **Wire the harness with a real tool-execution backend** (e.g. `VESPA_REQUIRED=true` + real
   Vespa/search + a configured tool) so the agent actually generates tool calls. This is a
   backend/harness config change — out of scope of the helper and **in the READ-ONLY backend repo**.
2. **Use a model that emits structured tool calls.** Note: `glm-latest` / `kimi` emit tool calls as
   RAW protocol DSL text (e.g. `<|open|>tools<|sep|>... call tool="vespaSearch" index="1"...`)
   with `stopReason="stop"`, NOT structured `toolCall` blocks with `stopReason="toolUse"`. The
   rag-agent loop therefore never runs tools → `toolCalls:[]`. This is documented backend behavior.
3. **Fix the display** in `test_without_polar.sh` so it prints `len(tool_calls)`,
   `len(citations)`, `len(sub_agents)`, `len(messages)`, `len(runs)`, `token_usage` — so the user
   can actually SEE what the helper captured (the script currently hides all of it).

---

## 4. RECOMMENDED NEXT STEPS (for the new executor)

1. **Patch `test_without_polar.sh`** (lines 123–135) to print the full field list:
   ```python
   print(f'tool_calls:     {len(d.get("tool_calls", []))}')
   print(f'citations:      {len(d.get("citations", []))}')
   print(f'tool_use_blocks:{len(d.get("tool_use_blocks", []))}')
   print(f'tool_result_blocks:{len(d.get("tool_result_blocks", []))}')
   print(f'sub_agents:     {len(d.get("sub_agents", []))}')
   print(f'messages:       {len(d.get("messages", []))}')
   print(f'runs:           {len(d.get("runs", []))}')
   print(f'token_usage:    {d.get("token_usage")}')
   print(f'session/conversation_id: {d.get("conversation_id")}')
   ```
   (Ask the user first before editing per the standing rule "tell user before code changes".)
2. **Re-run a single live question** and print the FULL unified dict so the user visibly sees what
   is captured vs empty. Note the current backend was rebooted with `glm-latest` (needs `JUSPAY_API_KEY`).
3. If a **real** tool-call count is needed, wire an actual tool-execution backend (backend config
   change — the helper cannot invent calls the backend never stored).

---

## 5. KEY PATHS / COMMANDS

- Helper (source): `/data/siraj/ARL/miles/polar-pkg/polar/xyne/xyne_fetch_flow.py`
- Helper (ProRL copy): `/data/siraj/ARL/ProRL-Agent-Server/src/polar/xyne/xyne_fetch_flow.py`
- Test script: `/data/siraj/test_without_polar.sh`  (usage: `bash test_without_polar.sh [N] [MODEL]`)
- Train data: `/data/siraj/xyne_s/xyne_qa_train.jsonl`
- Backend container: `xyne-harness-standalone-never-delete` on `:3001`
- **Backend repo (READ-ONLY):** `/data/siraj/xyne_s/xyne-search/`
- `/dump` endpoint: `GET http://localhost:3001/v2/chat/conversations/{conv_id}/dump` (Bearer token)

Verify identical copies:
```bash
diff /data/siraj/ARL/miles/polar-pkg/polar/xyne/xyne_fetch_flow.py \
     /data/siraj/ARL/ProRL-Agent-Server/src/polar/xyne/xyne_fetch_flow.py && echo IDENTICAL
```

---

## 6. STANDING RULES
- **Never commit to git.**
- **Never edit `/data/siraj/xyne_s/xyne-search/`** (read-only backend).
- **Tell the user before any code change.**
- Make a real tool call with every response (user explicitly frustrated by narration-only replies).
- Harness-first before trainer relaunch.
