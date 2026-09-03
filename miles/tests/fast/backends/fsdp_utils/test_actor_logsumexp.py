"""Task 9: ref-model logsumexp in FSDP `_compute_log_prob` + action_masks in training get_batch keys.

Importing ``miles.backends.fsdp_utils.actor`` pulls heavy deps (megatron/torch), so these tests
inspect the source text directly (the plan's agent-executable acceptance criterion is a grep/ast
check: ``grep -n 'with_logsumexp\\|ref_logsumexp\\|action_masks' .../actor.py``).
"""

import ast
import inspect
from pathlib import Path

ACTOR_PATH = Path(__file__).resolve().parents[4] / "miles" / "backends" / "fsdp_utils" / "actor.py"


def _actor_source() -> str:
    return ACTOR_PATH.read_text()


def _function_source(name: str) -> str:
    """Extract the source of the function `name` from the actor module via ast to_line/end_lineno."""
    module = ast.parse(_actor_source())
    for node in ast.walk(module):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            lines = _actor_source().splitlines()
            return "\n".join(lines[node.lineno - 1 : node.end_lineno])
    raise AssertionError(f"function {name!r} not found in actor.py")


def test_compute_log_prob_enables_ref_logsumexp():
    """`with_logsumexp=(store_prefix == "ref_")` must be present in _compute_log_prob."""
    src = _function_source("_compute_log_prob")
    assert "with_logsumexp=(store_prefix == \"ref_\")" in src, (
        "with_logsumexp=(store_prefix == 'ref_') missing from get_log_probs_and_entropy call"
    )


def test_logsumexp_storage_added():
    """Ref logsumexp must be stored as f'{store_prefix}logsumexp' mirroring log_probs."""
    src = _function_source("_compute_log_prob")
    assert "if \"logsumexp\" in result:" in src, "logsumexp presence guard missing"
    assert 'batch_result[f"{store_prefix}logsumexp"] = result["logsumexp"]' in src, (
        "logsumexp storage line missing"
    )


def test_training_get_batch_has_action_masks_and_ref_logsumexp():
    """The training get_batch() key list must contain both action_masks and ref_logsumexp."""
    src = _actor_source()
    assert '"action_masks"' in src, "action_masks missing from training get_batch keys"
    assert '"ref_logsumexp"' in src, "ref_logsumexp missing from training get_batch keys"


def test_action_masks_only_in_training_not_forward_only():
    """action_masks must appear once — in the training get_batch call, not the forward-only call."""
    src = _actor_source()
    # Exactly one occurrence of the action_masks key string in the whole file (both calls would be 2).
    assert src.count('"action_masks"') == 1, (
        "action_masks key should appear exactly once (training get_batch only), "
        f"found {src.count('\"action_masks\"')}"
    )


def test_actor_file_ast_parses():
    """Sanity: the actor module still parses (no syntax errors introduced)."""
    ast.parse(_actor_source())
