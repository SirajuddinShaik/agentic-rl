"""Source-level checks for Task 10: ref-model logsumexp in Megatron forward_only.

These are grep/ast-based assertions on ``miles/backends/megatron_utils/model.py``
rather than import/unit tests, because importing that module pulls heavy
dependencies (torch/megatron). The checks verify:

* ``forward_only()`` passes ``with_logsumexp=(store_prefix == "ref_")`` to the
  ``partial(f, ...)`` callback so the ref model emits a ``"logsumexp"`` key
  (stored as ``"ref_logsumexp"`` via the ``f"{store_prefix}{key}"`` prefixing).
* The training-step ``get_batch()`` call requests ``action_masks`` and
  ``ref_logsumexp`` (added after ``ref_log_probs``).
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

_MODEL_PATH = Path(
    "miles/backends/megatron_utils/model.py"
).resolve()


@pytest.fixture(scope="module")
def model_source() -> str:
    assert _MODEL_PATH.exists(), f"expected model.py at {_MODEL_PATH}"
    return _MODEL_PATH.read_text(encoding="utf-8")


def _extract_function(source: str, name: str) -> ast.FunctionDef:
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError(f"could not find function {name!r} in {_MODEL_PATH}")


def _collect_key_lists(calls: list[ast.Call]) -> list[str]:
    """Collect the string keys from the list args across get_batch calls.

    get_batch(data_iterator, [keys, ...], ...) places the key list as the
    second positional argument, so scan all positional args for the list.
    """
    keys: list[str] = []
    for call in calls:
        if not call.args:
            continue
        for arg in call.args:
            if isinstance(arg, ast.List):
                for elt in arg.elts:
                    if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                        keys.append(elt.value)
    return keys


def test_forward_only_partial_passes_with_logsumexp_for_ref(model_source: str) -> None:
    """forward_only's partial() must enable logsumexp only for the ref model."""
    func = _extract_function(model_source, "forward_only")
    # Locate the partial(f, ...) call passed as the post-forward callback.
    partial_calls = [
        node
        for node in ast.walk(func)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "partial"
    ]
    assert partial_calls, "expected a partial(...) call in forward_only()"

    kw_names = {kw.arg for call in partial_calls for kw in call.keywords}
    assert "with_logsumexp" in kw_names, (
        "with_logsumexp keyword missing from forward_only() partial() args"
    )

    # Guard against a literal True/False: it must be tied to the ref prefix.
    for call in partial_calls:
        for kw in call.keywords:
            if kw.arg == "with_logsumexp":
                code = ast.get_source_segment(model_source, kw.value)
                assert code is not None
                assert "store_prefix" in code and "ref_" in code, (
                    f"with_logsumexp must compare store_prefix to 'ref_', got: {code}"
                )


def test_training_get_batch_keys_contain_action_masks_and_ref_logsumexp(
    model_source: str,
) -> None:
    """Training-step get_batch() must request action_masks and ref_logsumexp."""
    func = _extract_function(model_source, "train_one_step")

    calls = [
        node
        for node in ast.walk(func)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "get_batch"
    ]
    assert calls, "expected a get_batch(...) call in train_one_step()"

    keys: list[str] = _collect_key_lists(calls)

    assert "action_masks" in keys, "action_masks missing from training get_batch keys"
    assert "ref_logsumexp" in keys, "ref_logsumexp missing from training get_batch keys"
    # ref_logsumexp should be requested after ref_log_probs.
    assert keys.index("ref_log_probs") < keys.index("ref_logsumexp")


def test_forward_only_get_batch_does_not_request_action_masks(model_source: str) -> None:
    """The forward-only get_batch() call must be left unchanged (no action_masks)."""
    func = _extract_function(model_source, "forward_only")
    calls = [
        node
        for node in ast.walk(func)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "get_batch"
    ]
    assert calls, "expected a get_batch(...) call in forward_only()"

    keys = _collect_key_lists(calls)

    assert "action_masks" not in keys, (
        "forward_only get_batch() must NOT request action_masks "
        "(only the training path adds it)"
    )
    assert "ref_logsumexp" not in keys
