# Xyne/Polar RL Reward Blocker

## Executive summary

The Xyne reward evaluator and its scorers are finished, tested, and working correctly. When fed a real captured success trajectory, they produce sound scores, and the weighted reward comes out to 0.938. That is the good news.

The bad news is that none of that working code has ever run in the live deployment. Every live training session fails at the very first step, before the harness runs at all, because the running Polar gateway cannot import its own runtime. The gateway has no `local.py` in its `polar.runtime` package, but the active trainer template asks for exactly `polar.runtime.local:LocalRuntime`. This import error happens deterministically on every session. Across 2,000 saved task results, zero trajectories have a trace and zero rewards have ever been produced. Two fix options exist, both of which touch a shared live service, so a human must choose before any work proceeds. No fix has been applied.

---

## What works: the reward computation on real data

The Xyne evaluator and its scorers are fixed and verified inside the `miles-never-delete` container. Running the evaluator against the real captured success dump at `tests/xyne/fixtures/success_with_tools.json` yields:

- completion: **1.000**
- answer_format: **1.000**
- retrieval_quality: **0.500**
- tool_call_efficiency: **1.000**
- token_efficiency: **1.000**
- subagent_success: **1.000**

The weighted reward, using the `polar_config` weights (completion 1.0, answer_format 0.5, retrieval_quality 0.5, tool_call 1.0, token 1.0), comes to **0.938**.

The evaluator also behaves correctly on the failure case. The `error_dump` fixture yields **0.0**, with completion 0.0 and answer_format 0.0.

The full in-container test suite passes: **130 passed**, with 2 pre-existing failures that belong to the harness tests, not the evaluator.

---

## What is broken: the live Polar to harness to reward loop

To prove the live path, an integration test was run end to end. One real prompt from `/data/siraj/xyne_s/xyne_qa_train.jsonl` was rendered and submitted via:

```
POST http://127.0.0.1:8080/rollout/task/submit
```

The server returned **200**, with `task_id=polar-xyne-qa-grpo-0-0`, and the task polled to `status=completed`.

But the resulting session went **ERROR with 0 traces**. The exact error:

```
runtime initialization failed: No module named 'polar.runtime.local'
```

Full stack:

```
File "/data/siraj/ARL/ProRL-Agent-Server/src/polar/gateway/node.py", line 231, in _handle_init
    runtime = create_runtime(runtime_spec, request.session_id, managed.session_dir)
File "/data/siraj/ARL/ProRL-Agent-Server/src/polar/runtime/factory.py", line 28, in create_runtime
    cls = _import_runtime_class(spec.import_path)
File "/data/siraj/ARL/ProRL-Agent-Server/src/polar/runtime/factory.py", line 41, in _import_runtime_class
    return import_subclass(import_path, BaseRuntime, kind="runtime import path")
File "/data/siraj/ARL/ProRL-Agent-Server/src/polar/_imports.py", line 22, in import_subclass
    module = importlib.import_module(module_name)
ModuleNotFoundError: No module named 'polar.runtime.local'
```

---

## Root cause

Three facts line up to produce the failure:

1. The running trainer's task template (`polar_config_custom.yaml`, 20260812_071805) sets `runtime.import_path = polar.runtime.local:LocalRuntime`.
2. The live gateway process (`polar serve_gateway`, PID 1833205, node `xyne-node`) imports polar from `/data/siraj/ARL/ProRL-Agent-Server/src/polar`.
3. That directory's `runtime/` subdirectory contains no `local.py`. The `LocalRuntime` class exists only in a different package tree that is not on the running gateway's `sys.path`.

So `create_runtime()` fails at import time, deterministically, on every session, before the XyneHarness ever gets a chance to run.

The two runtime directories, side by side, make the gap obvious.

The gateway's runtime directory, `/data/siraj/ARL/ProRL-Agent-Server/src/polar/runtime/`:

```
total 56
drwxrwxr-x  3 gpu-burner gpu-burner 4096 Aug 10 12:47 .
drwxrwxr-x 11 gpu-burner gpu-burner 4096 Aug 10 12:31 ..
-rw-rw-r--  1 gpu-burner gpu-burner 8038 Jul 18 11:32 apptainer.py
-rw-rw-r--  1 gpu-burner gpu-burner 6717 Jul 18 11:32 base.py
-rw-rw-r--  1 gpu-burner gpu-burner 9383 Jul 18 11:32 docker.py
-rw-rw-r--  1 gpu-burner gpu-burner 2515 Jul 18 11:32 factory.py
-rw-rw-r--  1 gpu-burner gpu-burner  306 Jul 18 11:32 __init__.py
-rw-rw-r--  1 gpu-burner gpu-burner 2939 Jul 18 11:32 models.py
drwxrwxr-x  2 gpu-burner gpu-burner 4096 Aug 10 12:47 __pycache__
-rw-rw-r--  1 gpu-burner gpu-burner 2485 Jul 18 11:32 README.md
```

There is no `local.py` here. The directory that does contain it, `/data/siraj/ARL/miles/polar-pkg/polar/runtime/` (a different package tree, not on the gateway's path):

```
total 64
drwxrwxr-x  3 gpu-burner gpu-burner 4096 Aug 12 07:17 .
drwxrwxr-x 11 gpu-burner gpu-burner 4096 Aug 12 07:17 ..
-rw-rw-r--  1 gpu-burner gpu-burner 8038 Aug 11 13:00 apptainer.py
-rw-rw-r--  1 gpu-burner gpu-burner 6717 Aug 11 13:00 base.py
-rw-rw-r--  1 gpu-burner gpu-burner 9383 Aug 11 13:00 docker.py
-rw-rw-r--  1 gpu-burner gpu-burner 2515 Aug 11 13:00 factory.py
-rw-rw-r--  1 gpu-burner gpu-burner  306 Aug 11 13:00 __init__.py
-rw-rw-r--  1 gpu-burner gpu-burner 4522 Aug 12 06:43 local.py
-rw-rw-r--  1 gpu-burner gpu-burner 2939 Aug 11 13:00 models.py
drwxr-xr-x  2 root       root       4096 Aug 12 07:17 __pycache__
-rw-rw-r--  1 gpu-burner gpu-burner 2485 Aug 11 13:00 README.md
```

`local.py` exists here (4522 bytes) and nowhere on the live gateway's path. The gateway asks for `polar.runtime.local:LocalRuntime`, has no `local.py`, and aborts.

---

## Scope of the failure

This is not a flaky or occasional problem. It is a hard truth of the current deployment. The live reward path has never produced a reward.

A sweep of **2,000 saved task results** under `/data/siraj/logs/xyne_grpo/rollouts/` found:

- **0** trajectories with traces
- **0** rewards ever

The error mix across those 2,000 results:

- **1403** `no completions`
- **585** `No module named 'polar.runtime.local'`
- **11** `step 0 exited with code 1`
- **1** `step 0 exited code 127`

---

## Live services verified UP

The services themselves are healthy; the fault is in the wiring between them, not in the network or containers. All of these probes returned 200:

- Xyne standalone server `:3001/v2/health` on `xyne-harness-standalone-never-delete` → **200**
- Xyne `:3000/v2/health` → **200**
- Polar rollout `:8080` up (404 on `/`; the `task/submit` endpoint exists and returns **422** on an empty body)
- Polar gateway `:8100` → **200**; `polar status` → Health OK; `gateway_xyne-node [UP]`; `sglang_192.168.111.7:30100`; **0 running sessions**
- SGLang router `192.168.111.7:30100/v1/models` → **200**

All containers are UP, and none were restarted by the test: `miles-never-delete`, `xyne-harness-standalone-never-delete`, `siraj-xyne-db` (postgres `:15432`), `siraj-vespa` (`:18080`), `polar_dbg_run`.

The gateway is idle with zero running sessions, which is consistent with every session dying at initialization.

---

## Evidence

- Live integration test artifact: `/data/siraj/.omo/evidence/live-polar-reward-test.json`
- Notepad with the evaluation work and learnings: `/data/siraj/.omo/notepads/xyne-polar-evaluator-fix/learnings.md`

Both files exist on disk and back the numbers in this document.

---

## The two fix options

Both options alter a shared live service that the active trainer depends on. The user must choose before any work proceeds. No fix has been applied yet.

### Option A: add `polar/runtime/local.py` to the gateway's source tree

The file already exists at `/data/siraj/ARL/miles/polar-pkg/polar/runtime/local.py`. Copy or sync it into `/data/siraj/ARL/ProRL-Agent-Server/src/polar/runtime/`, then restart the gateway.

- **Fastest path to unblocking.**
- Keeps the current trainer template untouched, so the running job's config does not change.
- **Caveat:** must confirm the file's imports resolve against the `ProRL-Agent-Server` package (the two trees differ, and `local.py` may import sibling modules that behave differently there).

### Option B: change the trainer's task-template runtime to a backend the gateway can init

The current config references the docker backend with image `oven/bun:1.1-debian`, which is **not** present as an image. The only available images are `polar-xyne-runtime:withwait` and `radixark/miles:latest`. So the docker backend needs a valid image, or the template should point at a runtime that actually exists.

- More invasive.
- Touches the live trainer config that a running job depends on.
- **Caveat:** any change here risks disturbing the active training run.

### Recommendation

Option A is the smaller, safer intervention: it adds the missing file rather than changing configuration a live job depends on. Option B is the more structural fix but carries higher risk to the running trainer. The choice belongs to the user.
