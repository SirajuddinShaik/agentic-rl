#!/usr/bin/env python3
"""Replay corrected deterministic rewards over captured live Polar task results."""

from __future__ import annotations

import asyncio
import glob
import json
import re
import statistics
from collections import defaultdict
from pathlib import Path

from polar.trajectory.models import Trajectory
from polar.xyne.evaluator import XyneCompositeEvaluator
from polar.xyne.xyne_fetch_flow import _build_unified_result


TASK_GLOB = "/data/siraj/ARL/reward_fix_test/live_tasks/*.json"
DATASET = Path("/data/siraj/xyne_s/xyne_qa_train.jsonl")
SESSION_SUFFIX = re.compile(r"\s*\[polar-session:[^\]]+\]\s*$")

SCORERS = [
    {"name": "citation_presence", "weight": 1.0},
    {"name": "citation_relevance", "weight": 0.75},
    {"name": "citation_accuracy", "weight": 1.5},
    {"name": "retrieval_quality", "weight": 1.0},
    {
        "name": "embedding_similarity",
        "weight": 2.0,
        "method": "f1",
    },
    {"name": "tool_call_efficiency", "weight": 0.5, "budget": 8},
    {
        "name": "token_efficiency",
        "weight": 0.5,
        "budget_tokens": 8192,
        "input_weight": 0.05,
    },
]


def load_dataset() -> dict[str, dict]:
    rows: dict[str, dict] = {}
    for line in DATASET.read_text(encoding="utf-8").splitlines():
        row = json.loads(line)
        rows[str(row["prompt"]).strip()] = row
    return rows


def question(raw: dict) -> str:
    messages = raw.get("request_messages") or []
    content = messages[0].get("content", "") if messages else ""
    return SESSION_SUFFIX.sub("", str(content)).strip()


async def main() -> None:
    dataset = load_dataset()
    component_values: dict[str, list[float]] = defaultdict(list)
    rewards: list[float] = []
    citation_counts: list[int] = []
    missing_labels = 0
    missing_raw = 0

    for task_path in sorted(glob.glob(TASK_GLOB)):
        task = json.loads(Path(task_path).read_text(encoding="utf-8"))
        for result in task.get("results", []):
            metadata = result["trajectory"]["metadata"]
            old_raw = metadata.get("xyne_raw")
            if not isinstance(old_raw, dict):
                missing_raw += 1
                continue
            rebuilt = _build_unified_result(
                old_raw.get("raw_dump") or {},
                old_raw.get("debug_events") or [],
                old_raw.get("nested_runs") or [],
                initial_citations=old_raw.get("citations") or [],
            )
            raw = {**old_raw, **rebuilt}
            row = dataset.get(question(raw))
            if row is None:
                missing_labels += 1
                continue

            config = {
                "expected_doc_ids": row.get("metadata", {}).get("doc_ids", []),
                "reference_answer": row.get("label") or row.get("metadata", {}).get("answer"),
                "scorers": SCORERS,
            }
            evaluation = await XyneCompositeEvaluator(**config).evaluate(
                Trajectory(status="COMPLETED", metadata={"xyne_raw": raw})
            )
            rewards.append(float(evaluation.outcome_reward or 0.0))
            citation_counts.append(len(raw.get("citations") or []))
            for name, value in evaluation.metadata["per_scorer"].items():
                component_values[name].append(float(value))

    print(
        json.dumps(
            {
                "sessions": len(rewards),
                "missing_labels": missing_labels,
                "missing_raw": missing_raw,
                "reward": stats(rewards),
                "citations": {
                    "sessions_with_citations": sum(v > 0 for v in citation_counts),
                    "mean_count": statistics.fmean(citation_counts) if citation_counts else 0.0,
                },
                "components": {
                    name: stats(values) for name, values in sorted(component_values.items())
                },
            },
            indent=2,
            sort_keys=True,
        )
    )


def stats(values: list[float]) -> dict[str, float]:
    if not values:
        return {"mean": 0.0, "variance": 0.0, "min": 0.0, "max": 0.0}
    return {
        "mean": statistics.fmean(values),
        "variance": statistics.pvariance(values),
        "min": min(values),
        "max": max(values),
        "nonzero_fraction": sum(v > 0 for v in values) / len(values),
    }


if __name__ == "__main__":
    asyncio.run(main())
