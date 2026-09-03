from pathlib import Path
import importlib.util

import yaml
import gzip
import json
import subprocess
import sys


REPO_ROOT = Path(__file__).resolve().parents[1]
CONFIG = REPO_ROOT / "configs/polar/polar_config_v34.yaml"
LAUNCHER = REPO_ROOT / "runs/launch_xyne_v34_current.sh"
DUMP_AUDITOR = REPO_ROOT / "tools/reward/audit_current_dumps.py"
SESSION_PROXY = REPO_ROOT / "polar-pkg/polar/xyne/session_proxy.py"
HARNESS = REPO_ROOT / "polar-pkg/polar/xyne/harness.py"


class StrictLoader(yaml.SafeLoader):
    pass


def _construct_mapping(loader, node, deep=False):
    mapping = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise ValueError(f"duplicate YAML key: {key}")
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


StrictLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _construct_mapping)


def test_current_polar_config_contract():
    config = yaml.safe_load(CONFIG.read_text())

    assert config["polar_max_async_level"] == 32
    assert config["polar_microbatch_idle_timeout"] == 1800
    assert config["polar_request_timeout"] == 7200
    assert config["polar_min_complete_accept_fraction"] == 0.125
    assert config["polar_task_template"]["agent"]["model_name"] == "nemotron"
    assert config["polar_task_template"]["agent"]["env"]["HOST"] == "http://localhost:3103"
    assert config["polar_task_template"]["agent"]["env"]["LITELLM_BASE_URL"] == "http://127.0.0.1:18114"
    assert config["polar_task_template"]["timeout_seconds"] == 7200
    assert config["polar_task_template"]["group_reward"]["strategy"] == "best_answer_and_mi"

    judge = config["polar_task_template"]["evaluator"]["config"]["judge"]
    assert judge["max_tokens"] == "${XYNE_JUDGE_MAX_TOKENS}"
    assert judge["max_concurrency"] == "${XYNE_JUDGE_MAX_CONCURRENCY}"
    assert judge["dimension_weights"] == {
        "quality": 1.0,
        "correctness": 2.0,
        "groundedness": 1.5,
        "citation_accuracy": 1.5,
    }


def test_current_polar_config_rejects_duplicate_keys():
    # safe_load silently accepts duplicate keys; use the strict loader to lock
    # the single microbatch-idle timeout fix.
    yaml.load(CONFIG.read_text(), Loader=StrictLoader)


def test_current_launcher_uses_v34_training_contract():
    launcher = LAUNCHER.read_text()

    for required in (
        "--rollout-max-response-len 60000",
        "--rollout-max-prompt-len 60000",
        "--max-tokens-per-gpu 20000",
        "--sglang-context-length 80000",
        "--sglang-max-prefill-tokens 80000",
        "--distributed-timeout-minutes 480",
        "--sglang-reasoning-parser nemotron_3",
        "--sglang-tool-call-parser qwen3_coder",
        "--sglang-served-model-name nemotron",
        "--lora-a-init-method xavier",
        "--lora-b-init-method zero",
    ):
        assert required in launcher

    for forbidden in (
        "--true-on-policy-mode",
        "--recompute-logprobs-via-prefill",
        "--sglang-disable-cuda-graph",
    ):
        assert forbidden not in launcher

    assert '--sglang-chat-template "${SGLANG_CHAT_TEMPLATE}"' in launcher
    assert "--train-env-vars" in launcher
    assert '"WANDB_API_KEY": os.environ["WANDB_API_KEY"]' in launcher
    assert "RAY_RUNTIME_ENV=\"" in launcher


def test_current_launcher_has_no_embedded_credentials():
    launcher = LAUNCHER.read_text()
    config = CONFIG.read_text()

    assert "wandb_v1_" not in launcher
    assert "eyJhbGciOi" not in launcher + config
    assert "ACCESS_TOKEN_SECRET:?Set" in launcher
    assert "--wandb-key" not in launcher


def test_current_config_quotes_secret_placeholders():
    config = CONFIG.read_text()
    for placeholder in (
        "XYNE_API_KEY",
        "JUSPAY_API_KEY",
        "WANDB_API_KEY",
        "ACCESS_TOKEN_SECRET",
        "XYNE_ACCESS_TOKEN",
        "XYNE_AUTH_WORKSPACE",
        "DATABASE_URL",
        "JWT_SECRET",
    ):
        assert f'"${{{placeholder}}}"' in config


def _load_session_proxy():
    spec = importlib.util.spec_from_file_location("current_session_proxy", SESSION_PROXY)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_session_proxy_keeps_tool_streaming_and_guards_tokens():
    proxy = _load_session_proxy()

    tool_request = json.dumps(
        {
            "stream": True,
            "stream_options": {"include_usage": True},
            "max_tokens": 60000,
            "tools": [{"type": "function", "function": {"name": "vespaSearch"}}],
        }
    ).encode()
    body, want_stream, tools_stream = proxy.rewrite_chat_request(tool_request)
    rewritten = json.loads(body)
    assert want_stream is True
    assert tools_stream is True
    assert rewritten["stream"] is True
    assert rewritten["max_tokens"] == 16384
    assert "stream_options" not in rewritten

    plain_request = json.dumps({"stream": True, "max_tokens": None}).encode()
    body, want_stream, tools_stream = proxy.rewrite_chat_request(plain_request)
    rewritten = json.loads(body)
    assert want_stream is True
    assert tools_stream is False
    assert rewritten["stream"] is False
    assert rewritten["max_tokens"] == 16384


def test_session_proxy_synthesizes_tool_call_deltas():
    proxy = _load_session_proxy()
    completion = json.dumps(
        {
            "id": "chatcmpl-test",
            "model": "nemotron",
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call-test",
                                "type": "function",
                                "function": {
                                    "name": "vespaSearch",
                                    "arguments": "{\"query\":\"test\"}",
                                },
                            }
                        ],
                    },
                }
            ],
        }
    ).encode()
    sse = proxy.synth_sse(completion)
    assert sse is not None
    text = sse.decode()
    assert "data: [DONE]" in text
    assert '"tool_calls"' in text
    assert '"vespaSearch"' in text


def test_polar_runtime_copies_are_synchronized():
    for relative in (
        "harness.py",
        "session_proxy.py",
        "evaluator.py",
        "scorers/llm_judge.py",
    ):
        source = (REPO_ROOT / "polar/src/polar/xyne" / relative).read_bytes()
        installed = (REPO_ROOT / "polar-pkg/polar/xyne" / relative).read_bytes()
        miles_runtime = (REPO_ROOT / "miles/polar-pkg/polar/xyne" / relative).read_bytes()
        assert source == installed == miles_runtime

    harness = HARNESS.read_text()
    assert "18113" not in harness
    assert "POLAR_SESSION_PROXY_PORT" in harness
    assert "LITELLM_BASE_URL must point to the local Polar session proxy" in harness


def test_session_proxy_start_script_is_isolated_and_idempotent():
    start_script = REPO_ROOT / "scripts/servers/start_session_proxy_v34.sh"
    text = start_script.read_text()

    assert start_script.stat().st_mode & 0o111
    assert "already healthy" in text
    assert "runtime_proxy_script=" in text
    assert "cp \"${proxy_script}\" \"${runtime_proxy_script}\"" in text
    assert "cannot shadow" in text


def test_dump_auditor_validates_current_dump_contract(tmp_path):
    records = [
        {
            "session_id": "session-a",
            "status": "completed",
            "finish_reason": "stop",
            "reward": {"score": 0.75},
            "tokens": [1, 2, 3],
            "trainable_token_count": 2,
            "response_length": 2,
            "judge_io": {"llm_judge": {"quality": {"input": {"body": {"max_tokens": 16384}}}}},
            "polar_metadata": {
                "trajectory_metadata": {
                    "xyne_raw": {
                        "tool_calls": [{"name": "vespaSearch"}],
                        "citations": [{"docId": "doc"}],
                        "thinking": [{"content": "reason"}],
                        "retrieved_chunks": [{"docId": "doc"}],
                    }
                }
            },
        },
        {
            "session_id": "session-a",
            "status": "truncated",
            "finish_reason": "length",
            "reward": {"score": 0.25},
            "tokens": [4, 5],
            "trainable_token_count": 2,
            "response_length": 2,
            "judge_io": {},
            "polar_metadata": {"trajectory_metadata": {"xyne_raw": {}}},
        },
    ]
    dump = tmp_path / "rollout_000000_group_000.jsonl.gz"
    with gzip.open(dump, "wt", encoding="utf-8") as stream:
        for record in records:
            stream.write(json.dumps(record) + "\n")

    result = subprocess.run(
        [sys.executable, str(DUMP_AUDITOR), "--dump-root", str(tmp_path), "--json"],
        check=True,
        capture_output=True,
        text=True,
    )
    summary = json.loads(result.stdout)
    assert summary["validation"] == "PASS"
    assert summary["records"] == 2
    assert summary["status"] == {"completed": 1, "truncated": 1}
    assert summary["judge_max_tokens"] == {"16384": 1}
    assert summary["tool_calls"] == 1
    assert summary["citations"] == 1
    assert summary["reasoning_blocks"] == 1
