#!/usr/bin/env python3
"""Build a combined SEBI question dataset in Miles' training JSONL schema.

Existing (already curated) rows  : data/sebi_pranav_metadata_graph_train.jsonl
Additional (single-doc chunks)   : SEBI-Question-Dataset.zip -> chunk_questions_formatted.jsonl

Output schema (one JSON object per line):
  {
    "prompt": str,
    "label": str,                       # reference answer (== metadata.answer)
    "metadata": {
      "instance_id": "sebi-pranav-XXXXX",
      "answer": str,
      "doc_ids": [str, ...],
      "chunk_ids": [str, ...],
      "pipeline": str,
      "source_dataset": str
    }
  }
"""
from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("build_sebi_combined")


def load_rows(path: Path) -> list[dict]:
    rows = []
    with path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def _md(obj, key, default):
    return obj.get(key) if obj.get(key) not in (None, "") else default


def normalize_chunk_row(idx: int, r: dict) -> dict:
    answer = _md(r, "answer", "")
    return {
        "prompt": _md(r, "question", ""),
        "label": answer,
        "metadata": {
            "instance_id": f"sebi-chunk-{idx:05d}",
            "answer": answer,
            "doc_ids": list(r.get("docIds") or []),
            "chunk_ids": list(r.get("chunk_ids") or []),
            "pipeline": _md(r, "pipeline", ""),
            "source_dataset": "chunk_questions_formatted.jsonl",
        },
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--existing", type=Path, default=Path("data/sebi_pranav_metadata_graph_train.jsonl"))
    ap.add_argument("--chunk", type=Path, required=True,
                    help="path to chunk_questions_formatted.jsonl (from SEBI-Question-Dataset.zip)")
    ap.add_argument("--out", type=Path, default=Path("data/sebi_combined_train.jsonl"))
    args = ap.parse_args()

    existing = load_rows(args.existing)
    log.info("existing rows: %d", len(existing))

    chunk = []
    with args.chunk.open() as f:
        for line in f:
            line = line.strip()
            if line:
                chunk.append(json.loads(line))
    log.info("chunk rows: %d", len(chunk))

    seen = {e["prompt"] for e in existing}
    added = 0
    for i, r in enumerate(chunk):
        n = normalize_chunk_row(i, r)
        if not n["prompt"] or n["prompt"] in seen:
            continue
        seen.add(n["prompt"])
        existing.append(n)
        added += 1
    log.info("added chunk rows: %d", added)

    # Re-index every merged row under a single namespace for clean ids.
    for i, r in enumerate(existing):
        r["metadata"]["instance_id"] = f"sebi-pranav-{i:05d}"

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w") as f:
        for r in existing:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    from collections import Counter
    log.info("wrote %d rows -> %s", len(existing), args.out)
    log.info("source distribution: %s", dict(Counter(r["metadata"]["source_dataset"] for r in existing)))
    log.info("pipeline distribution: %s", dict(Counter(r["metadata"]["pipeline"] for r in existing)))


if __name__ == "__main__":
    main()
