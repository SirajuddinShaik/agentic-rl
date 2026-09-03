#!/usr/bin/env python3
"""Audit current Xyne/Polar trajectory dumps without printing private content."""

from __future__ import annotations

import argparse
import gzip
import json
from collections import Counter
from pathlib import Path
from statistics import fmean
from typing import Any, Iterator


def walk_max_tokens(value: Any) -> Iterator[int]:
    if isinstance(value, dict):
        max_tokens = value.get("max_tokens")
        if isinstance(max_tokens, int):
            yield max_tokens
        for child in value.values():
            yield from walk_max_tokens(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_max_tokens(child)


def audit_file(path: Path) -> dict[str, Any]:
    status: Counter[str] = Counter()
    finish: Counter[str] = Counter()
    judge_max_tokens: Counter[int] = Counter()
    sessions: set[str] = set()
    rewards: list[float] = []
    trainable_tokens: list[int] = []
    response_lengths: list[int] = []
    tool_calls = 0
    citations = 0
    reasoning_blocks = 0
    retrieved_chunks = 0
    judge_records = 0
    parse_errors = 0
    empty_token_records = 0
    zero_trainable_records = 0
    records = 0

    with gzip.open(path, "rt", encoding="utf-8") as stream:
        for line in stream:
            records += 1
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                parse_errors += 1
                continue

            status[str(record.get("status", "missing"))] += 1
            finish[str(record.get("finish_reason", "missing"))] += 1
            if session_id := record.get("session_id"):
                sessions.add(str(session_id))

            reward = record.get("reward", {})
            score = reward.get("score") if isinstance(reward, dict) else None
            if isinstance(score, (int, float)):
                rewards.append(float(score))

            trainable = int(record.get("trainable_token_count", 0) or 0)
            trainable_tokens.append(trainable)
            if trainable == 0:
                zero_trainable_records += 1
            if not record.get("tokens"):
                empty_token_records += 1
            response_lengths.append(int(record.get("response_length", 0) or 0))

            judge_io = record.get("judge_io") or {}
            if judge_io:
                judge_records += 1
                judge_max_tokens.update(walk_max_tokens(judge_io))

            metadata = record.get("polar_metadata", {})
            trajectory_metadata = metadata.get("trajectory_metadata", {}) if isinstance(metadata, dict) else {}
            raw_flow = trajectory_metadata.get("xyne_raw", {}) if isinstance(trajectory_metadata, dict) else {}
            if isinstance(raw_flow, dict):
                tool_calls += len(raw_flow.get("tool_calls", []) or [])
                citations += len(raw_flow.get("citations", []) or [])
                reasoning_blocks += len(raw_flow.get("thinking", []) or [])
                retrieved_chunks += len(raw_flow.get("retrieved_chunks", []) or [])

    return {
        "file": path.name,
        "records": records,
        "sessions": len(sessions),
        "status": dict(status),
        "finish_reason": dict(finish),
        "reward_count": len(rewards),
        "reward_mean": fmean(rewards) if rewards else None,
        "reward_min": min(rewards) if rewards else None,
        "reward_max": max(rewards) if rewards else None,
        "trainable_tokens": sum(trainable_tokens),
        "trainable_tokens_nonzero_records": sum(value > 0 for value in trainable_tokens),
        "zero_trainable_records": zero_trainable_records,
        "empty_token_records": empty_token_records,
        "response_tokens": sum(response_lengths),
        "tool_calls": tool_calls,
        "citations": citations,
        "reasoning_blocks": reasoning_blocks,
        "retrieved_chunks": retrieved_chunks,
        "judge_records": judge_records,
        "judge_max_tokens": {str(key): value for key, value in sorted(judge_max_tokens.items())},
        "parse_errors": parse_errors,
    }


def merge_summaries(summaries: list[dict[str, Any]]) -> dict[str, Any]:
    rewards = [summary["reward_mean"] for summary in summaries if summary["reward_mean"] is not None]
    merged: dict[str, Any] = {
        "files": len(summaries),
        "records": sum(summary["records"] for summary in summaries),
        "sessions": sum(summary["sessions"] for summary in summaries),
        "trainable_tokens": sum(summary["trainable_tokens"] for summary in summaries),
        "response_tokens": sum(summary["response_tokens"] for summary in summaries),
        "tool_calls": sum(summary["tool_calls"] for summary in summaries),
        "citations": sum(summary["citations"] for summary in summaries),
        "reasoning_blocks": sum(summary["reasoning_blocks"] for summary in summaries),
        "retrieved_chunks": sum(summary["retrieved_chunks"] for summary in summaries),
        "judge_records": sum(summary["judge_records"] for summary in summaries),
        "parse_errors": sum(summary["parse_errors"] for summary in summaries),
        "zero_trainable_records": sum(summary["zero_trainable_records"] for summary in summaries),
        "empty_token_records": sum(summary["empty_token_records"] for summary in summaries),
        "reward_file_means": rewards,
    }
    for field in ("status", "finish_reason"):
        counter: Counter[str] = Counter()
        for summary in summaries:
            counter.update(summary[field])
        merged[field] = dict(counter)
    judge_tokens: Counter[int] = Counter()
    for summary in summaries:
        judge_tokens.update({int(key): value for key, value in summary["judge_max_tokens"].items()})
    merged["judge_max_tokens"] = {str(key): value for key, value in sorted(judge_tokens.items())}
    return merged


def validate(summary: dict[str, Any], strict: bool) -> list[str]:
    problems: list[str] = []
    if summary["files"] == 0:
        problems.append("no group dump files found")
    if summary["records"] == 0:
        problems.append("no records found")
    if summary["status"].get("completed", 0) == 0:
        problems.append("no completed records")
    if summary["parse_errors"]:
        problems.append(f"parse errors: {summary['parse_errors']}")
    if summary["trainable_tokens"] == 0:
        problems.append("no trainable tokens")
    if summary["tool_calls"] == 0:
        problems.append("no tool calls")
    if summary["citations"] == 0:
        problems.append("no citations")
    if summary["reasoning_blocks"] == 0:
        problems.append("no reasoning blocks")
    if summary["judge_records"] == 0:
        problems.append("no judge I/O records")
    elif set(summary["judge_max_tokens"]) != {"16384"}:
        problems.append(f"unexpected judge max_tokens values: {summary['judge_max_tokens']}")
    if strict and summary["zero_trainable_records"]:
        problems.append(f"zero-token records: {summary['zero_trainable_records']}")
    if strict and summary["empty_token_records"]:
        problems.append(f"empty token-array records: {summary['empty_token_records']}")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dump-root", type=Path, required=True)
    parser.add_argument("--latest", type=int, default=0, help="audit only the newest N group files by filename")
    parser.add_argument("--strict", action="store_true", help="fail on zero-token records")
    parser.add_argument("--per-file", action="store_true")
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    args = parser.parse_args()

    paths = sorted(args.dump_root.glob("rollout_*_group_*.jsonl.gz"))
    if args.latest > 0:
        paths = paths[-args.latest :]
    summaries = [audit_file(path) for path in paths]
    merged = merge_summaries(summaries)
    problems = validate(merged, args.strict)
    merged["validation"] = "PASS" if not problems else "FAIL"
    merged["problems"] = problems

    if args.json:
        print(json.dumps(merged, indent=2, sort_keys=True))
    else:
        if args.per_file:
            for summary in summaries:
                print(json.dumps(summary, sort_keys=True))
        print(f"files={merged['files']}")
        print(f"records={merged['records']} sessions={merged['sessions']}")
        print(f"status={merged['status']}")
        print(f"finish_reason={merged['finish_reason']}")
        print(
            "rewards="
            f"files={len(merged['reward_file_means'])} "
            f"mean_of_group_means={fmean(merged['reward_file_means']) if merged['reward_file_means'] else None}"
        )
        print(
            f"trainable_tokens={merged['trainable_tokens']} "
            f"response_tokens={merged['response_tokens']}"
        )
        print(
            f"tool_calls={merged['tool_calls']} citations={merged['citations']} "
            f"reasoning_blocks={merged['reasoning_blocks']} retrieved_chunks={merged['retrieved_chunks']}"
        )
        print(f"judge_records={merged['judge_records']} judge_max_tokens={merged['judge_max_tokens']}")
        print(f"validation={merged['validation']}")
        for problem in problems:
            print(f"problem={problem}")

    return 0 if not problems else 1


if __name__ == "__main__":
    raise SystemExit(main())
