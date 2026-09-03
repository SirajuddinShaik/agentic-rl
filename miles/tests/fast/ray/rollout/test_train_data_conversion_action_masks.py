from __future__ import annotations

from tests.fast.ray.rollout.conftest import make_args, make_sample

from miles.ray.rollout.train_data_conversion import (
    ROLLOUT_DATA_TENSOR_DTYPES,
    convert_samples_to_train_data,
)


class TestActionMasksDtype:
    def test_dtype_dict_includes_action_masks_as_int32(self):
        assert "action_masks" in ROLLOUT_DATA_TENSOR_DTYPES
        assert ROLLOUT_DATA_TENSOR_DTYPES["action_masks"] == "int32"


class TestConvertActionMasks:
    def test_action_mask_set_is_included_in_train_data(self):
        args = make_args(rewards_normalization=False)
        action_masks = [[1, 0, 1, 0], [0, 1, 0, 1]]
        samples = [
            make_sample(response_length=4, action_mask=action_masks[0]),
            make_sample(index=1, response_length=4, action_mask=action_masks[1]),
        ]
        out = convert_samples_to_train_data(
            args,
            samples,
            metadata={},
            custom_convert_samples_to_train_data_func=None,
            custom_reward_post_process_func=None,
        )
        assert out["action_masks"] == action_masks

    def test_action_mask_none_absent_from_train_data(self):
        args = make_args(rewards_normalization=False)
        samples = [
            make_sample(response_length=4, action_mask=None),
            make_sample(index=1, response_length=4, action_mask=None),
        ]
        out = convert_samples_to_train_data(
            args,
            samples,
            metadata={},
            custom_convert_samples_to_train_data_func=None,
            custom_reward_post_process_func=None,
        )
        assert "action_masks" not in out
