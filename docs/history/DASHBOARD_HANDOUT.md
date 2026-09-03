# Xyne GRPO Training Observability Dashboard — Handout

Read-only FastAPI (uvicorn) observability dashboard over Polar trajectory dumps
for verl/Polar GRPO training. It **only reads** dump files from the Miles
container filesystem — it never touches live training processes, never writes to
the dump data, and needs no database.

**Current location (container `miles-never-delete`, on RTX1):**
`/data/siraj/ARL/dash/`

**Port:** `8400` (default; overridable via `DASH_PORT`)

**Access:** `ssh -L 8400:127.0.0.1:8400 rtx1` then open http://127.0.0.1:8400 in a browser.

> I (Atlas) run directly as root on the host `rtx-6000-pro-blackwell-1`
> (RTX1), so `docker exec` / `docker cp` into `miles-never-delete` is direct —
> no SSH hop is needed for maintenance.

---

## 1. What it does

The dashboard shows, for a chosen training run, its **rollout index** (list of
rollouts with aggregate reward stats), a **per-trace detail view** (prompt,
answer, thinking, citations, retrieved chunks, tool calls, per-scorer reward
breakdown), and a **group-level reward matrix**.

It is pointed at one `DUMP_ROOT` directory (the live run's `trajectory_dumps`).
New `rollout_*.jsonl.gz` files are picked up **automatically** (self-healing
incremental reindex) — a manual "refresh" is no longer required.

## 2. Architecture & files

```
/data/siraj/ARL/dash/
├── app.py                       # FastAPI app (single file, no external deps beyond FastAPI/uvicorn)
├── templates/
│   ├── index.html               # Rollout index page (list + KPI cards), 60s auto-refresh
│   ├── rollout.html             # Per-rollout detail (KPIs, scorer bars, group matrix, trace table)
│   └── trace.html               # Per-trace deep-dive (thinking, citations, chunks, tool calls, answer)
├── static/                      # (empty) static mount
├── dash.log                     # uvicorn log
├── dash.pid                     # PID of the real :8400 uvicorn listener
├── IMPLEMENTATION_HANDOUT.md    # (handout from the team — do NOT modify)
└── DASHBOARD_HANDOUT.md         # this document
```

Only three files hold the application logic: `app.py` and the three templates.
There are **no new third-party dependencies** beyond FastAPI + uvicorn (both already
present in the image). No auth, no database, no threads/timers.

## 3. Configuration (env vars)

| Env var | Default | Purpose |
|---|---|---|
| `DASH_DUMP_ROOT` | (hardcoded live path, see below) | Root dir containing `rollout_*.jsonl.gz` files |
| `DASH_ROOT` | `/data/siraj/ARL/dash` | App dir (templates + static) |
| `DASH_PORT` | `8400` | uvicorn listen port |

The default `DUMP_ROOT` is baked into `app.py` line ~23. It is repointed to the
**current active training run** whenever the run changes. The env override
(`DASH_DUMP_ROOT`) is used for isolated test instances (e.g. pointing at a
throwaway dir on a different port).

**Current default `DUMP_ROOT` (as of this handout):**
```
/root/miles/tmp/xyne_qa_tp2cp4ep8/sebi-pranav-tp2cp4ep8-lora64-qv-fc1fc2-b32-gbs32-spr8-100k-20260820_141923/trajectory_dumps
```

## 4. In-memory index model

The app loads the gzip dump files into two in-memory structures:

- `ROLLOUT_STATS: dict[int, dict]` — `rollout_id -> {rollout_id, file, trace_count,
  group_count, error_count, reward_mean, reward_std, reward_min, reward_max,
  per_scorer_mean, token_usage}`.
- `TRACE_INDEX: dict[str, dict]` — `session_id -> flattened trace record`.
- `_INDEXED_FILES: dict[str, (mtime_ns, size)]` — bookkeeping so already-scanned
  files are skipped on subsequent passes (incremental indexing).
- `_LAST_INDEX_SIGNATURE` — signature of the dump dir used to trigger a rebuild.

**Automatic reindex (`list_rollouts`):** every `GET /api/rollouts` computes a
signature over `DUMP_ROOT` (sorted `(name, mtime_ns, size)` of all
`rollout_*.jsonl.gz`). If it differs from the last-seen signature, it rebuilds
the index and updates the signature. So when training writes a new (or grows an
existing) rollout file, the dashboard picks it up on the next poll — no manual
refresh.

**Incremental, not full:** `_build_index()` → `_safe_index()` → `_index_file()`
only rescans *new or changed* files (detected by `(mtime_ns, size)`).
Pre-existing files are left in memory. This keeps `GET /api/rollouts` fast
(milliseconds) even when dumps are hundreds of MB, under heavy machine load.

### Trace flattening (`_flatten_trace`)
Each dump JSON record is flattened into the display shape from:
`polar_metadata.trajectory_metadata.evaluation`:
- `per_scorer` → `reward_per_scorer`
- `outcome_reward` / `reward.score` → `reward_total`
- `group_reward` → `reward_group`
- `raw_flow` fields → `answer`, `citations`, `retrieved_chunks`, `tool_calls`,
  `tool_use_blocks`, `tool_result_blocks`, `token_usage`, `thinking`,
  `request_messages`, `latency_ms`, `wall_clock_ms`, `llm_calls`, `error`, etc.

### Scorers
`SCORERS = [llm_judge, embedding_similarity, gold_evidence_coverage,
            citation_evidence_coverage, tool_evidence_utility]`

Display-only scorer weights (frontend, for the scorer bar scaling):
`llm_judge: 3.0, embedding: 2.0, gold: 2.0, citation: 2.0, tool: 1.0`.

## 5. API endpoints

| Method & path | Description |
|---|---|
| `GET /` | Rollout index HTML page |
| `GET /rollout/{id}` | Rollout detail HTML page |
| `GET /trace/{sid}` | Trace deep-dive HTML page |
| `POST /api/refresh` | Rebuild index now; returns `{indexed_traces, rollouts}` |
| `GET /api/rollouts` | `{dump_root, rollouts:[...]}` (triggers auto-reindex) |
| `GET /api/rollout/{id}` | Rollout aggregate stats |
| `GET /api/rollout/{id}/traces?page=&per_page=` | Paged trace list (`total`) |
| `GET /api/trace/{sid}` | Full flattened trace record |
| `GET /api/groups?rollout_id=N` | Group-level reward matrix |

**Notes:**
- Rollout id is parsed from the filename stem: `rollout_000000.jsonl.gz` → id `0`.
- Some runs number files from `000001` (id `1`). If `/rollout/0` 404s but
  `/rollout/1` works, the run simply has no `000000` file — check actual
  filenames in the dump dir.
- `_render()` substitutes **double-brace** tokens: `{{key}}`. A `{{stats_json}}`
  in `rollout.html` becomes `const STATS = {...};`. Do not use triple braces.
- 404s on `/rollout/{id}` / `/api/rollout/{id}` with an *empty or fresh* run are
  correct behavior, not a bug.

## 6. Deployment / restart procedure

Backup → copy files in → kill → relaunch detached → fix `dash.pid`.

**1. Backup current files** (always, before editing):
```bash
docker exec miles-never-delete bash -c \
  'mkdir -p /data/siraj/ARL/dash/.bak-$(date +%Y%m%dT%H%M%S) && \
   cp /data/siraj/ARL/dash/app.py /data/siraj/ARL/dash/templates/{index,rollout,trace}.html \
      /data/siraj/ARL/dash/.bak-$(date +%Y%m%dT%H%M%S)/'
```

**2. Copy edited files into the container** (from host):
```bash
docker cp /tmp/opencode/app.py miles-never-delete:/data/siraj/ARL/dash/app.py
docker cp /tmp/opencode/index.html miles-never-delete:/data/siraj/ARL/dash/templates/index.html
docker cp /tmp/opencode/rollout.html miles-never-delete:/data/siraj/ARL/dash/templates/rollout.html
docker cp /tmp/opencode/trace.html  miles-never-delete:/data/siraj/ARL/dash/templates/trace.html
```

**3. Sanity-check syntax before restart:**
```bash
docker exec miles-never-delete bash -c 'python3 -m py_compile /data/siraj/ARL/dash/app.py && echo OK'
```

**4. Kill the old listener and relaunch detached:**
```bash
docker exec miles-never-delete bash -c \
 'kill $(cat /data/siraj/ARL/dash/dash.pid) 2>/dev/null; pkill -f "python3 app.py" 2>/dev/null; sleep 1'

docker exec -d miles-never-delete bash -c \
 'cd /data/siraj/ARL/dash && nohup python3 app.py > dash.log 2>&1 & echo $! > dash.pid'
```

**5. Fix `dash.pid` to the REAL uvicorn PID** (critical gotcha: the handout
`echo $!` writes the *wrapper bash* PID, not the app):
```bash
docker exec miles-never-delete bash -c \
 'netstat -ltnp | grep :8400'          # note the python3 PID
docker exec miles-never-delete bash -c 'echo <REAL_PID> > /data/siraj/ARL/dash/dash.pid'
```

**6. Verify:**
```bash
docker exec miles-never-delete bash -c \
 'curl -s http://127.0.0.1:8400/api/rollouts; echo; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8400/'
```

## 7. Pointing at a different (new) dump / run

The standard "repoint" operation (matches the active producing run):

1. Find the active run's dump dir from the live training process:
   ```bash
   docker exec miles-never-delete bash -c \
    'for p in $(ps -eo pid,args | grep -iE "RolloutManager|ray::Rollout" | grep -v grep | awk "{print \$1}"); do
       tr "\0" "\n" < /proc/$p/environ | grep MILES_POLAR_TRAJECTORY_DUMP_DIR; done'
   ```
   (or read `MILES_POLAR_TRAJECTORY_DUMP_DIR` from the `train.py` / rollout-actor
   process env, or the `train.py --load ...`/`--custom-config-path ...` arg).
2. Edit `app.py` line ~23 so `DUMP_ROOT` points at that `.../trajectory_dumps`.
3. Restart per §6. The auto-reindex will pick up dumps as they land.

> Rule: repoint **to match the live producing run's dump dir**. Don't guess from
> dir mtime alone — verify against the process env. Many run dirs are created
> empty per attempt; only the one that accumulates `rollout_*.jsonl.gz` and
> matches the active `train.py` is the real current one.

## 8. Templates (formatting rules — keep when editing)

- **Dark theme:** `--bg #0b0e13`, accent `#6ea8fe`, good `#4ade80`, warn
  `#fbbf24`, bad `#f87171`.
- `index.html`: KPI cards + rollout table; 60s `setInterval` auto-refresh.
- `rollout.html` trace table has **16 columns**; empty-state row `colspan=16`.
  Header uses one `Cit` (scorer) and one `Cits` (citation-count column) — keep
  them distinct.
- `trace.html`: keep the used sections — `thinkingHtml`, `citHtml` (Citations),
  `chunksHtml` (Retrieved Chunks → `chunkCard`), `toolCallCard`. Do **not**
  remove `citHtml`/`chunksHtml`; they are referenced in the inline
  `$('#root').innerHTML` template. `fmt.n(v,d)` returns `—` for null/undefined.

## 9. Known constraints / gotchas

- **`—` (em-dash) values** on a trace (Base Reward / Efficiency / Group Reward):
  means that run's data had no `group_reward` key for that trace (data-side,
  run-specific). Newer runs that write `group_reward` show real values.
- **Per-scorer `0.000`** can be a genuine zero (e.g. 0 citations ⇒
  `citation_evidence_coverage 0.0`), not missing data.
- **`/api/groups` may be empty** (`{}`) for runs where traces have `group_id:
  None` — historical/half-done runs may not populate group ids.
- **Rollout id numbering** can start at `000000` or `000001`; check filename.
- **LLM judge I/O logs**: the code has a per-dimension judge input/output logger
  (`$POLAR_JUDGE_DUMP_DIR/llm_judge_io.jsonl`) gated behind `POLAR_JUDGE_DUMP_DIR`,
  which is **not set** on the current run. The dump stores only the scalar
  composite `llm_judge`. To surface full judge input/output in the UI, the
  logging env var must be enabled (and judge records need a session/trace id).
  (Under discussion — do not rely on it yet.)
- **Under heavy training load** the machine can be very busy (loadavg 15+). The
  incremental index keeps `/api/rollouts` fast; the initial cold-start index of
  many/large files is the only slow part (can take ~20s on first boot).

## 10. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `/rollout/0` 404 | Run numbers files from `000001`, or fresh run with no data yet (correct) |
| Stuck "loading…" | Was a slow full reindex; now fixed by incremental indexing. If it recurs, check `dash.log` and disk/load |
| `/api/rollouts` empty (`rollouts: []`) | Fresh run; first dump lands ~2h in. Auto-reindex will populate it |
| Wrong data / old run shown | `DUMP_ROOT` not repointed to the active run (see §7) |
| Port 8400 not reachable | Dashboard down; check `dash.pid`, restart per §6 |
| Need a throwaway test | Boot isolated: `DASH_PORT=8401 DASH_DUMP_ROOT=/tmp/test ... python3 app.py`; kill via `netstat -ltnp | grep 8401` |

---

*Maintained by the ARL dashboard automation. Current default DUMP_ROOT: the
`20260820_141923` lora64 run. Dashboard live on :8400.*


---

## Dashboard v4 update — v21 dump alignment (2026-09-01)

**Deployment file:** `/data/siraj/ARL/dash/app.py` (local source: `xyne_dash/app_v4.py`)

**What changed**

- Parses `group_rewards/group_*.jsonl` first, so the overview is available without waiting for the larger rollout `.gz` files.
- Reads the v21 `reward_components` array and exposes these actual per-session fields:
  `shared_answer`, `mi_reward`, `gate`, `llm_judge`, `citation_accuracy`,
  `citation_relevance`, `citation_presence`, `gold_evidence_coverage`,
  `token_efficiency`, and `final_reward`.
- Reads `source_metadata` from each sample and stores the gold answer,
  gold `doc_ids`, and gold `chunk_ids` per group/slot.
- Extracts the real question from `judge_io` (fast path) and from
  `prompt_messages[1]` in rollout `.gz` (full path).
- The trace page now shows:
  - question + gold answer + gold doc/chunk IDs
  - reward components
  - group reward audit
  - generated answer
  - compact tool-call list
  - compact citation list
  - LLM judge IO (dimension, model, score, output)

**New/updated API endpoints**

- `GET /api/component_stats` — mean/std/count for every actual v21 reward component.
- `GET /api/group/{group_index}` — one group's slots, gold data, and reward components.
- `GET /api/group/{group_index}/components` — deduplicated per-session reward components for one group.
- `GET /api/groups?summary=true` — now includes `question_preview` and `gold_preview`.
- `GET /api/trace/{session_id}` — now includes question, gold answer, docs/chunks, answer,
  tool calls, citations, token usage, judge IO, and reward components.

**New UI pages**

- `/group/{group_index}` — group detail page with:
  - gold questions and answers
  - gold doc/chunk IDs
  - slot reward matrix
  - per-session reward components
- `/trace/{session_id}` — enriched trace page with question/gold, reward components,
  generated answer, tools, citations, and judge IO.
- `/` — overview now includes actual reward-component means and a group explorer with
  question and gold-answer previews.

**Why this matters**

The v21 dumps are not just aggregate rewards. They contain the exact per-session
component breakdown, the gold evidence used for scoring, and the LLM judge IO.
Dashboard v4 surfaces those directly instead of reconstructing them from older
scorer names.


---

## Dashboard v4 operational insights update

The overview page now includes a **Group Insights — Tools / Turns / Evidence** table. Each row is one group and shows:

- gz coverage (`indexed sessions / total sessions`)
- total tool calls
- total tool turns
- total citations
- distinct queries
- distinct cited docs
- distinct cited chunks
- total answer characters
- total input + output tokens
- total wall time

The group page now includes a **Session Insights** table with the same operational metrics per session, plus a gz availability indicator. These metrics are computed from the rollout gz index; groups or sessions whose gz files have not yet been indexed show partial or zero values rather than fabricated data.
# Dashboard v4 update — final-answer semantics (2026-09-02)

**Deployment file:** `/data/siraj/ARL/dash/app.py`
**Local source:** `/Users/shaik.s/Documents/MTronLM/xyne_dash/app_v4.py`
**Backup:** `/data/siraj/ARL/dash/app.py.bak-20260902T123500`

## What the dump actually contains

- `thinking_delta` is a **live Xyne stream event**, not a persisted dump field.
  The v30 dump has zero literal `thinking_delta` records.
- `raw_flow.thinking` is empty in this run. The model's intermediate reasoning
  is persisted as ordinary assistant `kind: "text"` blocks.
- `raw_flow.answer` is the **joined text of every committed main-run assistant
  text block**. It is the user-visible response/transcript, but it is not a
  clean final-answer field.
- The final LLM event carries `stopReason`. A clean final answer can only be
  inferred from the last assistant text block when that terminal reason is
  `stop`.

## Dashboard rule

The dashboard now keeps three concepts separate:

| Field | Meaning | Extraction |
|---|---|---|
| `final_answer` | Clean final answer, if one exists | Last assistant text block, only when terminal `stopReason == "stop"` |
| `user_visible_answer` | Everything Xyne committed as visible assistant text | `raw_flow.answer` (all committed text blocks), capped at 50,000 chars in the API |
| `reasoning` | Pre-final text blocks | Text blocks before the final block when a final answer exists |

If the terminal reason is `length`, `error`, or `toolUse`, the UI shows
**“No final answer”** with that terminal reason. It no longer labels the last
truncated/evidence-heavy text block as the final answer.

## Current v30 validation

After a full cold index of the pinned v30 run:

| Terminal stop | Sessions |
|---|---:|
| `stop` | 269 |
| `length` | 101 |
| `error` | 110 |
| `toolUse` | 32 |

- Indexed sessions: **512/512**
- Clean final answers available: **269**
- Final answers missing: **243**
- Average user-visible response length: **30,024 chars** (API-capped at 50,000)

Example verified trace:

```text
session_id: sk-polar-5128171f-e030-4c9d-95d1-29049a9b376d
terminal_stop_reason: length
has_final_answer: false
final_answer_chars: 0
user_visible_chars: 50000 (API cap)
user_visible_answer_source: raw_flow.answer (all committed text blocks)
```

The last text block in that trace is 33,845 characters of continuing evidence
analysis and ends in the middle of a `<chunk>`; it is not a final answer.
# Dashboard v4 update — v32 live run + v30 P-history (2026-09-02)

**Live run:**
`/root/miles/tmp/xyne_qa_tp2cp4ep8/sebi-pranav-tp2cp4ep8-lora128-qv-fc1fc2-b32-gbs64-spr16-80k-e3-v32-v30base-8h-16k-runid-20260902_085112/trajectory_dumps`

**Attached history:**
`/root/miles/tmp/xyne_qa_tp2cp4ep8/sebi-pranav-tp2cp4ep8-lora128-qv-fc1fc2-b32-gbs64-spr16-100k-e3-v30-pgroupfix-runid-20260901_185244/trajectory_dumps`

## History attachment

The v30 dump is attached with symlinks, not copied byte-for-byte:

| Type | Live v32 name | Historical v30 name |
|---|---|---|
| Reward group | `group_rewards/group_000001.jsonl` | `group_rewards/pgroup_000000.jsonl` … `pgroup_000063.jsonl` |
| Trajectory gz | `rollout_000000_group_000.jsonl.gz` | `prollout_000000_group_000.jsonl.gz` … `prollout_000001_group_031.jsonl.gz` |

The dashboard maps historical `P0…P63` to internal negative IDs so they cannot collide
with future live v32 group IDs. The friendly URL is `/group/p0` through `/group/p63`;
live groups continue to use `/group/1`, `/group/2`, etc. and display as `G0…`.
The exact source/target map is stored in the live dump folder as `HISTORY_LINKS.json`.

At validation:

| Scope | Groups | Rollout samples | Mean raw reward |
|---|---:|---:|---:|
| v30 history (`P`) | 64 | 512 | 0.5232 |
| v32 live (`G`) | 16 | 128 | 0.4408 |
| Combined | 80 | 640 | 0.5136 |

## Separate reasoning in v32

The v32 dumps have a real separate reasoning channel:

- `raw_flow.thinking` is nonempty.
- `raw_dump.messages[].blocks[]` contains `kind: "thinking"` blocks.
- Final/user-visible text remains in `kind: "text"` blocks.

The dashboard now maps:

| Concept | Source |
|---|---|
| Final answer | Last `kind: "text"` block only when terminal `stopReason == "stop"` |
| User-visible response | `raw_flow.answer`, all committed visible text |
| Reasoning | Separate `kind: "thinking"` blocks when present; legacy v30 falls back to pre-final text blocks |

At validation, all 128 indexed v32 sessions had separate reasoning. The v30 history
uses the legacy fallback because that run did not persist separate thinking blocks.
# Final-answer Markdown view (2026-09-02)

The group rollout cards and trace page now render terminal final answers as
Markdown by default. A collapsible **Raw markdown** section remains below the
rendered answer for debugging.

Supported Markdown includes:

- headings
- bullet and numbered lists
- bold and italic
- inline and fenced code
- block quotes
- horizontal rules
- tables
- real HTTPS/HTTP Markdown links

Safety and citation behavior:

- All text is HTML-escaped before Markdown inline formatting is applied.
- `<script>` and other HTML is displayed as text, not executed.
- Citation tokens such as `[docId#chunk]` remain plain text because they do not
  have a Markdown URL target.
- Only real Markdown links using `[text](http://…)` or `[text](https://…)`
  become clickable, and they open in a new tab with `rel="noopener noreferrer"`.
# Dashboard v33 update — moved P history and judge output (2026-09-02)

**Live run:**
`/root/miles/tmp/xyne_qa_tp2cp4ep8/sebi-pranav-tp2cp4ep8-lora128-qv-fc1fc2-b32-gbs64-spr16-80k-e3-v33-v30base-8h-60k-runid-20260902_125103/trajectory_dumps`

The `P0…P63` v30 history links were moved from the v32 dump folder into this
v33 dump folder. The exact moved-link map is:

`.../e3-v33-v30base-8h-60k-runid-20260902_125103/trajectory_dumps/HISTORY_LINKS.json`

Live v33 group IDs remain untouched and continue to display as `G0…`.

## Judge IO

The v33 dumps persist per-trace `judge_io.llm_judge` with these dimensions:

- `quality`
- `correctness`
- `groundedness`
- `citation_accuracy`

Each dimension contains:

- parsed `score`
- `output.content` — the short judge output and final `Score:` line
- `output.reasoning_content` — the judge’s full reasoning
- input model, endpoint, prompt messages, generated answer, cited snippets,
  and ground-truth answer

The dashboard now shows, per rollout and trace:

- judge dimension and score
- judge output
- collapsible judge reasoning
- collapsible judge input

If a top-level score is absent, the dashboard parses it from the final
`Score: <0.0|0.5|1.0>` line in `output.content`.

## Trace reward table and continuous gz indexing (2026-09-02)

The single-trace **Reward Components** section is now a plain table with
`Component`, `Scope`, `Weight`, and `Value`. It deliberately avoids component bars
and score pills on the trace page. A value shown as `not emitted` means that the
session-level `reward_components` JSONL record did not contain that component key;
it is not treated as an indexing failure.

The gz indexer now runs continuously and scans both live and historical gzip files
every five seconds. It skips unchanged files by `(mtime_ns, size)` and rescans files
that grow or change. This keeps newly completed groups visible without a dashboard
restart. Current validation after the fix: 832/832 samples indexed across 64
historical and 40 live groups.

## Stable group ordering (2026-09-02)

Live `G` display IDs are now assigned from the sorted set of live source group IDs,
so they no longer depend on gzip/group-file insertion order. The group matrix is
sorted newest → oldest: live v33 groups first, then v30 `P` history. Within each
scope, higher source group IDs appear first.
