p = "src/polar/trajectory/builder/record_utils.py"
s = open(p).read()

helpers = '''

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

'''

anchor = "def build_trace_from_completion(completion: CompletionRecord) -> Trace:"
assert anchor in s
s = s.replace(anchor, helpers + "\n" + anchor)

old_body = '''    response_ids, response_logprobs = _extract_response_tokens(response, first_choice)

    return Trace(
        prompt_ids=list(prompt_ids) if isinstance(prompt_ids, list) else [],
        response_ids=response_ids,
        loss_mask=[1] * len(response_ids),'''
new_body = '''    response_ids, response_logprobs = _extract_response_tokens(response, first_choice)

    prompt_id_list = list(prompt_ids) if isinstance(prompt_ids, list) else []
    if not prompt_id_list:
        prompt_id_list = _fallback_prompt_ids(request)
    if not response_ids and isinstance(response_message, dict):
        response_ids, response_logprobs = _fallback_response_tokens(response_message)

    return Trace(
        prompt_ids=prompt_id_list,
        response_ids=response_ids,
        loss_mask=[1] * len(response_ids),'''
assert old_body in s
s = s.replace(old_body, new_body)
open(p, "w").write(s)
print("patched OK")
