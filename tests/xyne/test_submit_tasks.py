"""Unit tests for polar.xyne.submit_tasks (build_payload + CLI parsing)."""

from __future__ import annotations

import json

import pytest

from polar.xyne.submit_tasks import (
    HARNESS_IMPORT_PATH,
    EVALUATOR_IMPORT_PATH,
    build_payload,
    build_parser,
    parse_expected_doc_ids,
    redact_payload,
)
from polar.rollout.models import TaskRequest


def test_build_payload_import_paths() -> None:
    payload = build_payload(
        instruction="q",
        model_name="nemotron-30b-a3b",
        expected_doc_ids=[{"docId": "x", "itemId": "y"}],
        num_samples=1,
    )
    assert payload["agent"]["import_path"] == HARNESS_IMPORT_PATH
    assert payload["builder"]["strategy"] == "prefix_merging"
    assert payload["evaluator"]["strategy"] == EVALUATOR_IMPORT_PATH


def test_runtime_spec() -> None:
    payload = build_payload(
        instruction="q", model_name="m", expected_doc_ids=["a"], num_samples=1
    )
    runtime = payload["runtime"]
    assert runtime["backend"] == "docker"
    assert runtime["image"] == "xyne-runtime:dev"
    assert runtime["prepare"] == []


def test_judge_omitted_when_no_creds() -> None:
    payload = build_payload(
        instruction="q", model_name="m", expected_doc_ids=["a"], num_samples=1
    )
    evaluator_config = payload["evaluator"]["config"]
    assert "judge" not in evaluator_config


def test_judge_included_when_creds_provided() -> None:
    payload = build_payload(
        instruction="q",
        model_name="m",
        expected_doc_ids=["a"],
        num_samples=1,
        judge_base_url="http://judge:8080/v1",
        judge_api_key="secret",
        judge_model="gpt-4o-mini",
    )
    judge = payload["evaluator"]["config"]["judge"]
    assert judge["base_url"] == "http://judge:8080/v1"
    assert judge["api_key"] == "secret"
    assert judge["model"] == "gpt-4o-mini"


def test_judge_partial_creds_only_provided_fields() -> None:
    payload = build_payload(
        instruction="q",
        model_name="m",
        expected_doc_ids=["a"],
        num_samples=1,
        judge_base_url="http://judge:8080",
    )
    judge = payload["evaluator"]["config"]["judge"]
    assert judge == {"base_url": "http://judge:8080"}


def test_expected_doc_ids_passthrough_normalized() -> None:
    payload = build_payload(
        instruction="q",
        model_name="m",
        expected_doc_ids=[{"docId": "x", "itemId": "y"}, "plain"],
        num_samples=1,
    )
    config = payload["evaluator"]["config"]
    assert config["expected_doc_ids"] == ["y", "plain"]


def test_scorers_include_required_names() -> None:
    payload = build_payload(
        instruction="q", model_name="m", expected_doc_ids=["a"], num_samples=1
    )
    names = {entry["name"] for entry in payload["evaluator"]["config"]["scorers"]}
    assert {"completion", "citation_accuracy", "llm_judge"} <= names


def test_task_request_model_validate_accepts_payload() -> None:
    payload = build_payload(
        instruction="q", model_name="m", expected_doc_ids=["a"], num_samples=1
    )
    task = TaskRequest.model_validate(payload)
    assert task.instruction == "q"
    assert task.num_samples == 1


def test_task_request_validate_with_judge_and_dict_doc_ids() -> None:
    payload = build_payload(
        instruction="What is the leave policy?",
        model_name="nemotron-30b-a3b",
        expected_doc_ids=[{"docId": "xyz", "itemId": "abc"}],
        num_samples=1,
        judge_base_url="http://judge:8080/v1",
        judge_api_key="k",
        judge_model="gpt-4o-mini",
    )
    TaskRequest.model_validate(payload)


def test_redact_payload_masks_api_key() -> None:
    payload = build_payload(
        instruction="q",
        model_name="m",
        expected_doc_ids=["a"],
        num_samples=1,
        judge_api_key="super-secret",
    )
    redacted = redact_payload(payload)
    assert redacted["evaluator"]["config"]["judge"]["api_key"] == "<redacted>"
    assert "super-secret" not in json.dumps(redacted)
    # Original payload is untouched (no mutation).
    assert payload["evaluator"]["config"]["judge"]["api_key"] == "super-secret"


def test_redact_payload_no_judge_is_noop() -> None:
    payload = build_payload(
        instruction="q", model_name="m", expected_doc_ids=["a"], num_samples=1
    )
    assert redact_payload(payload) == payload


def test_parse_expected_doc_ids_dict_list() -> None:
    raw = '[{"docId": "xyz", "itemId": "abc"}]'
    assert parse_expected_doc_ids(raw) == [{"docId": "xyz", "itemId": "abc"}]


def test_parse_expected_doc_ids_bad_json_raises() -> None:
    with pytest.raises(ValueError):
        parse_expected_doc_ids("{not json")


def test_parse_expected_doc_ids_non_array_raises() -> None:
    with pytest.raises(ValueError):
        parse_expected_doc_ids('"just-a-string"')


def test_parse_expected_doc_ids_none_returns_empty() -> None:
    assert parse_expected_doc_ids(None) == []


def test_build_parser_defaults() -> None:
    parser = build_parser()
    args = parser.parse_args(
        ["--instruction", "hello", "--expected-doc-ids", '["a"]']
    )
    assert args.instruction == "hello"
    assert args.expected_doc_ids == '["a"]'
    assert args.model_name == "nemotron-30b-a3b"
    assert args.num_samples == 1
    assert args.print_only is False
    assert args.poll_rollout_url is None


def test_build_parser_flags() -> None:
    parser = build_parser()
    args = parser.parse_args(
        [
            "--instruction",
            "hello",
            "--expected-doc-ids",
            '["a"]',
            "--model-name",
            "other",
            "--num-samples",
            "4",
            "--print-only",
            "--poll-rollout-url",
            "http://localhost:8080",
        ]
    )
    assert args.model_name == "other"
    assert args.num_samples == 4
    assert args.print_only is True
    assert args.poll_rollout_url == "http://localhost:8080"


def test_build_parser_requires_instruction() -> None:
    parser = build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args([])
