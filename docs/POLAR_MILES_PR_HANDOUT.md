# Polar → Miles PR Handout

**Status date:** 2026-08-13  
**Repository checked:** `radixark/miles`  
**RTX source:** `/data/siraj/ARL/miles` on RTX1  
**Local snapshot:** `/Users/shaik.s/Documents/MTronLM/remote_staging/miles_pr_local`

## Executive recommendation

This is a useful integration for large-scale multi-turn agentic RL, especially
SWE-Gym, coding agents, tool use, and custom harnesses. It is not necessary for
ordinary single-turn GRPO or workloads already covered by Miles' native agent
connectors.

The implementation is suitable for a **draft/design PR** to get maintainer
feedback. It is not yet a merge-ready upstream PR because the candidate is a
large core change, the RTX clone is behind current upstream `main`, and full
Miles CI was unavailable on RTX1.

Recommended sequence:

1. Rebase the candidate onto current Miles `main`.
2. Open a draft PR or design issue asking whether Polar belongs in
   `miles_plugins/` or `examples/experimental/` instead of core
   `miles/rollout/`.
3. Add the missing dependency, mock HTTP integration tests, and one current-main
   end-to-end validation before requesting merge.

## What the feature does

Polar is an external rollout service for arbitrary agent harnesses. The proposed
bridge lets Miles use Polar sessions as a GRPO rollout source:

```text
Miles trainer
    │ submits task groups / consumes Samples
    ▼
Polar rollout service
    │ schedules agent sessions and harnesses
    ▼
multi-turn traces, token IDs, logprobs, loss masks, rewards
    │
    ▼
Miles GRPO training and reward processing
```

The integration is valuable when the environment is a long-running agent
session rather than a simple prompt → completion function.

### Useful capabilities

- Multi-turn agent harnesses with tools, sandboxes, and external evaluators.
- Asynchronous session fan-out and independent rollout-service scaling.
- Token-faithful trajectory reconstruction for training.
- Per-token rollout logprobs and loss masks.
- Polar-side task evaluation with rewards entering Miles' GRPO pipeline.
- Scheduler metadata, policy-version tracking, staleness limits, and metrics.
- A runnable SWeGym GRPO recipe for Nemotron-3-Nano-30B-A3B.

### Poor fit

- Standard math/code RL with simple single-turn prompts.
- Existing Miles integrations such as Harbor, OpenEnv, NeMo-Gym, or native
  custom generate functions.
- Teams that do not want to operate a separate Polar rollout service.

## Candidate contents

The frozen RTX1 PR candidate contains **12 staged files and 3,555 lines**:

| Area | Files | Purpose |
|---|---:|---|
| Rollout engine | `miles/rollout/polar_rollout.py` — 1,585 lines | Persistent async training worker, evaluation submit/poll path, callback/poll fallback, task fan-out, lifecycle, staleness, metrics. |
| Adapter | `miles/rollout/polar_adapter.py` — 392 lines | Polar trace → Miles `Sample` conversion with tokens, logprobs, masks, rewards, status, and metadata. |
| Configuration | `miles/rollout/polar_config.py` — 383 lines | Config resolution, task payload rendering, per-sample substitution, router/topology helpers. |
| Rewards | `miles/rollout/polar_reward.py` — 247 lines | Sync/async reward extraction and leave-one-trajectory-out reward processing. |
| Data source | `miles/rollout/polar_data_source.py` — 64 lines | Rounds epoch length up to a full rollout batch. |
| Package exports | `miles/rollout/__init__.py` — 74 lines | Lazy exports for 20 public symbols without eager Polar/SGLang imports. |
| Example | `miles/examples/polar_swegym_grpo/` — 748 lines | Launcher, README, model args, Docker template, XYNE-QA template. |
| Regression test | `tests/fast/rollout/test_polar_integrations.py` — 61 lines | Reward batching, template rendering, and batch-size rounding. |

The original inventory was 11 files / 3,489 lines. Fixes added 5 lines net,
and the regression test added 61 lines, producing the current staged total.

## Important fixes found during review

### 1. Batched reward-hook contract

Miles calls the configured reward function in both forms:

```python
await custom_rm(args, sample)          # float
await custom_rm(args, samples)         # list[float]
```

The initial implementation only handled one sample. A batch call silently
returned the wrong reward. `custom_rm` now accepts either shape, preserves the
corresponding return shape, and accepts forwarded keyword arguments.

### 2. Longest-trace artifact grouping

The adapter stores the session ID in:

```python
sample.metadata["polar"]["session_id"]
```

The artifact dumper initially looked for `sample.session_id`, which Miles'
`Sample` does not provide. It now uses the same Polar metadata path as the
adapter.

## Validation completed

### Passed on RTX1

- Focused unittest suite: **2 passed, 1 skipped**.
- Adversarial adapter checks:
  - valid trace conversion;
  - empty-trace placeholder generation;
  - missing trainable logprob rejection;
  - metadata propagation.
- Adversarial reward checks:
  - single and batched rewards;
  - nested reward extraction;
  - leave-one-trajectory-out normalization;
  - forwarded keyword arguments.
- Configuration checks:
  - structured template substitution;
  - unknown-variable rejection;
  - concurrency and validation rules.
- Data-source edge cases:
  - zero-length dataset;
  - exact batch multiple;
  - rounded-up tail;
  - invalid batch size.
- Rollout helper checks:
  - max-token resolution;
  - prompt flattening;
  - scheduler metadata attachment.
- Python AST/import and whitespace checks.
- YAML parsing for both Polar configs.
- Shell syntax checks for all recipe scripts.
- Staged `git diff --check`.

### Validation limitations

- `sglang` was unavailable in the RTX1 environment, so the data-source test was
  skipped there.
- `pytest` and `ruff` were unavailable on RTX1.
- No real Polar HTTP service or full Miles + SGLang + Polar training run was
  executed in this validation cycle.
- The candidate was created against an older Miles revision and needs a fresh
  rebase before upstream review.

## Current Git state — do not confuse this with the PR

The **frozen candidate** is the staged 12-file set described above. However,
RTX1's working tree has changed since that snapshot:

- RTX1 HEAD: `0113aa5ab88ed87f273f5ab1e19747731bfd2c44`.
- Current remote `origin/main`: `456340f86873c3da37b2e6e87568156b64bf401b`.
- The clone is therefore behind current upstream `main` and must be rebased.
- Current unstaged tracked changes include:
  - `miles/backends/megatron_utils/actor.py`;
  - edits to `polar_config_xyne_qa.yaml`;
  - edits to `run.sh`;
  - edits to `polar_adapter.py`.
- Current untracked additions include more XYNE launcher variants,
  `polar-pkg/`, `tmp/`, and `uv.lock`.
- No GitHub Polar PR was found in the open-PR search. The only search hit was
  unrelated PR #1241.

Do not create a PR from the current dirty RTX worktree until the intended final
file set is reviewed and staged from a rebased branch.

## Why this was not already in Miles

No evidence was found that Miles maintainers previously rejected Polar. The
most likely reasons are architectural and timing-related:

1. Polar is a newer, separate rollout-service project.
2. Polar describes itself as trainer-agnostic and currently advertises a demo
   Slime bridge, with additional trainer bridges as future work.
3. Miles already provides explicit extension points for external ecosystems:
   `--rollout-function-path`, `--custom-generate-function-path`,
   `--data-source-path`, and reward hooks.
4. Miles' environment documentation says external ecosystem support is
   experimental and organizes integrations as connectors occupying one of
   those plug-in layers.
5. A 3,500-line Polar-specific scheduler under core `miles/rollout/` creates
   maintenance, dependency, ownership, and CI cost for a feature that most
   Miles users do not need.

This is an inference from the current project documentation and repository
history, not a confirmed maintainer explanation.

## Upstream architecture question

Ask maintainers this directly in the draft PR or design issue:

> Polar needs an asynchronous rollout-service bridge for multi-turn agentic RL.
> Miles already supports custom rollout, data-source, and reward hooks. Should
> this integration live in core `miles/rollout/`, or should it be maintained as
> an experimental connector under `miles_plugins/` or
> `examples/experimental/`?

This question is more important than the current implementation details.

## Merge likelihood estimate

These are subjective estimates, not project statistics:

| Submission form | Estimated chance of useful acceptance |
|---|---:|
| Current 3,500-line core PR | 25–35% |
| Draft/design PR requesting architecture feedback | 70–80% |
| Rebased, experimental/plugin-scoped PR with CI and E2E evidence | 60–75% |

The main risk is scope and placement, not the basic usefulness of Polar.

## Recommended changes before a final merge request

- Rebase onto current Miles `main`.
- Decide core versus plugin/experimental placement with maintainers.
- Add a mocked HTTP test for submit → status polling → terminal result.
- Add callback delivery and callback-fallback polling tests.
- Add tests for timeout, failed tasks, stale groups, and zero-trainable traces.
- Run repository-pinned `ruff`, `black`, `pre-commit`, and `pytest`.
- Install the optional Polar/SGLang test environment or mark integration tests
  clearly as optional.
- Execute one real Polar + Miles rollout/evaluation smoke test.
- Document Polar installation and service startup without making Polar a
  required Miles dependency.
- Add explicit Apache-2.0 attribution for code ported from the Polar/Slime
  bridge if the final implementation retains that lineage.
- Keep unrelated RTX changes out of the branch.

## Draft PR metadata

### Suggested title

`feat(rollout): add experimental Polar agent rollout bridge`

### Suggested labels

`enhancement`, `experimental`, `rollout`, `agentic-rl`

### Suggested initial state

**Draft**, until maintainers confirm the intended ownership and directory.

### Suggested PR body

```markdown
## Summary

Add an experimental Polar-to-Miles bridge for asynchronous multi-turn agent
rollouts. Polar sessions are converted into native Miles Samples with token IDs,
rollout logprobs, loss masks, rewards, statuses, and scheduler metadata.

## Motivation

Miles already exposes rollout, data-source, and reward plug points, but Polar
provides a separate rollout service for arbitrary agent harnesses and long-lived
multi-turn sessions. This bridge lets SWE-Gym and similar harnesses feed
token-faithful trajectories into Miles GRPO without making Polar a required
Miles dependency.

## Scope

- Async Polar training rollout worker and evaluation submit/poll path.
- Polar trace → Miles Sample adapter.
- Config/task rendering and per-sample metadata substitution.
- Reward hooks and trajectory-aware reward post-processing.
- Batch-rounded data-source wrapper.
- Lazy exports and a SWeGym GRPO example.
- Focused regression tests.

## Correctness fixes included

- `custom_rm` supports Miles single-sample and batched call contracts, including
  forwarded keyword arguments.
- Longest-trace artifact grouping reads session IDs from Polar metadata.

## Verification

- Focused tests: 2 passed, 1 skipped because `sglang` was unavailable on RTX1.
- Adversarial adapter, reward, config, data-source, and rollout-helper checks
  passed.
- AST/import, YAML, shell, whitespace, and staged diff checks passed.
- Full repository CI and a real Polar HTTP/E2E run remain to be run on the
  rebased branch.

## Design question

Should this remain under core `miles/rollout/`, or should Polar-specific code
move to `miles_plugins/` / `examples/experimental/` as an external connector?

The implementation and available validation were reviewed with the requester.
Unrelated RTX working-tree files are excluded.
```

## References

- [Miles repository](https://github.com/radixark/miles)
- [Miles customization guide](https://github.com/radixark/miles/blob/main/docs/user-guide/customization.md)
- [Miles environments guide](https://github.com/radixark/miles/blob/main/docs/user-guide/environments.md)
- [Miles contribution guide](https://github.com/radixark/miles/blob/main/docs/developer/contributor-guide.md)
- [Miles code owners](https://github.com/radixark/miles/blob/main/.github/CODEOWNERS)
- [Polar / ProRL-Agent-Server repository](https://github.com/NVIDIA-NeMo/ProRL-Agent-Server)
- [Polar rollout README](https://github.com/NVIDIA-NeMo/ProRL-Agent-Server/blob/stable/src/polar/rollout/README.md)
- [Polar paper](https://arxiv.org/abs/2605.24220)

## Bottom line

The feature is useful and technically validated as a prototype. The safest
upstream move is a draft/design PR from a clean, rebased branch that asks for
placement guidance. Do not present the current dirty RTX1 worktree as the final
PR candidate.
