"""Unit tests for Task 3 & Task 4 of the rl-reward-credit-fix plan.

Covers:
- ``compute_logsumexp_from_logits`` mirrors ``torch.logsumexp(..., dim=-1)``
  when ``process_group=None`` (single process / unit testing).
- ``compute_policy_loss`` accepts an optional ``token_weights`` param that
  reweights the final per-token loss, and is a no-op when ``None`` (backward
  compatible with existing callers).

This module intentionally has no explicit CI registration call: modules under
tests/fast are implicitly assigned to the stage-a-cpu suite by the CI collector
(an explicit default-form call would be rejected by the AC-9 meta-test).
"""

import torch

from miles.backends.training_utils.loss_hub.math_utils import (
    compute_logsumexp_from_logits,
    compute_policy_loss,
)


def test_logsumexp_matches_torch_on_random_logits():
    torch.manual_seed(0)
    logits = torch.randn(3, 64)
    result = compute_logsumexp_from_logits(logits, None)
    expected = torch.logsumexp(logits, dim=-1)
    assert result.shape == (3,)
    assert torch.allclose(result, expected, atol=1e-5)


def test_logsumexp_edge_all_zero_logits():
    # logsumexp of all-zero logits over a vocab of size V is log(V).
    logits = torch.zeros(2, 100)
    result = compute_logsumexp_from_logits(logits, None)
    assert torch.allclose(result, torch.full((2,), 100.0).log(), atol=1e-5)


def test_logsumexp_edge_large_logits_no_overflow():
    # Max-subtraction keeps exp() finite for very large logits.
    logits = torch.tensor([[1000.0, 1000.0, 1000.0]])
    result = compute_logsumexp_from_logits(logits, None)
    expected = torch.logsumexp(logits, dim=-1)
    assert torch.isfinite(result).all()
    assert torch.allclose(result, expected, atol=1e-5)


def test_logsumexp_single_element_vocab():
    logits = torch.tensor([[3.5]])
    result = compute_logsumexp_from_logits(logits, None)
    assert torch.allclose(result, torch.tensor([3.5]), atol=1e-5)


def test_policy_loss_token_weights_doubles_loss():
    ppo_kl = torch.randn(8)
    advantages = torch.randn(8)
    base, clipfrac = compute_policy_loss(ppo_kl, advantages, 0.2, 0.2)
    weights = torch.full_like(advantages, 2.0)
    weighted, weighted_clipfrac = compute_policy_loss(
        ppo_kl, advantages, 0.2, 0.2, token_weights=weights
    )
    assert torch.allclose(weighted, base * 2.0)
    assert torch.equal(weighted_clipfrac, clipfrac)


def test_policy_loss_token_weights_per_token():
    ppo_kl = torch.randn(4)
    advantages = torch.randn(4)
    base, _ = compute_policy_loss(ppo_kl, advantages, 0.2, 0.2)
    weights = torch.tensor([1.0, 0.1, 1.0, 0.1])
    weighted, _ = compute_policy_loss(ppo_kl, advantages, 0.2, 0.2, token_weights=weights)
    assert torch.allclose(weighted, base * weights)


def test_policy_loss_none_is_backward_compatible():
    # Default (token_weights=None) must be byte-identical to the pre-change
    # behavior of computing the loss and returning (pg_losses, clipfrac).
    ppo_kl = torch.randn(6)
    advantages = torch.randn(6)
    default_loss, default_clipfrac = compute_policy_loss(ppo_kl, advantages, 0.2, 0.2)
    explicit_none_loss, explicit_none_clipfrac = compute_policy_loss(
        ppo_kl, advantages, 0.2, 0.2, token_weights=None
    )
    assert torch.equal(default_loss, explicit_none_loss)
    assert torch.equal(default_clipfrac, explicit_none_clipfrac)


def test_policy_loss_token_weights_with_eps_clip_c():
    # token_weights must apply after the dual-clip (eps_clip_c) branch too.
    ppo_kl = torch.randn(8)
    advantages = torch.cat([torch.randn(4), -torch.randn(4)])  # mix of pos/neg adv
    base, _ = compute_policy_loss(ppo_kl, advantages, 0.2, 0.2, eps_clip_c=1.5)
    weights = torch.full_like(advantages, 3.0)
    weighted, _ = compute_policy_loss(ppo_kl, advantages, 0.2, 0.2, eps_clip_c=1.5, token_weights=weights)
    assert torch.allclose(weighted, base * 3.0)
