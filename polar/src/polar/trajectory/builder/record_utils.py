"""Helpers for converting completion records into trajectory traces."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from polar.trajectory.models import CompletionRecord, Trace


def _coerce_int_list(value: Any) -> list[int] | None:
    if not isinstance(value, list):
        return None
    extracted: list[int] = []
    for item in value:
        try:
            extracted.append(int(item))
        except (TypeError, ValueError):
            return None
    return extracted


def _paired_tokens_from_logprobs_content(
    choice: dict[str, Any],
) -> tuple[list[int], list[float]] | None:
    logprobs = choice.get("logprobs")
    if not isinstance(logprobs, dict):
        return None
    content = logprobs.get("content")
    if not isinstance(content, list) or not content:
        return None

    token_ids: list[int] = []
    token_logprobs: list[float] = []
    for item in content:
        if not isinstance(item, dict):
            return None
        token_id = item.get("token_id")
        logprob = item.get("logprob")
        if token_id is None or logprob is None:
            return None
        try:
            token_ids.append(int(token_id))
            token_logprobs.append(float(logprob))
        except (TypeError, ValueError):
            return None
    return token_ids, token_logprobs


def _paired_tokens_from_sglang_meta(
    choice: dict[str, Any],
) -> tuple[list[int], list[float]] | None:
    meta_info = choice.get("meta_info")
    if not isinstance(meta_info, dict):
        return None
    output_logprobs = meta_info.get("output_token_logprobs")
    if not isinstance(output_logprobs, list) or not output_logprobs:
        return None

    token_ids: list[int] = []
    token_logprobs: list[float] = []
    for item in output_logprobs:
        token_id = None
        logprob = None
        if isinstance(item, (list, tuple)) and len(item) >= 2:
            logprob = item[0]
            token_id = item[1]
        elif isinstance(item, dict):
            token_id = item.get("token_id")
            logprob = item.get("logprob", item.get("token_logprob"))

        if token_id is None or logprob is None:
            return None
        try:
            token_ids.append(int(token_id))
            token_logprobs.append(float(logprob))
        except (TypeError, ValueError):
            return None
    return token_ids, token_logprobs


def _extract_response_tokens(
    response: dict[str, Any],
    choice: dict[str, Any],
) -> tuple[list[int], list[float] | None]:
    """Extract response ids and logprobs without mixing unaligned sources."""
    token_ids = choice.get("token_ids", response.get("token_ids"))
    response_ids = _coerce_int_list(token_ids)
    paired_candidates = (
        _paired_tokens_from_logprobs_content(choice),
        _paired_tokens_from_sglang_meta(choice),
    )

    if response_ids is not None:
        for paired in paired_candidates:
            if paired is None:
                continue
            paired_ids, paired_logprobs = paired
            if paired_ids == response_ids:
                return response_ids, paired_logprobs
        return response_ids, None

    for paired in paired_candidates:
        if paired is not None:
            return paired

    return [], None


def _extract_prompt_messages(request: dict[str, Any]) -> list[dict[str, Any]]:
    messages = request.get("messages")
    if not isinstance(messages, list):
        return []
    return [deepcopy(message) for message in messages if isinstance(message, dict)]


def _extract_tools(request: dict[str, Any]) -> list[dict[str, Any]] | None:
    tools = request.get("tools")
    if not isinstance(tools, list) or not tools:
        return None
    extracted = [deepcopy(tool) for tool in tools if isinstance(tool, dict)]
    return extracted or None




# --- Tokenizer fallback (engine-omitted token ids) ---------------------------
_FALLBACK_TOKENIZER = None
_FALLBACK_TOKENIZER_PATH = "/data/siraj/hf_models/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16"
_EOT_TOKEN_ID = 11


def _get_fallback_tokenizer():
    global _FALLBACK_TOKENIZER
    if _FALLBACK_TOKENIZER is not None:
        return _FALLBACK_TOKENIZER
    try:
        import inspect
        if not hasattr(inspect, "signature"):
            import importlib
            importlib.reload(inspect)
        from transformers import AutoTokenizer
        _FALLBACK_TOKENIZER = AutoTokenizer.from_pretrained(
            _FALLBACK_TOKENIZER_PATH, trust_remote_code=True
        )
    except Exception as exc:
        logger.warning("tokenizer fallback unavailable: %s", exc)
        _FALLBACK_TOKENIZER = False
    return _FALLBACK_TOKENIZER


def _fallback_prompt_ids(request):
    tok = _get_fallback_tokenizer()
    if not tok:
        return []
    messages = request.get("messages")
    if not isinstance(messages, list) or not messages:
        return []
    try:
        text = tok.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True, tools=request.get("tools")
        )
        if isinstance(text, str):
            return tok(text, add_special_tokens=False)["input_ids"]
    except Exception:
        pass
    return []


def _fallback_response_tokens(message):
    tok = _get_fallback_tokenizer()
    if not tok:
        return [], None
    parts = []
    content = message.get("content")
    if content:
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and isinstance(item.get("text"), str):
                    parts.append(item["text"])
    for tc in (message.get("tool_calls") or []):
        fn = tc.get("function") if isinstance(tc, dict) else None
        if not isinstance(fn, dict):
            continue
        args = fn.get("arguments")
        if isinstance(args, str):
            parts.append(args)
    text = "".join(parts)
    try:
        ids = tok(text, add_special_tokens=False)["input_ids"]
    except Exception:
        return [], None
    if ids and ids[-1] != _EOT_TOKEN_ID:
        ids = ids + [_EOT_TOKEN_ID]
    return ids, [0.0] * len(ids)


def build_trace_from_completion(completion: CompletionRecord) -> Trace:
    """Normalize one stored completion record into a trajectory trace."""

    request = completion.request if isinstance(completion.request, dict) else {}
    response = completion.response if isinstance(completion.response, dict) else {}
    choices = response.get("choices")
    first_choice = (
        choices[0]
        if isinstance(choices, list) and choices and isinstance(choices[0], dict)
        else {}
    )
    prompt_ids = (
        first_choice.get("input_token_ids")
        or first_choice.get("prompt_token_ids")
        or response.get("prompt_token_ids")
    )
    response_message = first_choice.get("message")
    finish_reason = first_choice.get("finish_reason")

    response_ids, response_logprobs = _extract_response_tokens(response, first_choice)

    prompt_id_list = list(prompt_ids) if isinstance(prompt_ids, list) else []
    if not prompt_id_list:
        prompt_id_list = _fallback_prompt_ids(request)
    if not response_ids and isinstance(response_message, dict):
        response_ids, response_logprobs = _fallback_response_tokens(response_message)

    return Trace(
        prompt_ids=prompt_id_list,
        response_ids=response_ids,
        loss_mask=[1] * len(response_ids),
        prompt_messages=_extract_prompt_messages(request),
        response_messages=[deepcopy(response_message)] if isinstance(response_message, dict) else [],
        tools=_extract_tools(request),
        finish_reason=str(finish_reason) if finish_reason is not None else None,
        response_logprobs=response_logprobs,
        metadata=deepcopy(completion.metadata),
    )
