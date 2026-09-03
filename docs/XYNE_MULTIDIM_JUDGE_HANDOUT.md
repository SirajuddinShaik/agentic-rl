# Xyne Multi-Dimensional LLM Judge Reward — Handout

> Status: **PLAN COMPLETE (9/9 + F1–F4 APPROVE)** + **discrete {0, 0.5, 1} scoring DONE & VERIFIED**
> Session elapsed: 1h 7m 2s
> Generated: 2026-08-13

This handout captures the `xyne-multidim-judge-reward` work: the four-dimensional judge, its wiring, real-grid findings, normalized Xyne telemetry, and the verification commands.

---

## 1. What this plan built

A 4-dimension LLM **judge scorer** used inside the Xyne/Polar GRPO reward pipeline. Instead of a single scalar LLM reward, the judge scores each rollout on four independent axes:

| Dimension | What it measures |
|---|---|
| `quality` | Overall helpfulness / fluency of the assistant answer |
| `correctness` | Factual / logical correctness of the answer |
| `groundedness` | Whether the answer stays grounded in retrieved context |
| `citation_accuracy` | Whether citations actually support / are used correctly |

Each dimension returns one of **`0.0`, `0.5`, or `1.0`**, parsed from the final `Score:` line and quantized defensively. The composite remains a weighted average of the four discrete dimensions.

### Files modified (all verified; full suite now 159 passed / 0 failed)
- `src/polar/xyne/scorers/llm_judge.py` — the 4-dim async judge scorer.
- `src/polar/xyne/evaluator.py` — forwards judge dimension / `max_concurrency` / `enable_*` config keys.
- `src/polar/xyne/types.py` — first-class `tool_events` and `retrieved_chunks` fields.
- `tests/xyne/test_scorers.py` + `tests/xyne/test_harness.py` — judge calibration and dump-shape regression tests.
- `src/polar/xyne/xyne_fetch_flow.py` — terminal-run polling, citation enrichment, tool-result synthesis, and retrieval normalization.
- **Mirrors (must stay byte-identical):** the Miles copies of `types.py`, `xyne_fetch_flow.py`, and `scorers/llm_judge.py`.

### Key fixes baked in along the way
- **Cross-loop deadlock bug**: the scorer's semaphore was reused across sync-bridge invocations that run in different event loops → crash. Fixed with a **per-invocation** semaphore, default concurrency 20, and a regression test (`test_llm_judge_scorer_reuse_across_sync_bridge_no_deadlock`).
- **`max_tokens` 512 → 4096**: the judge (`glm-flash-experimental`) emits long `reasoning_content` (CoT) before `content`. At 512/2048 tokens the CoT got truncated mid-prompt → the model produced an empty / degenerate reply and every dimension collapsed to `0.0`. At **4096** with `finish=stop` it returns a real `Score: 1.0`.
- **Timeout 30 → 60s** for harness mock poll endpoints; harness-match fix (caller polled the wrong endpoint shape vs mock's 404).
- **Prompt fixes**: trailing discrete `Score:` on the **last line**; `_SCORE_LABEL_RE` parse; `_render_citations` now includes `[docId#chunk]` plus recovered source text.
- **Telemetry fix**: normalized `tool_events` preserve calls and results even when message-level result blocks are absent; `retrieved_chunks` extracts document IDs, chunk indices, titles, relevance, and source text from search/getChunks results. Answer citations remain separate from retrieved evidence.

---

## 2. Real-grid judge details (what was actually tested)

Creds are **environment-only** — never hardcode or log them.

- **API key**: `JUSPAY_API_KEY` (exported in shell; NOTE — `/data/siraj/.env` holds a *different* key, use the shell one for these runs).
- **Base URL**: `https://grid.ai.juspay.net` (auth check `200` on `/v1/models`; `/chat/completions` works **without** the `/v1` prefix).
- **Model**: `glm-flash-experimental` — CoT-emitting, stochastic; can emit ~2000+ tokens of `reasoning_content` before the actual `content`.
- **Concurrency default**: `DEFAULT_MAX_CONCURRENCY = 20`.
- **Max tokens default**: `DEFAULT_MAX_TOKENS = 4096`.

### Live results observed before telemetry enrichment
- `quality = 1.0`, `correctness = 1.0` on all live passes. ✅
- `groundedness = 0.0`, `citation_accuracy = 0.0` — the pre-fix live run rendered blank citation text because only `docId/chunk` were passed to the judge.

---

## 3. ✅ DONE & VERIFIED — discrete {0, 0.5, 1} scoring

You asked to change the judge from arbitrary floats to **discrete scores**: *"give it like 1, 0, 0.5" / "if good add" / "for partial"* — i.e. output restricted to `{0.0, 0.5, 1.0}` per dimension. **This is now implemented and verified.**

### What was implemented
1. **Prompt** (`_JUDGE_SYSTEM_PROMPT` + `DEFAULT_PROMPT_TEMPLATE`): the judge is now told to return the score as one of **exactly** `0.0`, `0.5`, `1.0` (`0.0 = bad, 0.5 = partial, 1.0 = good`), format `Score: <0.0, 0.5, or 1.0>`, still as the very last line.
2. **Quantization guard** — new `_quantize(value)`:
   ```python
   def _quantize(value: float) -> float:
       clamped = min(1.0, max(0.0, value))
       return round(clamped * 2) / 2.0   # -> {0.0, 0.5, 1.0} (round-half-even, deterministic)
   ```
   Wired into **all three** `_extract_score` return paths (labeled score, bare-number fallback, `_NUMBER_RE`), plus `_score_dimension`'s final step — so a stray `0.75`/`0.3`/`1.3` can never leak through.
3. **Composite is NOT quantized** — it stays the weighted average of the discrete per-dim scores.
4. **Mirror** `ARL/miles/polar-pkg/.../llm_judge.py` synced — verified **byte-identical** (`cmp -s` → `MIRROR_IDENTICAL`).

### Tests updated
- `tests/xyne/test_scorers.py`: `_quantize` + `_extract_score` quantization cases (1.3→1.0, -0.2→0.0, 0.75→1.0, 0.3→0.5, 0.25→0.0, 0.6→0.5, 0.5→0.5); prompt-wording assertions updated to the discrete text.
- Stale continuous assertions fixed: `test_e2e_xyne.py:278` `0.8 → 1.0`; `test_evaluator.py:254` `0.7 → 0.5`.

### Verification result (orchestrator ran it)
```
cd /data/siraj/ARL/ProRL-Agent-Server && .venv/bin/python -m pytest tests/xyne/ -q
159 passed, 0 failed
```

> The quantization guard means even if the model returns a float it will be snapped, so grading stays coarsely {bad, partial, good} — clean quantized training signal for RL.

---

## 4. Resolved — groundedness / citation data shape

The old path read citations from live dumps / fixtures as:

```json
{"docId": "...", "chunk": 1234}   // integer chunk index ONLY — no text
```

The source text existed in `<search_results>` / `<chunks>` tool results but was not connected to the citation object, so the judge had no text to verify a citation against.

The implemented fix:

- parse retrieval markup locally at capture time;
- emit `retrieved_chunks` with `docId`, `chunk`, and source text;
- enrich matching answer citations;
- render both the identifier and evidence in the judge prompt;
- keep retrieval evidence separate so a retrieved-but-uncited chunk does not falsely satisfy citation-presence scoring.

---

## 5. TEST COMMAND — run to confirm the discrete changes

### A. Full unit suite (fast, no API key needed — uses `MockTransport`) — ✅ GREEN (159 passed)
```bash
cd /data/siraj/ARL/ProRL-Agent-Server && .venv/bin/python -m pytest tests/xyne/ -q
```
Expect: **159 passed, 0 failed**.

### B. Live-grid judge smoke (real API, exports the key) — run in YOUR shell
```bash
export JUSPAY_API_KEY="<shell key>"
cd /data/siraj/ARL/ProRL-Agent-Server && .venv/bin/python - <<'PY'
import asyncio, os
from polar.xyne.scorers.llm_judge import LLMJudgeScorer, _quantize

# 1) pure quantization sanity (no network)
for v in [1.3, -0.2, 0.75, 0.3, 0.25, 0.6, 0.5, 1.0, 0.0]:
    print(f"_quantize({v}) ->", _quantize(v))

# 2) live judge call
from polar.xyne.types import XyneRawFlow
async def main():
    s = LLMJudgeScorer(config={
        "judge_base_url": "https://grid.ai.juspay.net",
        "judge_api_key": os.environ["JUSPAY_API_KEY"],
        "judge_model": "glm-flash-experimental",
        "max_tokens": 4096,
        "max_concurrency": 20,
    })
    flow = XyneRawFlow(
        request_messages=[{"role": "user", "content": "List 3 trading venues"}],
        answer="1) NSE 2) BSE 3) MCX",
        citations=[],
        metadata={},
    )
    print("composite:", await s.score_async(flow))
asyncio.run(main())
PY
```
Expect per-dim `Score` values (and the composite) to all be in **{0.0, 0.5, 1.0}** — no `0.25`, `0.75`, `0.33`, etc.

> Heuristic sanity check: output must contain only `0.0`, `0.5`, or `1.0` for every dimension.
> `grep -oE 'Score: [0-9.]+'` → every value in the set.

Fresh authenticated live-grid smoke after the telemetry patch:

```text
model=glm-flash-experimental
quality=1.0 correctness=1.0 groundedness=1.0 citation_accuracy=1.0
composite=1.0 all_discrete=True elapsed=19.1s
```

The live judge path is now verified. The smoke used a small grounded flow and did not persist the API key.

---

## 5b. Why a discrete scale matters for RL

A per-timestep / per-rollout reward that snaps to {0, 0.5, 1} is far more stable and interpretable for GRPO than a noisy continuous float — the judge is stochastic at `temp 0.0`, and quantization prevents a tiny CoT jitter from swinging the reward. (For the most stable training signal, an aggregation / majority vote across a few judge passes remains recommended downstream.)

---

## Standing guardrails (recap)
- **Never commit** anything.
- `xyne_s/xyne-search` is **READ-ONLY** — never edit.
- **Never restart** these containers: `miles-never-delete`, `xyne-harness-standalone-never-delete`, `siraj-xyne-db`, `siraj-vespa`, `polar_dbg_run`.
- Repo python: `/data/siraj/ARL/ProRL-Agent-Server/.venv/bin/python`.
- Pre-existing uncommitted worktree changes (types.py, harness.py, gateway/*, etc.) predate this plan — don't attribute them to this work.
