# RL Reward & Credit-Assignment Fix — RTX1 Handout

**Target container:** `miles-never-delete` (radixark/miles:latest) on RTX1.
**Scope:** Make the Nemotron-30B-A3B GRPO run actually learn (was flat: raw_reward ~0.15–0.27 across 15 rollouts, train_rollout_kl 0.0).
**Root cause (confirmed):** Action Bottleneck — uniform GRPO credit over ~100K-token agent trajectories dilutes the only informative signal (tool-call/action tokens) to zero. Plus a reward that is too sparse/noisy to learn from.

This handout documents (A) the reward architecture as-built, (B) how to add/modify reward scorers, and (C) the exact code change to add ActFocus-style per-token reweighting. It is ready to implement directly on RTX1.

---

## Part 1 — Reward pipeline architecture (as-built)

### 1.1 The two reward layers + advantage

```text
Xyne agent trajectory (multi-turn tool-use)
        │
        ▼
[XyneCompositeEvaluator]  polar-pkg/polar/xyne/evaluator.py
  runs RewardPipeline over configured scorers
  reward = Σ(weight_i × score_i) / Σ(weight_i)      → outcome_reward (raw_reward)
        │
        ▼
[apply_group_reward]      polar-pkg/polar/rollout/group_reward.py
  quality_conditioned_token_efficiency (Pareto)      → shaped reward
        │
        ▼
[post_process_rewards]    miles/rollout/polar_reward.py   (Miles side)
  leave-one-out group advantage → GRPO advantage
        │
        ▼
[Megatron policy loss]    miles/backends/training_utils/loss_hub/
  per-token clipped surrogate, UNIFORM credit  ← here is the bug
```

### 1.2 Current scorers (from `polar_config_custom.yaml`)

Config file for the last run:
`/root/miles/tmp/xyne_qa_tp2cp4ep8/sebi-pranav-tp2cp4ep8-lora64-qv-fc1fc2-b32-gbs32-spr8-100k-20260816_130653/polar_config_custom.yaml`

| scorer | weight | notes |
|---|---|---|
| `llm_judge` | 3.0 | vocally dominant; 4 dims (quality, correctness, groundedness, citation_accuracy), each returns only {0.0,0.5,1.0}, each = 1 network call to grid.ai (glm-flash-experimental); noisy |
| `embedding_similarity` (f1) | 2.0 | vs reference answer |
| `gold_evidence_coverage` | 2.0 | exact_weight 0.5 |
| `citation_evidence_coverage` | 2.0 | exact_weight 0.5 |
| `tool_evidence_utility` | 1.0 | coverage_weight 0.75, exact_weight 0.5 |

Total weight = 10.0 → composite in [0,1].

Group level in same YAML: `group_reward: { strategy: quality_conditioned_token_efficiency, weight: 0.03, input_weight: 0.02 }`.

### 1.3 File map

```
/root/miles/polar-pkg/polar/xyne/reward_pipeline.py       # XyneScorer ABC + SCORER_REGISTRY + build_pipeline
/root/miles/polar-pkg/polar/xyne/evaluator.py             # XyneCompositeEvaluator (builds pipeline, per-scorer config)
/root/miles/polar-pkg/polar/xyne/scorers/__init__.py      # imports each module → fires @register_scorer
/root/miles/polar-pkg/polar/xyne/scorers/<name>.py        # each scorer class
/root/miles/polar-pkg/polar/rollout/group_reward.py       # quality-conditioned token efficiency
/root/miles/miles/rollout/polar_reward.py                 # custom_rm + post_process_rewards (Miles side)
/root/miles/miles/backends/training_utils/loss_hub/losses.py      # policy_loss_function
/root/miles/miles/backends/training_utils/loss_hub/math_utils.py  # compute_policy_loss (line ~254)
```

---

## Part 2 — How to ADD or MODIFY a reward scorer

### 2.1 Add a new scorer (pluggable seam — no core changes)

1. Create `/root/miles/polar-pkg/polar/xyne/scorers/<name>.py`:

```python
from polar.xyne.reward_pipeline import XyneScorer, register_scorer

NAME = "my_new_scorer"

@register_scorer(NAME)
class MyNewScorer(XyneScorer):
    name = NAME

    def __init__(self, config=None, *, weight=1.0, enabled=True):
        cfg = config or {}
        super().__init__(weight=float(cfg.get("weight", weight)),
                         enabled=bool(cfg.get("enabled", enabled)))
        # read any per-scorer config keys
        self._some_param = float(cfg.get("some_param", 1.0))

    def score(self, flow):  # -> float in [0,1], must never raise
        ...
        return score
```

2. Import it in `/root/miles/polar-pkg/polar/xyne/scorers/__init__.py` (add `from polar.xyne.scorers import my_new_scorer  # noqa: F401` and add name to `__all__`).

3. Enable it in your `polar_config_custom.yaml` under `evaluator.config.scorers`:
```yaml
      - name: my_new_scorer
        weight: 1.0
        # any per-scorer keys are forwarded as config
```

Notes:
- Scorers are invoked through the evaluator's `_build_pipeline`/`_instantiate_scorer` — per-scorer keys already registered in `_instantiate_scorer` get forwarded automatically; for brand-new config keys add a small forwarding block there (or the scorer must read them from `config` dict, which it already does via `__init__`).
- `score()` is synchronous and must never raise (the pipeline has no try/except per scorer — a raise would hit the evaluator's outer try and reward 0.0).

### 2.2 Modify existing scorers / weights

Pure config change in `polar_config_custom.yaml` — no code:
- Rebalance `weight` per scorer (e.g. reduce `llm_judge`, raise the deterministic coverage scorers).
- For `llm_judge`, adjust `judge.dimension_weights` (currently quality 1.0, correctness 2.0, groundedness 1.5, citation_accuracy 1.5) and/or gate dims via `enable_<dim>`.
- Toggle `enabled: false` to drop a scorer.

### 2.3 Recommended reward changes (densify / stabilize)

1. **Enable already-registered scorers** that are currently unused:
   - `tool_call_efficiency` (rewards efficient/valid tool usage — denser, deterministic).
   - `token_efficiency` (already gets auto-injected token counts by `_inject_token_counts`).
   - `completion` / `answer_format` (cheap safety gates).
2. **Optionally add a rule-based "task done + evidence matched" oracle scorer** (deterministic, zero noise) and give it meaningful weight, so the RL has a stable gradient signal instead of relying ~30% on the noisy GLM judge.

---

## Part 3 — Fix the root cause: ActFocus token reweighting (Action Bottleneck)

Reference: Resolving Action Bottleneck (arXiv:2605.14558). In agentic trajectories, action/tool-call tokens are only ~4–16% of tokens, but carry nearly all informative signal (action-token energy correlates ρ=+0.537 with reward variance; reasoning tokens ρ≈0). Under GRPO a single trajectory advantage is applied to every token, so the signal is diluted to ~0 — matching `train_rollout_kl: 0.0`.

### 3.1 The current uniform credit code

`/root/miles/miles/backends/training_utils/loss_hub/math_utils.py` (~line 254):

```python
def compute_policy_loss(ppo_kl, advantages, eps_clip, eps_clip_high, eps_clip_c):
    ratio = exp(-ppo_kl)
    pg_l1 = -ratio * advantages
    pg_l2 = -ratio.clamp(1 - eps_clip, 1 + eps_clip_high) * advantages
    pg_loss = torch.max(pg_l1, pg_l2)
    ...
```

There is NO per-token weight distinguishing reasoning vs action tokens. Confirmed by grep: no `token_weight` / `action_mask` / `reasoning_mask` anywhere in `loss_hub` or `arguments.py`.

### 3.2 What to change

Add a per-token weight `wt` and fold it into the surrogate + normalization, following Eq. 5/6 of the paper:

```python
def compute_policy_loss(ppo_kl, advantages, eps_clip, eps_clip_high, eps_clip_c,
                        token_weights=None):        # NEW: shape == ppo_kl
    ratio = exp(-ppo_kl)
    pg_l1 = -ratio * advantages
    pg_l2 = -ratio.clamp(1 - eps_clip, 1 + eps_clip_high) * advantages
    pg_losses = torch.max(pg_l1, pg_l2)
    if token_weights is not None:
        pg_losses = pg_losses * token_weights        # NEW: w_t per token
    if eps_clip_c > 1.0:
        pg_losses3 = -eps_clip_c * advantages
        pg_losses = torch.where(pg_losses3 > pg_losses, pg_losses3, pg_losses)
    ...
```

Weight rule (per token via spans):
```
wt = 
    alpha                                        if token is a reasoning token
    1 + beta * sigmoid((E_t - mu_E)/sigma_E)     if token is an action/tool-call token
```
- `alpha` = reasoning retention, e.g. 0.1–0.3 (WebShop-like tasks need ~0.3; aggressive reasoning → 0.1).
- `beta` = action energy modulation, e.g. 0.5–1.0 (peaks ~1.0, degrades at 2.0).
- `E_t` = frozen-reference next-token free energy: `E_t = -log Σ_v exp(logit_ref[v])` from the reference model; stable because the reference is frozen.
- Normalize the final loss by `Σ_t wt` (not token count) so reweighting moves gradient mass rather than changing the loss scale.

### 3.3 Where the spans come from

`compute_policy_loss` only sees `ppo_kl` + `advantages` (no token labels). To introduce spans you must thread token position labels from the Sample/rollout into the loss:
- The trajectory schema already carries `loss_mask` (valid response tokens) and `tokens`. Add an **`action_mask`** (or `reasoning_mask`) built at Sample-conversion time in `miles/rollout/polar_adapter.py` (or `train_data_conversion.py`), marking tool-call/tool-use segments inside the response.
- Your format marks tool calls — tag tokens inside those spans as action tokens, everything else as reasoning.
- Pass `token_weights` alongside `loss_mask` through `policy_loss_function` → `compute_policy_loss`.

### 3.4 Implementation checklist (in container)

- [ ] Add `token_weights` param to `compute_policy_loss` in `math_utils.py`.
- [ ] Pass it from `losses.py:policy_loss_function` (build `wt` from per-token spans; normalize by `Σ wt`; handle ESS/IS-ratio denominator accordingly).
- [ ] Add span labels at Sample conversion (`polar_adapter.py` / `train_data_conversion.py`): produce `action_mask` aligned with `loss_mask`.
- [ ] Add args: `--token-reweight-alpha`, `--token-reweight-beta`, `--action-mask-key` in `arguments.py`.
- [ ] Validate: `train_rollout_kl` / `logprob_abs_diff` should become non-zero; grad_norm should rise; then monitor raw_reward for a rising trend over rollouts.

---

## Part 4 — Where to make the changes

All paths are inside the `miles-never-delete` container on RTX1.

| Change | File | Line |
|---|---|---|
| Add new scorer | `polar-pkg/polar/xyne/scorers/<name>.py` (new) + `scorers/__init__.py` | — |
| Register per-scorer config keys | `polar-pkg/polar/xyne/evaluator.py` `_instantiate_scorer` | ~130–200 |
| Reward weights/config | `<run>/polar_config_custom.yaml` `evaluator.config.scorers` | — |
| Group shaping | `polar-pkg/polar/rollout/group_reward.py` | whole file |
| Reward post-process | `miles/rollout/polar_reward.py` `post_process_rewards` | ~100–170 |
| Token reweighting | `miles/backends/training_utils/loss_hub/math_utils.py` `compute_policy_loss` | ~254 |
| Pass weights | `miles/backends/training_utils/loss_hub/losses.py` `policy_loss_function` | ~1–491 |
| Span labels | `miles/rollout/polar_adapter.py` / `miles/ray/rollout/train_data_conversion.py` | — |
| New args | `arguments.py` | — |

---

## Part 5 — Suggested first experiment

1. Keep config identical EXCEPT enable `tool_call_efficiency` + `token_efficiency` (or add a deterministic oracle scorer), and reduce `llm_judge` weight 3.0 → 1.5 to cut noise.
2. Only after reward is denser and less noisy, add the ActFocus token reweighting (alpha≈0.3, beta≈0.5) — this is the fix that attacks the root cause.
3. Run >1 epoch / more prompts: 484 prompts on 1 epoch is far too little agentic data.

---

## Appendix — Verified command context

- SSH: `ssh rtx1` (gpu-burner@118.95.213.223:23433)
- Container: `docker exec -it miles-never-delete bash`
- Last trained run config (the "no learning" run): `sebi-pranav-tp2cp4ep8-lora64-qv-fc1fc2-b32-gbs32-spr8-100k-20260816_130653`
- Reward YAML: `<that run>/polar_config_custom.yaml`
