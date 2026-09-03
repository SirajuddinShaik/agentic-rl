#!/usr/bin/env python3
"""Extract dataset rows matching the first unique prompts in a rollout dump."""

from __future__ import annotations

import argparse
import gzip
import json
from pathlib import Path
from typing import Any


def content_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(
            str(item.get("text", "")) if isinstance(item, dict) else str(item)
            for item in value
        )
    return str(value)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dump", required=True)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--count", type=int, default=4)
    args = parser.parse_args()

    with open(args.dataset, encoding="utf-8") as stream:
        rows = [json.loads(line) for line in stream if line.strip()]
    rows_by_prompt = {str(row["prompt"]).strip(): row for row in rows}

    selected: list[dict[str, Any]] = []
    seen_groups: set[int] = set()
    with gzip.open(args.dump, "rt", encoding="utf-8") as stream:
        for line in stream:
            trace = json.loads(line)
            messages = trace.get("prompt_messages") or []
            if len(messages) < 2:
                continue
            question = content_text(messages[1].get("content", ""))
            question = question.split("\n[polar-session:", 1)[0].strip()
            group = int(trace["group_position"])
            if group in seen_groups or question not in rows_by_prompt:
                continue
            seen_groups.add(group)
            selected.append(rows_by_prompt[question])
            if len(selected) == args.count:
                break

    if len(selected) != args.count:
        raise RuntimeError(f"matched {len(selected)} prompts, expected {args.count}")

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as stream:
        for row in selected:
            stream.write(json.dumps(row) + "\n")
    print(json.dumps({"output": str(output), "instance_ids": [r["metadata"]["instance_id"] for r in selected]}))


if __name__ == "__main__":
    main()
