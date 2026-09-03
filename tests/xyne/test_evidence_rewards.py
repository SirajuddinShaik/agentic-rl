from __future__ import annotations

from array import array
import threading
import time

import pytest

from polar.xyne.evaluator import _build_pipeline
from polar.xyne.scorers.citation_evidence_coverage import (
    CitationEvidenceCoverageScorer,
)
from polar.xyne.scorers.evidence_common import (
    VespaChunkVectorStore,
    canonical_chunk_id,
)
from polar.xyne.scorers.gold_evidence_coverage import GoldEvidenceCoverageScorer
from polar.xyne.scorers.tool_evidence_utility import ToolEvidenceUtilityScorer
from polar.xyne.types import XyneRawFlow


def _flow(**overrides):
    values = {
        "conversation_id": "conv-1",
        "run_id": "run-1",
        "request_messages": [{"role": "user", "content": "question"}],
        "answer": "grounded answer",
    }
    values.update(overrides)
    return XyneRawFlow(**values)


def _provider(vectors):
    return vectors.get


def test_canonical_chunk_id_supports_dataset_and_xyne_shapes() -> None:
    assert canonical_chunk_id("doc-a#02") == "doc-a#2"
    assert canonical_chunk_id({"docId": "doc-a", "chunkIndex": 2}) == "doc-a#2"


def test_gold_coverage_combines_exact_and_semantic_neighbors() -> None:
    scorer = GoldEvidenceCoverageScorer(config={
        "expected_chunk_ids": ["doc-a#1", "doc-a#2"],
        "exact_weight": 0.5,
        "_vector_provider": _provider({
            "doc-a#1": [1.0, 0.0],
            "doc-a#2": [0.0, 1.0],
            "doc-a#3": [0.0, 1.0],
        }),
    })
    flow = _flow(retrieved_chunks=[
        {"docId": "doc-a", "chunkIndex": 1},
        {"docId": "doc-a", "chunkIndex": 3},
    ])
    assert scorer.score(flow) == pytest.approx(0.75)
    assert scorer.last_metrics == pytest.approx({
        "combined": 0.75,
        "exact_recall": 0.5,
        "semantic_recall": 1.0,
    })


def test_extra_relevant_citations_do_not_reduce_gold_coverage() -> None:
    scorer = CitationEvidenceCoverageScorer(config={
        "expected_chunk_ids": ["doc-a#1"],
        "_vector_provider": _provider({"doc-a#1": [1.0, 0.0]}),
    })
    flow = _flow(citations=[
        {"docId": "doc-a", "chunkIndex": 1},
        {"docId": "doc-b", "chunkIndex": 7},
    ])
    assert scorer.score(flow) == 1.0


def test_tool_utility_credits_new_evidence_and_rejects_duplicate_calls() -> None:
    scorer = ToolEvidenceUtilityScorer(config={
        "expected_chunk_ids": ["doc-a#1"],
        "coverage_weight": 0.75,
        "_vector_provider": _provider({"doc-a#1": [1.0, 0.0]}),
    })
    result = {"details": {"hits": [{"docId": "doc-a", "chunkIndex": 1}]}}
    flow = _flow(
        citations=[{"docId": "doc-a", "chunkIndex": 1}],
        tool_calls=[
            {"toolName": "vespaSearch", "result": result},
            {"toolName": "vespaSearch", "result": result},
        ],
    )
    assert scorer.score(flow) == pytest.approx(0.875)
    assert scorer.last_metrics["useful_calls"] == 1.0


def test_tool_utility_extracts_ids_from_string_tool_results() -> None:
    scorer = ToolEvidenceUtilityScorer(config={
        "expected_chunk_ids": ["doc-a#4"],
        "semantic_enabled": False,
    })
    flow = _flow(tool_calls=[{
        "toolName": "getChunks",
        "result": '<chunk docId="doc-a" chunkIndex="4">evidence</chunk>',
    }])
    assert scorer.score(flow) == 1.0


def test_evaluator_forwards_gold_chunk_ids_to_new_scorers() -> None:
    pipeline = _build_pipeline({
        "expected_chunk_ids": ["doc-a#1"],
        "scorers": [{
            "name": "gold_evidence_coverage",
            "semantic_enabled": False,
        }],
    })
    score, details = pipeline.run_with_scores(_flow(
        retrieved_chunks=[{"docId": "doc-a", "chunkIndex": 1}],
    ))
    assert score == 1.0
    assert details == {"gold_evidence_coverage": 1.0}


def test_vector_store_deduplicates_concurrent_document_fetches(monkeypatch) -> None:
    VespaChunkVectorStore._documents.clear()
    VespaChunkVectorStore._missing.clear()
    VespaChunkVectorStore._inflight.clear()
    store = VespaChunkVectorStore(base_url="http://vespa.test", timeout=1.0)
    fetch_count = 0
    fetch_lock = threading.Lock()

    def fetch(_doc_id):
        nonlocal fetch_count
        with fetch_lock:
            fetch_count += 1
        time.sleep(0.05)
        return {"1": array("f", [1.0, 0.0])}

    monkeypatch.setattr(store, "_fetch_document", fetch)
    results = []
    threads = [
        threading.Thread(target=lambda: results.append(store.get("doc-a#1")))
        for _ in range(8)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert fetch_count == 1
    assert len(results) == 8
    assert all(result == array("f", [1.0, 0.0]) for result in results)


def test_vector_store_negative_caches_failed_document_fetches(monkeypatch) -> None:
    VespaChunkVectorStore._documents.clear()
    VespaChunkVectorStore._missing.clear()
    VespaChunkVectorStore._inflight.clear()
    store = VespaChunkVectorStore(base_url="http://vespa.test")
    fetch_count = 0

    def fetch(_doc_id):
        nonlocal fetch_count
        fetch_count += 1
        return None

    monkeypatch.setattr(store, "_fetch_document", fetch)
    assert store.get("oversized-doc#1") is None
    assert store.get("oversized-doc#2") is None
    assert fetch_count == 1
