import unittest
from types import SimpleNamespace

from miles.rollout.polar_adapter import (
    _action_mask_from_trace,
    _build_sample,
    _ACTION_START_MARKER,
    _ACTION_START_PREFIX,
    _ACTION_END_MARKER,
)
from miles.utils.types import Sample


class MockTokenizer:
    """Simulates a BPE tokenizer over the DSML tool-call boundary markers."""

    def __init__(self):
        self._ids = {
            _ACTION_START_MARKER: [10, 11],
            _ACTION_END_MARKER: [20, 21],
            _ACTION_START_PREFIX: [10, 12],
        }

    def encode(self, text, add_special_tokens=False):
        return self._ids[text]


class ActionMaskFromTraceTests(unittest.TestCase):

    def test_marks_action_tokens_inside_dsml_span(self):
        # response: [reasoning][START 10,11][body 50,51][END 20,21][reasoning]
        trace = SimpleNamespace(
            response_ids=[1, 2, 3, 10, 11, 50, 51, 20, 21, 4],
            loss_mask=[1] * 10,
        )
        mask = _action_mask_from_trace(
            trace, 10, tokenizer=MockTokenizer(), session_id="s", trace_index=0
        )
        self.assertEqual(mask, [0, 0, 0, 1, 1, 1, 1, 1, 1, 0])

    def test_no_tool_call_markers_yields_all_zeros(self):
        trace = SimpleNamespace(response_ids=[1, 2, 3], loss_mask=[1, 1, 1])
        mask = _action_mask_from_trace(
            trace, 3, tokenizer=MockTokenizer(), session_id="s", trace_index=0
        )
        self.assertEqual(mask, [0, 0, 0])

    def test_missing_tokenizer_degrades_to_all_zeros(self):
        trace = SimpleNamespace(response_ids=[1, 2, 3], loss_mask=[1, 1, 1])
        mask = _action_mask_from_trace(
            trace, 3, tokenizer=None, session_id="s", trace_index=0
        )
        self.assertEqual(mask, [0, 0, 0])

    def test_empty_response_returns_empty_mask(self):
        trace = SimpleNamespace(response_ids=[], loss_mask=[])
        mask = _action_mask_from_trace(
            trace, 0, tokenizer=MockTokenizer(), session_id="s", trace_index=0
        )
        self.assertEqual(mask, [])

    def test_build_sample_threads_action_mask_into_sample(self):
        # response: [reasoning][START][body][END][reasoning] -> action span marked
        response_ids = [1, 2, 10, 11, 50, 20, 21, 3]
        trace = SimpleNamespace(
            prompt_ids=[0],
            response_ids=response_ids,
            prompt_messages=[],
            response_messages=[],
            loss_mask=[1] * len(response_ids),
            response_logprobs=[-0.1] * len(response_ids),
            finish_reason="stop",
            metadata={},
            reward=0.5,
        )
        result = SimpleNamespace(
            session_id="s",
            status="completed",
            node_id="node-0",
            task_id="task-0",
            error=None,
            metadata={},
            timing=SimpleNamespace(model_dump=lambda mode="python": {}),
            trajectory=SimpleNamespace(
                status="completed", error=None, metadata={}
            ),
        )
        sample = _build_sample(
            Sample=Sample,
            result=result,
            trace=trace,
            trace_index=0,
            group_index=0,
            index=0,
            reward_key="score",
            tokenizer=MockTokenizer(),
        )
        self.assertIsNotNone(sample)
        self.assertEqual(
            sample.action_mask,
            [0, 0, 1, 1, 1, 1, 1, 0],
        )
        self.assertEqual(len(sample.action_mask), sample.response_length)


if __name__ == "__main__":
    unittest.main()
