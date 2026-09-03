# Validation Report

Validation date: 2026-09-03

## Passed locally

- Python compilation passed for `polar-pkg/`, `miles/`, `tests/`, and `tools/`.
- Bash syntax passed for every `.sh` file in the repository.
- Git whitespace checks passed.
- Ruff checks passed for the changed Polar, packaged-runtime, test, and dump
  auditor Python files.
- Current v34 reproducibility tests:

```text
10 passed
```

- Focused Miles/Polar integration test:

```text
4 passed, 1 skipped
```

- Secret scan found no live W&B key, grid API key, or private-key block.
- The current session-proxy package keeps tool-bearing requests streaming,
  guards output tokens at 16,384, and synthesizes tool-call SSE deltas.
- The idempotent session-proxy starter passed a local isolated-port smoke test.
  It runs from `.runtime/` so Polar's local `types.py` cannot shadow Python's
  stdlib `types` module.
- A local dummy-upstream integration verified tool-bearing SSE forwarding,
  16,384-token request clamping, removal of `stream_options`, and Polar bearer
  session attribution through the proxy.
- The Polar source, installable package, and Miles runtime copies are
  synchronized for the harness, session proxy, evaluator, and judge.
- Read-only audit of the newest four v34 dumps:
  `642 records`, `32 sessions`, `4,988 tool calls`, `1,790 citations`,
  `5,630 reasoning blocks`, `34,876 retrieved chunks`, `458,835 trainable
  tokens`, all judge records at `16,384` max tokens, and `validation: PASS`.
- The copied source trees contain no virtualenv, node modules, logs, checkpoints,
  rollout dumps, or private dataset JSONL.

## Current test debt

The broader Xyne test suite is intentionally preserved as a snapshot of the live
RTX source:

```text
140 passed, 28 failed
```

The failures are not hidden or auto-modified. They mostly come from test
expectations that predate the newer scorer semantics:

- smooth inverse-style tool/token efficiency instead of full score through budget
- stricter citation and subagent evidence checks
- updated retrieval-quality and evaluator behavior
- one helper test expecting the historical `src/polar/...` layout

Do not change scorer behavior merely to turn this suite green. Decide the
intended reward contract first, then update either code or tests in a dedicated
change.

During package synchronization, one stale judge expectation was updated to the
current 16,384-token contract and the evaluator's gold-metadata fallback was made
safe for mocked pipelines. The suite still reports the known 140 passed / 28
failed baseline; no scorer semantics were changed to hide those 28 failures.

## Live-system safety

This snapshot was taken without modifying the running trainer, Polar, Xyne, or
SGLang services. The only remote-side artifacts created during capture were
temporary patch files under `/tmp`, not source-tree changes.
The 2026-09-03 repo-hardening pass also left the live v34 Ray job untouched.
The live `:18114` proxy was also left untouched; its older GET `/v1/models`
path can return 502, while the repository version fixes that method-scope bug.
