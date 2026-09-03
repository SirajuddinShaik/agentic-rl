from __future__ import annotations

import pytest

from polar.gateway.engine import SGLangEngine, VLLMEngine, get_engine


def test_get_engine_returns_the_right_strategy() -> None:
    assert isinstance(get_engine("sglang"), SGLangEngine)
    assert isinstance(get_engine("vllm"), VLLMEngine)


def test_get_engine_rejects_unknown_name() -> None:
    with pytest.raises(ValueError, match="Unknown inference engine"):
        get_engine("tgi")


def test_sglang_engine_requests_source_token_extensions() -> None:
    engine = SGLangEngine()
    request = {"messages": []}
    out = engine.prepare_request(request)
    assert out is request and out["logprobs"] is True
    assert out["return_prompt_token_ids"] is True
    assert out["return_meta_info"] is True


def test_sglang_normalize_source_response_to_training_shape() -> None:
    response = {
        "choices": [
            {
                "message": {"role": "assistant", "content": "hi"},
                "prompt_token_ids": [1, 2],
                "logprobs": {
                    "content": [
                        {"token": "h", "logprob": -0.1},
                        {"token": "i", "logprob": -0.2},
                    ]
                },
                "meta_info": {
                    "output_token_logprobs": [
                        [-0.1, 10, "h"],
                        [-0.2, 11, "i"],
                    ]
                },
            }
        ]
    }

    out = SGLangEngine().normalize_response(response)
    choice = out["choices"][0]

    assert choice["input_token_ids"] == [1, 2]
    assert choice["token_ids"] == [10, 11]
    assert [entry["token_id"] for entry in choice["logprobs"]["content"]] == [10, 11]
    assert "meta_info" not in choice


def test_vllm_prepare_request_requests_token_ids_and_logprobs() -> None:
    out = VLLMEngine().prepare_request({"messages": [], "logprobs": True})
    assert out["logprobs"] is True
    assert out["return_token_ids"] is True
    assert out["top_logprobs"] == 0


def test_vllm_prepare_request_keeps_explicit_top_logprobs() -> None:
    out = VLLMEngine().prepare_request({"logprobs": True, "top_logprobs": 5})
    assert out["top_logprobs"] == 5


def test_vllm_prepare_request_forces_logprobs_when_absent() -> None:
    out = VLLMEngine().prepare_request({"messages": []})
    assert out["logprobs"] is True
    assert out["return_token_ids"] is True
    assert out["top_logprobs"] == 0


def test_vllm_normalize_renames_reasoning_to_reasoning_content() -> None:
    response = {
        "choices": [
            {"message": {"role": "assistant", "content": "a", "reasoning": "because"}}
        ]
    }
    message = VLLMEngine().normalize_response(response)["choices"][0]["message"]
    assert message["reasoning_content"] == "because"
    assert "reasoning" not in message


def test_vllm_normalize_keeps_existing_reasoning_content() -> None:
    response = {"choices": [{"message": {"reasoning": "new", "reasoning_content": "kept"}}]}
    message = VLLMEngine().normalize_response(response)["choices"][0]["message"]
    assert message["reasoning_content"] == "kept"


def test_vllm_normalize_without_reasoning_is_noop() -> None:
    response = {"choices": [{"message": {"role": "assistant", "content": "hi"}}]}
    out = VLLMEngine().normalize_response(response)
    assert out["choices"][0]["message"] == {"role": "assistant", "content": "hi"}


def test_vllm_normalize_stamps_token_ids_onto_logprobs() -> None:
    response = {
        "choices": [
            {
                "message": {"role": "assistant", "content": "hi"},
                "token_ids": [10, 11],
                "logprobs": {
                    "content": [
                        {"token": "h", "logprob": -0.1},
                        {"token": "i", "logprob": -0.2},
                    ]
                },
            }
        ]
    }
    content = VLLMEngine().normalize_response(response)["choices"][0]["logprobs"]["content"]
    assert [entry["token_id"] for entry in content] == [10, 11]


def test_vllm_normalize_skips_token_id_stamp_on_length_mismatch() -> None:
    response = {
        "choices": [
            {
                "token_ids": [10, 11, 12],
                "logprobs": {"content": [{"token": "h", "logprob": -0.1}]},
            }
        ]
    }
    content = VLLMEngine().normalize_response(response)["choices"][0]["logprobs"]["content"]
    assert "token_id" not in content[0]


# ---------------------------------------------------------------------------
# FIX E: fail-soft when upstream returns NO logprobs (the grid lane case).
#
# The grid/shim lane returns OpenAI completions without per-token logprobs.
# normalize_response must pass such a response through unchanged instead of
# raising or synthesizing fake signals, so the downstream trace builder and
# reward path still work (reward-0 rather than a crash).
# ---------------------------------------------------------------------------


def test_sglang_normalize_fail_soft_when_no_logprobs_returned() -> None:
    response = {
        "choices": [
            {"message": {"role": "assistant", "content": "hi"}, "finish_reason": "stop"}
        ]
    }
    choice = SGLangEngine().normalize_response(response)["choices"][0]
    # No logprobs, no token ids, no meta_info -> pass-through, nothing stamped.
    assert choice == {
        "message": {"role": "assistant", "content": "hi"},
        "finish_reason": "stop",
    }


def test_sglang_normalize_fail_soft_missing_logprobs_does_not_raise() -> None:
    # Even a bare choice with no logprobs/token_ids/meta must not raise.
    response = {"choices": [{"message": {"content": "x"}}]}
    out = SGLangEngine().normalize_response(response)
    assert out == {"choices": [{"message": {"content": "x"}}]}


def test_vllm_normalize_fail_soft_when_no_logprobs_returned() -> None:
    response = {
        "choices": [
            {"message": {"role": "assistant", "content": "hi"}, "finish_reason": "stop"}
        ]
    }
    out = VLLMEngine().normalize_response(response)
    assert out == response


def test_engine_stamp_is_noop_when_logprobs_missing_but_token_ids_present() -> None:
    # token_ids present but logprobs entirely absent: stamp is a no-op, no crash.
    response = {"choices": [{"token_ids": [5, 6, 7], "message": {"content": "hi"}}]}
    choice = VLLMEngine().normalize_response(response)["choices"][0]
    assert "logprobs" not in choice


# ---------------------------------------------------------------------------
# Grid open-fast shape: float logprobs + token ids only under
# provider_specific_fields (no choice.token_ids / content[].token_id).
# ---------------------------------------------------------------------------


def _grid_open_fast_choice() -> dict:
    """Minimal fixture matching real grid completion dumps (run 63735103)."""
    return {
        "message": {
            "role": "assistant",
            "content": "SEBI fine",
            "provider_specific_fields": {"refusal": None, "reasoning": None},
        },
        "finish_reason": "stop",
        "logprobs": {
            "content": [
                {
                    "token": "SE",
                    "bytes": [83, 69],
                    "logprob": -0.17361369729042053,
                    "top_logprobs": [],
                },
                {
                    "token": "BI",
                    "bytes": [66, 73],
                    "logprob": -2.3841855067985307e-07,
                    "top_logprobs": [],
                },
                {
                    "token": " fine",
                    "bytes": [32, 102, 105, 110, 101],
                    "logprob": -0.44629305601119995,
                    "top_logprobs": [],
                },
            ]
        },
        "provider_specific_fields": {"token_ids": [6204, 13111, 8209]},
    }


def test_vllm_normalize_lifts_grid_provider_specific_token_ids() -> None:
    response = {"choices": [_grid_open_fast_choice()], "prompt_token_ids": [1, 2, 3]}
    choice = VLLMEngine().normalize_response(response)["choices"][0]
    assert choice["token_ids"] == [6204, 13111, 8209]
    assert [e["token_id"] for e in choice["logprobs"]["content"]] == [6204, 13111, 8209]


def test_sglang_normalize_lifts_grid_provider_specific_token_ids() -> None:
    # Same lift path if the gateway is configured engine=sglang against a
    # grid-shaped upstream (defensive; test lane uses vllm).
    response = {"choices": [_grid_open_fast_choice()]}
    choice = SGLangEngine().normalize_response(response)["choices"][0]
    assert choice["token_ids"] == [6204, 13111, 8209]
    assert [e["token_id"] for e in choice["logprobs"]["content"]] == [6204, 13111, 8209]


def test_vllm_normalize_grid_shape_feeds_trajectory_extractor() -> None:
    from polar.trajectory.builder.record_utils import build_trace_from_completion
    from polar.trajectory.models import CompletionRecord

    raw = {
        "choices": [_grid_open_fast_choice()],
        "prompt_token_ids": [10, 20],
    }
    normalized = VLLMEngine().normalize_response(raw)
    trace = build_trace_from_completion(
        CompletionRecord(
            completion_id="c-grid",
            request={"messages": [{"role": "user", "content": "q"}]},
            response=normalized,
        )
    )
    assert trace.response_ids == [6204, 13111, 8209]
    assert trace.response_logprobs == [
        -0.17361369729042053,
        -2.3841855067985307e-07,
        -0.44629305601119995,
    ]
    assert sum(trace.loss_mask) == 3


def test_vllm_normalize_psf_length_mismatch_lifts_ids_skips_stamp(
    caplog: pytest.LogCaptureFixture,
) -> None:
    choice = _grid_open_fast_choice()
    choice["provider_specific_fields"]["token_ids"] = [6204, 13111]  # shorter
    response = {"choices": [choice]}
    with caplog.at_level("WARNING"):
        out = VLLMEngine().normalize_response(response)["choices"][0]
    assert out["token_ids"] == [6204, 13111]
    assert "token_id" not in out["logprobs"]["content"][0]
    assert any("length mismatch" in r.message for r in caplog.records)


def test_vllm_normalize_does_not_overwrite_existing_token_ids() -> None:
    choice = _grid_open_fast_choice()
    choice["token_ids"] = [1, 2, 3]
    out = VLLMEngine().normalize_response({"choices": [choice]})["choices"][0]
    assert out["token_ids"] == [1, 2, 3]
    assert [e["token_id"] for e in out["logprobs"]["content"]] == [1, 2, 3]


def test_vllm_normalize_psf_bad_ids_fail_soft() -> None:
    choice = _grid_open_fast_choice()
    choice["provider_specific_fields"]["token_ids"] = [6204, "nope", 8209]
    out = VLLMEngine().normalize_response({"choices": [choice]})["choices"][0]
    assert "token_ids" not in out
    assert "token_id" not in out["logprobs"]["content"][0]
