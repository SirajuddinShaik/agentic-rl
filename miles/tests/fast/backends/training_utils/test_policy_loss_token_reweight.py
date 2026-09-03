"""Unit tests for Task 12 of the rl-reward-credit-fix plan.

Covers ActFocus per-token reweighting wired into ``policy_loss_function``:

- ``_compute_token_weights`` builds the energy-based per-token weight tensor:
  reasoning tokens (action_mask == 0) get a flat ``alpha``; action tokens get
  ``1 + beta * sigmoid((E - mu_E) / sigma_E)`` where ``E = -ref_logsumexp``.
- The happy path: with ``enable_token_reweight`` on and both
  ``action_masks`` / ``ref_logsumexp`` present, the policy loss is reduced
  with custom per-sample denominators ``sum(wt * mask)`` and the reported
  loss differs from the uniform (flag-off) run.
- Backward compatibility: with the flag off (default) the behavior is
  byte-identical to the pre-change loss even when the keys are present in the
  batch.

This module intentionally has no explicit CI registration call: modules under
tests/fast are implicitly assigned to the stage-a-cpu suite by the CI collector.
"""

from argparse import Namespace

import pytest
import torch

from miles.backends.training_utils.loss_hub import losses as loss_utils
from miles.backends.training_utils.parallel import (
    GroupInfo,
    ParallelState,
    set_parallel_state,
)


def _make_parallel_state() -> ParallelState:
    def _trivial_group() -> GroupInfo:
        return GroupInfo(rank=0, size=1, group=None)

    state = ParallelState(
        intra_dp=_trivial_group(),
        intra_dp_cp=_trivial_group(),
        cp=_trivial_group(),
        tp=_trivial_group(),
        pp=_trivial_group(),
        ep=_trivial_group(),
        etp=_trivial_group(),
        indep_dp=_trivial_group(),
        is_pp_last_stage=True,
    )
    set_parallel_state(state)
    return state


def _make_args(**overrides) -> Namespace:
    d = dict(
        use_rollout_logprobs=False,
        use_opsm=False,
        advantage_estimator="ppo",
        get_mismatch_metrics=False,
        use_tis=False,
        eps_clip=0.2,
        eps_clip_high=0.2,
        custom_tis_function_path=None,
        custom_pg_loss_reducer_function_path=None,
        calculate_per_token_loss=False,
        qkv_format="thd",
        entropy_coef=0.0,
        observe_training_entropy=False,
        use_kl_loss=False,
        use_unbiased_kl=False,
        kl_loss_type="k1",
        kl_loss_coef=0.0,
        rollout_temperature=1.0,
        log_probs_chunk_size=-1,
        true_on_policy_mode=False,
        allgather_cp=False,
        dump_details=None,
        # ActFocus reweighting
        enable_token_reweight=False,
        token_reweight_alpha=0.3,
        token_reweight_beta=0.5,
    )
    d.update(overrides)
    return Namespace(**d)


def _make_batch(*, with_reweight_keys: bool) -> dict:
    batch = {
        "advantages": [torch.tensor([1.0, 1.0, -1.0, -1.0], dtype=torch.float32)],
        "log_probs": [torch.tensor([-1.0, -2.0, -3.0, -4.0], dtype=torch.float32)],
        "unconcat_tokens": [torch.tensor([1, 2, 3, 4, 5, 6], dtype=torch.long)],
        "response_lengths": [4],
        "total_lengths": [6],
        "loss_masks": [torch.tensor([1.0, 1.0, 1.0, 1.0], dtype=torch.float32)],
    }
    if with_reweight_keys:
        batch["action_masks"] = [torch.tensor([0, 0, 1, 1], dtype=torch.long)]
        batch["ref_logsumexp"] = [torch.tensor([-2.0, -0.5, 0.5, 2.0], dtype=torch.float32)]
    return batch


def _patch_helpers(monkeypatch):
    parallel_state = _make_parallel_state()
    # Single-rank: local response masks are the identity.
    monkeypatch.setattr(
        loss_utils,
        "get_local_response_loss_masks",
        lambda total_lengths, response_lengths, loss_masks, qkv_format="thd", max_seq_lens=None: loss_masks,
    )
    monkeypatch.setattr(
        loss_utils,
        "compute_ess_ratio_contribution",
        lambda *, ppo_kl, **kwargs: ppo_kl.new_tensor(1.0),
    )
    return parallel_state


def _run_policy_loss(monkeypatch, *, enable_token_reweight: bool, with_reweight_keys: bool):
    args = _make_args(enable_token_reweight=enable_token_reweight)
    batch = _make_batch(with_reweight_keys=with_reweight_keys)
    log_probs = torch.tensor([-1.5, -1.5, -1.5, -1.5], dtype=torch.float32)

    _patch_helpers(monkeypatch)
    monkeypatch.setattr(
        loss_utils,
        "get_log_probs_and_entropy",
        lambda *args, **kwargs: {"log_probs": [log_probs.clone()]},
    )

    return loss_utils.policy_loss_function(
        args,
        batch,
        logits=torch.zeros((1, 6, 8), dtype=torch.float32),
        sum_of_sample_mean=lambda tensor: tensor.float().mean(),
    )


# ---------------------------------------------------------------------------
# _compute_token_weights formula
# ---------------------------------------------------------------------------


def test_compute_token_weights_formula():
    action_masks = torch.tensor([0, 0, 1, 1], dtype=torch.long)
    ref_logsumexp = torch.tensor([-2.0, -0.5, 0.5, 2.0], dtype=torch.float32)
    loss_masks = torch.ones(4, dtype=torch.float32)
    alpha, beta = 0.3, 0.5

    wt = loss_utils._compute_token_weights(action_masks, ref_logsumexp, alpha, beta, loss_masks)

    assert wt.shape == action_masks.shape
    free_energy = -ref_logsumexp
    action_energy = free_energy[action_masks.bool()]
    mu_E = action_energy.mean()
    sigma_E = action_energy.std().clamp_min(1e-6)
    expected = torch.where(
        action_masks.bool(),
        1.0 + beta * torch.sigmoid((free_energy - mu_E) / sigma_E),
        torch.full_like(free_energy, alpha),
    )
    torch.testing.assert_close(wt, expected, atol=1e-6, rtol=1e-6)
    # Reasoning tokens carry the flat alpha weight.
    torch.testing.assert_close(wt[action_masks == 0], torch.full((2,), alpha), atol=1e-6, rtol=1e-6)


def test_compute_token_weights_zeros_inactive_tokens():
    action_masks = torch.tensor([0, 0, 1, 1], dtype=torch.long)
    ref_logsumexp = torch.tensor([-2.0, -0.5, 0.5, 2.0], dtype=torch.float32)
    loss_masks = torch.tensor([1.0, 0.0, 1.0, 1.0], dtype=torch.float32)
    wt = loss_utils._compute_token_weights(action_masks, ref_logsumexp, 0.3, 0.5, loss_masks)
    assert wt[1].item() == 0.0  # inactive token zeroed regardless of alpha


def test_compute_token_weights_constant_energy_std_clamped():
    # All action tokens share the same energy -> std == 0 -> clamped to 1e-6,
    # so (E - mu) / sigma == 0 and sigmoid(0) == 0.5.
    action_masks = torch.tensor([1, 1, 1, 1], dtype=torch.long)
    ref_logsumexp = torch.full((4,), 1.0, dtype=torch.float32)
    loss_masks = torch.ones(4, dtype=torch.float32)
    wt = loss_utils._compute_token_weights(action_masks, ref_logsumexp, 0.3, 0.5, loss_masks)
    expected_action = 1.0 + 0.5 * torch.sigmoid(torch.zeros(1)).item()
    torch.testing.assert_close(wt, torch.full((4,), expected_action), atol=1e-6, rtol=1e-6)


# ---------------------------------------------------------------------------
# Happy path: reweighting active -> custom denominators + different loss
# ---------------------------------------------------------------------------


def test_policy_loss_reweighting_changes_loss_and_uses_custom_denominator(monkeypatch):
    loss_reweighted, metrics_reweighted = _run_policy_loss(
        monkeypatch, enable_token_reweight=True, with_reweight_keys=True
    )
    loss_flat, metrics_flat = _run_policy_loss(
        monkeypatch, enable_token_reweight=False, with_reweight_keys=True
    )

    # The reweighted loss must differ from the uniform (flag-off) loss.
    assert not torch.allclose(metrics_reweighted["pg_loss"], metrics_flat["pg_loss"], atol=1e-6)

    # Independent check: with a single sample whose mask is all ones, the
    # custom-denominator reduction equals sum(pg_losses * wt) / sum(wt).
    old_log_probs = torch.tensor([-1.0, -2.0, -3.0, -4.0], dtype=torch.float32)
    log_probs = torch.tensor([-1.5, -1.5, -1.5, -1.5], dtype=torch.float32)
    ppo_kl = old_log_probs - log_probs
    advantages = torch.tensor([1.0, 1.0, -1.0, -1.0], dtype=torch.float32)
    pg_losses, _ = loss_utils.compute_policy_loss(ppo_kl, advantages, 0.2, 0.2)

    action_masks = torch.tensor([0, 0, 1, 1], dtype=torch.long)
    ref_logsumexp = torch.tensor([-2.0, -0.5, 0.5, 2.0], dtype=torch.float32)
    wt = loss_utils._compute_token_weights(action_masks, ref_logsumexp, 0.3, 0.5, torch.ones(4))
    expected = (pg_losses * wt).sum() / wt.sum()

    torch.testing.assert_close(metrics_reweighted["pg_loss"], expected, atol=1e-6, rtol=1e-6)
    torch.testing.assert_close(loss_reweighted, expected, atol=1e-6, rtol=1e-6)


# ---------------------------------------------------------------------------
# Backward compatibility: flag off (default) -> identical to unmodified code
# ---------------------------------------------------------------------------


def test_policy_loss_reweighting_backward_compat_flag_off_identical(monkeypatch):
    # Flag off but keys present: keys must be ignored entirely.
    with_keys, metrics_with_keys = _run_policy_loss(
        monkeypatch, enable_token_reweight=False, with_reweight_keys=True
    )
    without_keys, metrics_without_keys = _run_policy_loss(
        monkeypatch, enable_token_reweight=False, with_reweight_keys=False
    )

    assert torch.equal(metrics_with_keys["pg_loss"], metrics_without_keys["pg_loss"])
    assert torch.equal(with_keys, without_keys)

    # Confirm the flag-off loss equals the unweighted per-sample mean, i.e.
    # the pre-change behavior: sum(pg_losses) / num_tokens.
    old_log_probs = torch.tensor([-1.0, -2.0, -3.0, -4.0], dtype=torch.float32)
    log_probs = torch.tensor([-1.5, -1.5, -1.5, -1.5], dtype=torch.float32)
    ppo_kl = old_log_probs - log_probs
    advantages = torch.tensor([1.0, 1.0, -1.0, -1.0], dtype=torch.float32)
    pg_losses, _ = loss_utils.compute_policy_loss(ppo_kl, advantages, 0.2, 0.2)
    expected_uniform = pg_losses.sum() / 4.0

    torch.testing.assert_close(metrics_with_keys["pg_loss"], expected_uniform, atol=1e-6, rtol=1e-6)


def test_policy_loss_reweighting_default_args_are_backward_compatible(monkeypatch):
    # A caller that never sets the ActFocus attrs (pre-T5 Namespace) must not
    # crash: getattr defaults keep the feature off.
    batch = _make_batch(with_reweight_keys=True)
    log_probs = torch.tensor([-1.5, -1.5, -1.5, -1.5], dtype=torch.float32)
    _patch_helpers(monkeypatch)
    monkeypatch.setattr(
        loss_utils,
        "get_log_probs_and_entropy",
        lambda *args, **kwargs: {"log_probs": [log_probs.clone()]},
    )
    legacy_args = _make_args()
    del legacy_args.enable_token_reweight
    del legacy_args.token_reweight_alpha
    del legacy_args.token_reweight_beta

    loss, metrics = loss_utils.policy_loss_function(
        legacy_args,
        batch,
        logits=torch.zeros((1, 6, 8), dtype=torch.float32),
        sum_of_sample_mean=lambda tensor: tensor.float().mean(),
    )

    assert torch.isfinite(loss)
    assert torch.isfinite(metrics["pg_loss"])
