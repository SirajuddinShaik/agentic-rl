"""Build and submit Xyne rollout tasks to the Polar rollout server.

This module mirrors ``examples/calculator/run.py`` and
``examples/swebench_verified/submit_swebench_tasks.py`` but targets the Xyne
plugin: it renders a ``TaskRequest``-shaped payload whose runtime uses the
``xyne-runtime:dev`` image, whose agent is ``XyneHarness``, and whose evaluator
is ``XyneCompositeEvaluator`` with the Todo-8 (T5-documented) config contract.

Everything is import-safe: importing this module has no side effects and never
POSTs. Payload construction lives in :func:`build_payload` (pure, returns a
plain dict validatable by ``polar.rollout.models.TaskRequest``), separated from
the ``__main__`` CLI so it can be unit-tested.

Judge credentials are read from the environment (``XYNE_JUDGE_BASE_URL``,
``XYNE_JUDGE_API_KEY``, ``XYNE_JUDGE_MODEL``) and are NEVER hardcoded. The
``--print-only`` path redacts the API key before pretty-printing so no secret
leaks into stdout/logs.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

HARNESS_IMPORT_PATH = "polar.xyne.harness:XyneHarness"
EVALUATOR_IMPORT_PATH = "polar.xyne.evaluator:XyneCompositeEvaluator"
RUNTIME_IMAGE = "xyne-runtime:dev"
RUNTIME_BACKEND = "docker"

DEFAULT_MODEL_NAME = "nemotron-30b-a3b"
DEFAULT_NUM_SAMPLES = 1
DEFAULT_TASK_ID_PREFIX = "xyne"

# The 8 built-in scorer names (must match polar.xyne.scorers.ALL_SCORERS).
ALL_SCORER_NAMES = (
    "completion",
    "answer_format",
    "citation_presence",
    "citation_relevance",
    "citation_accuracy",
    "retrieval_quality",
    "subagent_success",
    "llm_judge",
)

# Scorers that must always be present in the pipeline for a meaningful score.
REQUIRED_SCORERS = ("completion", "citation_accuracy", "llm_judge")


@dataclass(frozen=True)
class JudgeCredentials:
    """Judge connection details, read from the environment by the CLI."""

    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None
    weight: float | None = None


def _normalize_doc_ids(expected_doc_ids: list[Any]) -> list[str]:
    """Normalize doc-id items to plain strings for ``citation_accuracy``.

    Accepts either bare doc-id strings or dicts carrying ``itemId``/``docId``
    keys (whichever is present). The evaluator's ``citation_accuracy`` scorer
    compares cited doc ids against this list of strings.
    """
    normalized: list[str] = []
    for item in expected_doc_ids or []:
        if isinstance(item, str):
            normalized.append(item)
        elif isinstance(item, dict):
            value = item.get("itemId") or item.get("docId")
            if value is not None:
                normalized.append(str(value))
        # Non-string, non-dict entries are skipped; the config is validated by
        # TaskRequest at submit time when that matters.
    return normalized


def _judge_config(creds: JudgeCredentials) -> dict[str, Any]:
    """Build the ``judge`` dict, omitting any un-provided fields.

    Only fields that were actually supplied are included, so an empty judge
    dict is omitted entirely by :func:`build_payload`.
    """
    judge: dict[str, Any] = {}
    if creds.base_url:
        judge["base_url"] = creds.base_url
    if creds.api_key:
        judge["api_key"] = creds.api_key
    if creds.model:
        judge["model"] = creds.model
    if creds.weight:
        judge["weight"] = creds.weight
    return judge


def _default_scorers(weight: float | None) -> list[dict[str, Any]]:
    """Default scorer list: the full 8, plus per-scorer weights when given.

    ``weight`` (when the caller passes a judge weight) is applied to the
    ``llm_judge`` entry; the other scorers use their defaults so the evaluator
    pipeline stays balanced. This keeps the config flat (top-level ``judge``
    drives ``llm_judge``) per the T5 contract.
    """
    scorers: list[dict[str, Any]] = []
    for name in ALL_SCORER_NAMES:
        entry: dict[str, Any] = {"name": name}
        if name == "llm_judge" and weight is not None:
            entry["weight"] = weight
        scorers.append(entry)
    return scorers


def build_payload(
    *,
    instruction: str,
    model_name: str = DEFAULT_MODEL_NAME,
    expected_doc_ids: list[Any] | None = None,
    num_samples: int = DEFAULT_NUM_SAMPLES,
    judge_base_url: str | None = None,
    judge_api_key: str | None = None,
    judge_model: str | None = None,
    judge_weight: float | None = None,
    task_id: str | None = None,
    timeout_seconds: float = 600.0,
) -> dict[str, Any]:
    """Build a ``TaskRequest``-shaped dict (pure, no side effects).

    Parameters mirror the CLI. ``judge_*`` come from the environment and are
    optional: the ``judge`` config is only included when at least one judge
    field is provided. Returns a plain dict validatable by
    ``polar.rollout.models.TaskRequest.model_validate``.
    """
    creds = JudgeCredentials(
        base_url=judge_base_url,
        api_key=judge_api_key,
        model=judge_model,
        weight=judge_weight,
    )
    judge = _judge_config(creds)

    evaluator_config: dict[str, Any] = {
        "expected_doc_ids": _normalize_doc_ids(expected_doc_ids or []),
        "scorers": _default_scorers(creds.weight),
    }
    if judge:
        evaluator_config["judge"] = judge

    agent: dict[str, Any] = {
        "import_path": HARNESS_IMPORT_PATH,
        "model_name": model_name,
    }

    return {
        "task_id": task_id if task_id is not None else f"{DEFAULT_TASK_ID_PREFIX}-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}",
        "instruction": instruction,
        "num_samples": num_samples,
        "timeout_seconds": timeout_seconds,
        "runtime": {
            "backend": RUNTIME_BACKEND,
            "image": RUNTIME_IMAGE,
            "prepare": [],
            "network": "host",
            "workdir": "/polar/session/workspace",
        },
        "agent": agent,
        "builder": {"strategy": "prefix_merging"},
        "evaluator": {
            "strategy": EVALUATOR_IMPORT_PATH,
            "config": evaluator_config,
        },
    }


_REDACTED = "<redacted>"


def redact_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of the payload with the judge API key masked.

    Used by ``--print-only`` so the API key never leaks to stdout. Other values
    are shallow-copied; only the nested ``judge.api_key`` is replaced.
    """
    evaluator = payload.get("evaluator") or {}
    config = evaluator.get("config") or {}
    judge = config.get("judge")
    if not isinstance(judge, dict) or "api_key" not in judge:
        return payload
    redacted = {**config, "judge": {**judge, "api_key": _REDACTED}}
    return {
        **payload,
        "evaluator": {**evaluator, "config": redacted},
    }


def parse_expected_doc_ids(raw: str) -> list[Any]:
    """Parse the ``--expected-doc-ids`` JSON string into a list.

    Raises a clear error on malformed input so the CLI exits non-zero with a
    helpful message instead of silently POSTing a bad payload.
    """
    if raw is None:
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"--expected-doc-ids must be valid JSON: {exc.msg} at line {exc.lineno} col {exc.colno}"
        ) from exc
    if not isinstance(parsed, list):
        raise ValueError("--expected-doc-ids must be a JSON array")
    return parsed


def get_judge_creds_from_env() -> JudgeCredentials:
    """Read judge credentials from the environment (never from source)."""
    return JudgeCredentials(
        base_url=os.environ.get("XYNE_JUDGE_BASE_URL") or None,
        api_key=os.environ.get("XYNE_JUDGE_API_KEY") or None,
        model=os.environ.get("XYNE_JUDGE_MODEL") or None,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--instruction", required=True, help="The user query / task instruction.")
    parser.add_argument(
        "--expected-doc-ids",
        default=None,
        help="JSON string of a list of doc ids (strings or {docId,itemId} dicts).",
    )
    parser.add_argument("--model-name", default=DEFAULT_MODEL_NAME)
    parser.add_argument("--num-samples", type=int, default=DEFAULT_NUM_SAMPLES)
    parser.add_argument(
        "--print-only",
        action="store_true",
        help="Pretty-print the payload (API key redacted) without POSTing.",
    )
    parser.add_argument(
        "--poll-rollout-url",
        default=None,
        help="POST target for /rollout/task/submit. Omit to preview without POSTing.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    judge = get_judge_creds_from_env()

    try:
        expected_doc_ids = parse_expected_doc_ids(args.expected_doc_ids)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    payload = build_payload(
        instruction=args.instruction,
        model_name=args.model_name,
        expected_doc_ids=expected_doc_ids,
        num_samples=args.num_samples,
        judge_base_url=judge.base_url,
        judge_api_key=judge.api_key,
        judge_model=judge.model,
    )

    if args.print_only:
        print(json.dumps(redact_payload(payload), indent=2))
        return 0

    if not args.poll_rollout_url:
        print("no rollout URL provided; use --print-only to preview")
        return 0

    import httpx

    timeout = httpx.Timeout(None, connect=30.0)
    with httpx.Client(base_url=args.poll_rollout_url, timeout=timeout) as client:
        resp = client.post("/rollout/task/submit", json=payload)
        resp.raise_for_status()
        print(resp.json())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
