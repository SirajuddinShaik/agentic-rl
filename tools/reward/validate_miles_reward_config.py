#!/usr/bin/env python3
"""Validate the Miles-to-Polar reward template against a real dataset row."""

from __future__ import annotations

import json
import re
from pathlib import Path
from types import SimpleNamespace

import yaml

from miles.rollout.polar_config import PolarSlimeConfig, render_task_payload


CONFIG = Path("/data/siraj/ARL/reward_fix_test/polar_config_xyne_qa.yaml")
DATASET = Path("/data/siraj/xyne_s/xyne_qa_train.jsonl")


def main() -> None:
    config_text = CONFIG.read_text(encoding="utf-8")
    env_values = {
        "AGENT_CLI_DIR": "/opt/node",
        "XYNE_BASE_URL": "http://127.0.0.1:3000",
        "XYNE_API_KEY": "test-key",
        "XYNE_JUDGE_BASE_URL": "http://127.0.0.1:30000/v1",
        "JUSPAY_API_KEY": "test-judge-key",
        "WANDB_API_KEY": "test-wandb-key",
        "XYNE_JUDGE_MODEL": "nemotron",
        "XYNE_JUDGE_MAX_TOKENS": "2048",
        "XYNE_JUDGE_MAX_CONCURRENCY": "8",
        "XYNE_ACCESS_TOKEN": "",
        "XYNE_RUNTIME_IMAGE": "xyne:test",
        "XYNE_SERVER_DIR": "/workspace/xyne/server",
    }
    config_text = re.sub(
        r"\$\{([A-Z0-9_]+)\}",
        lambda match: env_values[match.group(1)],
        config_text,
    )
    document = yaml.safe_load(config_text)
    row = json.loads(DATASET.read_text(encoding="utf-8").splitlines()[0])
    template = document["polar_task_template"]
    assert template["builder"]["strategy"] == "per_request"
    config = PolarSlimeConfig(
        rollout_server_url="http://127.0.0.1:8080",
        task_template=template,
        task_id_template=document["polar_task_id_template"],
        instruction_template=None,
        reward_key="score",
        max_concurrency=1,
        max_session_concurrency=1,
        max_async_level=1,
        max_off_policy_steps=1,
        request_timeout=60.0,
        callback_host="127.0.0.1",
        scoring_mode="group",
        min_complete_accept_fraction=1.0,
        tokenizer_name_or_path=None,
        add_generation_prompt=True,
        eval_dataset_name="contract-test",
    )
    args = SimpleNamespace(
        polar_xyne_api_key="test-key",
        polar_agent_cli_dir="/opt/node",
        polar_xyne_server_dir="/workspace/xyne/server",
        sglang_router_ip="127.0.0.1",
        sglang_router_port=30000,
    )
    # Exercise the production failure mode: this loader can leave Sample.label
    # empty, while the gold answer remains available in Sample.metadata.
    sample = SimpleNamespace(
        prompt=row["prompt"],
        response="",
        label=None,
        metadata=row["metadata"],
        index=0,
        group_index=0,
        status="pending",
    )
    payload = render_task_payload(
        args=args,
        config=config,
        sample=sample,
        instruction=row["prompt"],
        rollout_id=0,
        task_position=0,
        num_rollouts=1,
    )
    evaluator = payload["evaluator"]["config"]
    assert evaluator["reference_answer"] == row["metadata"]["answer"]
    assert evaluator["expected_doc_ids"] == row["metadata"]["doc_ids"]
    embedding = next(
        scorer for scorer in evaluator["scorers"]
        if scorer["name"] == "embedding_similarity"
    )
    assert embedding["reference_answer"] == row["metadata"]["answer"]
    assert evaluator["judge"]["max_tokens"] > 0
    print("Miles-to-Polar reward config contract: PASS")


if __name__ == "__main__":
    main()
