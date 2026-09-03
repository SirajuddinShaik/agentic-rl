#!/usr/bin/env python3
"""Replay one persisted Polar task through the configured Xyne reward stack."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import re
import urllib.request
from pathlib import Path
from typing import Any

import yaml

from polar.xyne.evaluator import _build_pipeline, _parse_raw


SESSION_MARKER = re.compile(r"\n?\[polar-session:[^\]]+\]\s*$")


def _render(value: Any, metadata: dict[str, Any]) -> Any:
    if isinstance(value, dict):
        return {key: _render(item, metadata) for key, item in value.items()}
    if isinstance(value, list):
        return [_render(item, metadata) for item in value]
    if not isinstance(value, str):
        return value
    match = re.fullmatch(r"\{sample\.metadata\.([^{}]+)\}", value)
    return metadata.get(match.group(1)) if match else value


def _load_dataset_row(path: Path, prompt: str) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            row = json.loads(line)
            if row.get("prompt") == prompt:
                return row
    raise ValueError(f"prompt not found in {path}: {prompt!r}")


def _score_task(
    task_id: str,
    *,
    rollout_url: str,
    template: dict[str, Any],
    dataset: Path,
) -> dict[str, Any]:
    url = f"{rollout_url.rstrip('/')}/rollout/task/{task_id}"
    with urllib.request.urlopen(url, timeout=30) as response:
        task = json.load(response)
    trajectory = task["results"][0]["trajectory"]
    flow = _parse_raw(trajectory["metadata"]["xyne_raw"])
    request = flow.request_messages[0]
    content = request.get("content", "") if isinstance(request, dict) else ""
    prompt = SESSION_MARKER.sub("", content).strip()
    row = _load_dataset_row(dataset, prompt)

    config = template["polar_task_template"]["evaluator"]["config"]
    config = _render(config, row.get("metadata") or {})
    reference = config.get("reference_answer")
    if isinstance(reference, str) and reference.strip():
        flow.metadata = dict(flow.metadata)
        flow.metadata.setdefault("reference_answer", reference)

    score, per_scorer = _build_pipeline(config).run_with_scores(flow)
    return {"task_id": task_id, "score": score, "per_scorer": per_scorer}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task-id", action="append", required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--rollout-url", default="http://127.0.0.1:8080")
    args = parser.parse_args()

    template = yaml.safe_load(args.config.read_text(encoding="utf-8"))
    with ThreadPoolExecutor(max_workers=len(args.task_id)) as executor:
        results = list(executor.map(
            lambda task_id: _score_task(
                task_id,
                rollout_url=args.rollout_url,
                template=template,
                dataset=args.dataset,
            ),
            args.task_id,
        ))
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
