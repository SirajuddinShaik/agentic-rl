"""Unit tests for Task 7 of the rl-reward-credit-fix plan.

Covers threading the ``with_logsumexp`` option through
``calculate_log_probs_and_entropy`` and ``get_log_probs_and_entropy``:

- With ``with_logsumexp=True`` it returns a 3-tuple ``(log_prob, entropy,
  logsumexp)`` where ``logsumexp`` matches ``torch.logsumexp(logits, dim=-1)``.
- With ``with_logsumexp=False`` (the default) it returns the original 2-tuple
  ``(log_prob, entropy)`` — backward compatibility preserved.
- ``get_log_probs_and_entropy`` exposes a ``"logsumexp"`` key only when
  ``with_logsumexp=True``, sliced like ``log_probs``.

This module intentionally has no explicit CI registration call: modules under
tests/fast are implicitly assigned to the stage-a-cpu suite by the CI collector
(an explicit default-form call would be rejected by the AC-9 meta-test).
"""

import os

import pytest
import torch
import torch.distributed as dist

from .loss_test_utils import make_args, make_parallel_state
from miles.backends.training_utils.loss_hub.logit_processors import get_log_probs_and_entropy
from miles.backends.training_utils.loss_hub.math_utils import (
    calculate_log_probs_and_entropy,
)


@pytest.fixture(scope="module", autouse=True)
def _init_default_process_group():
    os.environ.setdefault("MASTER_ADDR", "127.0.0.1")
    os.environ.setdefault("MASTER_PORT", "29599")
    if not dist.is_initialized():
        dist.init_process_group("gloo", rank=0, world_size=1)
    yield
    if dist.is_initialized():
        dist.destroy_process_group()


def _tp_group():
    # world_size=1 default group; all-reduces are no-ops but the group object
    # is required by megatron's fused vocab-parallel cross entropy.
    return dist.distributed_c10d._get_default_group()


def test_with_logsumexp_true_returns_3tuple_matching_torch_logsumexp():
    torch.manual_seed(0)
    logits = torch.randn(2, 10, 100)  # batch=2, seq=10, vocab=100
    tokens = torch.randint(0, 100, (2, 10))
    log_prob, entropy, logsumexp = calculate_log_probs_and_entropy(
        logits, tokens, _tp_group(), with_entropy=True, with_logsumexp=True
    )
    assert logsumexp.shape == (2, 10), f"Got {logsumexp.shape}"
    expected = torch.logsumexp(logits, dim=-1)
    assert torch.allclose(logsumexp, expected, atol=1e-4), "logsumexp mismatch"


def test_with_logsumexp_false_returns_2tuple_backward_compat():
    torch.manual_seed(0)
    logits = torch.randn(2, 10, 100)
    tokens = torch.randint(0, 100, (2, 10))
    # Default (with_logsumexp=False) must keep returning a 2-tuple.
    log_prob, entropy = calculate_log_probs_and_entropy(
        logits, tokens, _tp_group(), with_entropy=True
    )
    log_prob_true, entropy_true, _ = calculate_log_probs_and_entropy(
        logits, tokens, _tp_group(), with_entropy=True, with_logsumexp=True
    )
    # log_prob / entropy must be unchanged regardless of with_logsumexp.
    assert torch.allclose(log_prob, log_prob_true, atol=1e-4)
    assert torch.allclose(entropy, entropy_true, atol=1e-4)


def test_with_logsumexp_false_without_entropy_still_2tuple():
    torch.manual_seed(0)
    logits = torch.randn(2, 10, 100)
    tokens = torch.randint(0, 100, (2, 10))
    log_prob, entropy = calculate_log_probs_and_entropy(logits, tokens, _tp_group())
    assert entropy is None
    assert log_prob.shape[0] == 2


def test_with_logsumexp_true_without_entropy_returns_3tuple():
    torch.manual_seed(0)
    logits = torch.randn(2, 10, 100)
    tokens = torch.randint(0, 100, (2, 10))
    log_prob, entropy, logsumexp = calculate_log_probs_and_entropy(
        logits, tokens, _tp_group(), with_logsumexp=True
    )
    assert entropy is None
    expected = torch.logsumexp(logits, dim=-1)
    assert torch.allclose(logsumexp, expected, atol=1e-4)


def test_get_log_probs_and_entropy_with_logsumexp_adds_key():
    make_parallel_state()
    args = make_args()  # true_on_policy_mode=True, qkv_format="thd"
    vocab = 100
    total, response = 7, 4
    torch.manual_seed(0)
    unconcat_tokens = [torch.randint(0, vocab, (total,))]
    logits = torch.randn(1, total, vocab)
    base = dict(
        args=args,
        unconcat_tokens=unconcat_tokens,
        total_lengths=[total],
        response_lengths=[response],
    )

    res = get_log_probs_and_entropy(logits, **base, with_logsumexp=True)
    assert "logsumexp" in res
    assert "log_probs" in res
    assert res["logsumexp"][0].shape == (response,)
    # get_responses slices logits[start-1:end-1]; start = total - response = 3
    resp_logits = logits[0, total - response - 1 : total - 1, :]  # [4, vocab]
    expected = torch.logsumexp(resp_logits, dim=-1)
    assert torch.allclose(res["logsumexp"][0], expected, atol=1e-4)

    res_no = get_log_probs_and_entropy(logits, **base)
    assert "logsumexp" not in res_no
    assert "log_probs" in res_no
