"""Tests for action_masks threading through training_utils.data.

Covers:
- get_rollout_data: action_masks -> GPU int tensors (mirrors loss_masks);
  graceful absence when the key is missing.
- get_batch: action_masks processed identically to loss_masks (pad + CP slice
  + concat/stack) so full_action_masks matches full_loss_masks; graceful absence.

CUDA is stubbed to run on CPU, mirroring the pattern in
test_get_batch_multi_lora_cp.py.
"""

from types import SimpleNamespace

import pytest
import torch

import miles.backends.training_utils.data as data_mod
from miles.backends.training_utils.data import get_batch, get_rollout_data


class _ParallelState:
    def __init__(self):
        self.effective_dp = SimpleNamespace(rank=0, size=1)
        self.tp = SimpleNamespace(size=1)
        self.cp = SimpleNamespace(rank=0, size=2)


class _FakeIterator:
    def __init__(self, batch, n_adapters=1):
        self._batch = batch
        self.rollout_data = {"n_adapters": n_adapters}

    def get_next(self, keys):
        return {key: self._batch.get(key, None) for key in keys}


@pytest.fixture(autouse=True)
def _stub_cuda(monkeypatch):
    monkeypatch.setattr(torch.Tensor, "cuda", lambda self, *args, **kwargs: self, raising=False)
    monkeypatch.setattr(torch.cuda, "current_device", lambda: "cpu", raising=False)


def _make_args() -> SimpleNamespace:
    return SimpleNamespace(
        enable_witness=False,
        qkv_format="thd",
        data_pad_size_multiplier=1,
        compress_ratios=[],
        true_on_policy_mode=False,
        bf16=False,
    )


def _make_rollout_data(action_masks=None) -> dict:
    rd = {
        "tokens": [[1, 2, 3], [4, 5]],
        "loss_masks": [[1, 0, 1], [1, 1]],
        "total_lengths": [3, 2],
        "response_lengths": [3, 2],
    }
    if action_masks is not None:
        rd["action_masks"] = action_masks
    return rd


def _patch_parallel_state(monkeypatch, state=None) -> _ParallelState:
    ps = state or _ParallelState()
    monkeypatch.setattr(data_mod, "get_parallel_state", lambda: ps)
    return ps


# --------------------------------------------------------------------------- #
# get_rollout_data
# --------------------------------------------------------------------------- #


def _patch_process_rollout_data(monkeypatch, rollout_data) -> object:
    marker = object()
    monkeypatch.setattr(data_mod, "process_rollout_data", lambda *a, **k: (rollout_data, marker))
    return marker


def test_rollout_data_converts_action_masks_to_gpu_int(monkeypatch):
    _patch_parallel_state(monkeypatch)
    rd = _make_rollout_data(action_masks=[[1, 0, 1], [1, 1]])
    _patch_process_rollout_data(monkeypatch, rd)
    args = _make_args()

    out, _ = get_rollout_data(args, None)

    assert "action_masks" in out
    assert all(isinstance(m, torch.Tensor) for m in out["action_masks"])
    assert all(m.dtype == torch.int for m in out["action_masks"])
    assert [m.tolist() for m in out["action_masks"]] == [[1, 0, 1], [1, 1]]


def test_rollout_data_action_masks_absent_is_graceful(monkeypatch):
    _patch_parallel_state(monkeypatch)
    rd = _make_rollout_data()  # no action_masks
    _patch_process_rollout_data(monkeypatch, rd)
    args = _make_args()

    out, _ = get_rollout_data(args, None)

    assert "action_masks" not in out


# --------------------------------------------------------------------------- #
# get_batch
# --------------------------------------------------------------------------- #

LENGTHS = [7, 13, 5, 9, 4]


def _make_batch(include_action_masks: bool, max_seqlen: int | None = None) -> dict:
    tokens = [torch.arange(1, length + 1, dtype=torch.long) for length in LENGTHS]
    response_lengths = [max(1, length // 2) for length in LENGTHS]
    loss_masks = [torch.ones(r, dtype=torch.int) for r in response_lengths]
    batch = {
        "tokens": tokens,
        "loss_masks": loss_masks,
        "total_lengths": list(LENGTHS),
        "response_lengths": response_lengths,
    }
    if include_action_masks:
        # action_masks mirrors loss_masks (binary int per response token) so the
        # pad+CP output must match full_loss_masks exactly.
        batch["action_masks"] = [m.clone() for m in loss_masks]
    if max_seqlen is not None:
        batch["max_seq_lens"] = [max_seqlen] * len(LENGTHS)
    return batch


def _patch_batch_state(monkeypatch) -> None:
    # get_batch and cp_utils.slice_with_cp each resolve the state themselves.
    import miles.backends.training_utils.cp_utils as cp_utils_mod

    state = _ParallelState()
    monkeypatch.setattr(data_mod, "get_parallel_state", lambda: state)
    monkeypatch.setattr(cp_utils_mod, "get_parallel_state", lambda: state)
    return state


def test_batch_thd_action_masks_match_loss_masks(monkeypatch):
    _patch_batch_state(monkeypatch)
    keys = ["tokens", "loss_masks", "action_masks", "total_lengths", "response_lengths"]

    out = get_batch(_FakeIterator(_make_batch(True)), keys, pad_multiplier=8, qkv_format="thd")

    assert "full_action_masks" in out
    assert out["full_action_masks"].shape == out["full_loss_masks"].shape
    assert torch.equal(out["full_action_masks"], out["full_loss_masks"])


def test_batch_bshd_action_masks_match_loss_masks(monkeypatch):
    _patch_batch_state(monkeypatch)
    max_seqlen = 16
    keys = ["tokens", "loss_masks", "action_masks", "total_lengths", "response_lengths", "max_seq_lens"]

    out = get_batch(
        _FakeIterator(_make_batch(True, max_seqlen=max_seqlen)),
        keys,
        pad_multiplier=8,
        qkv_format="bshd",
    )

    assert "full_action_masks" in out
    assert out["full_action_masks"].shape == out["full_loss_masks"].shape
    assert torch.equal(out["full_action_masks"], out["full_loss_masks"])


def test_batch_action_masks_absent_is_graceful(monkeypatch):
    _patch_batch_state(monkeypatch)
    keys = ["tokens", "loss_masks", "total_lengths", "response_lengths"]

    out = get_batch(_FakeIterator(_make_batch(False)), keys, pad_multiplier=8, qkv_format="thd")

    assert "full_action_masks" not in out
    assert "full_loss_masks" in out  # loss_masks processing is untouched
