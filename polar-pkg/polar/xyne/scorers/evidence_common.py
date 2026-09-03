"""Shared exact-ID and Vespa-vector evidence utilities.

Dataset chunk identifiers use ``docId#chunkIndex``. Vespa stores the matching
1024-dimensional vector under the document's ``chunk_embeddings`` tensor,
whose mapped ``p`` dimension is keyed by that same chunk index. This module
keeps exact set matching cheap and only touches Vespa when semantic coverage
is requested.
"""

from __future__ import annotations

from array import array
from collections import OrderedDict
from collections.abc import Callable, Iterable, Mapping
import json
import math
import os
import re
import threading
from typing import Any
from urllib.parse import quote
from urllib.request import urlopen

from polar.xyne.types import XyneRawFlow

Vector = list[float] | array
VectorProvider = Callable[[str], Vector | None]

_CITE_TOKEN_RE = re.compile(r"\[([^#\]\s]+)#(\d+)\]")
_TAG_RE = re.compile(r"<(?:chunk|hit)\b([^>]*)>", re.IGNORECASE)
_ATTR_RE = re.compile(r'''([A-Za-z_][A-Za-z0-9_-]*)="([^"]*)"''')


def canonical_chunk_id(value: Any) -> str | None:
    """Normalize a string or evidence mapping to ``docId#chunkIndex``."""
    if isinstance(value, str):
        doc_id, marker, chunk = value.rpartition("#")
        if marker and doc_id and chunk:
            return f"{doc_id}#{_canonical_index(chunk)}"
        return None
    if not isinstance(value, Mapping):
        return None
    doc_id = value.get("docId") or value.get("itemId")
    chunk = value.get("chunk")
    if chunk is None:
        chunk = value.get("chunkIndex")
    if not isinstance(doc_id, str) or not doc_id or chunk is None:
        return None
    if isinstance(chunk, (list, tuple, set, dict)):
        return None
    return f"{doc_id}#{_canonical_index(chunk)}"


def _canonical_index(value: Any) -> str:
    try:
        return str(int(value))
    except (TypeError, ValueError):
        return str(value).strip()


def document_id(chunk_id: str) -> str:
    return chunk_id.rsplit("#", 1)[0]


def expected_chunk_ids(values: Any) -> set[str]:
    if not isinstance(values, (list, tuple, set, frozenset)):
        return set()
    return {item for value in values if (item := canonical_chunk_id(value))}


def citation_chunk_ids(flow: XyneRawFlow) -> set[str]:
    return {item for value in flow.citations if (item := canonical_chunk_id(value))}


def retrieved_chunk_ids(flow: XyneRawFlow) -> set[str]:
    """Collect chunk IDs from normalized evidence and structured tool results."""
    ids = {
        item for value in flow.retrieved_chunks
        if (item := canonical_chunk_id(value))
    }
    for call in flow.tool_calls:
        ids.update(tool_call_chunk_ids(call))
    for event in flow.tool_events:
        ids.update(tool_call_chunk_ids(event))
    return ids


def tool_call_chunk_ids(call: Any) -> set[str]:
    """Extract result chunk IDs from one Xyne retrieval call/event."""
    if not isinstance(call, Mapping):
        return set()
    ids: set[str] = set()
    direct = call.get("retrieved_chunks") or call.get("retrievedChunks")
    if isinstance(direct, list):
        ids.update(
            item for value in direct
            if (item := canonical_chunk_id(value))
        )

    result = call.get("result")
    if isinstance(result, (Mapping, list, str)):
        _extract_result_ids(result, ids)
    return ids


def _extract_result_ids(value: Any, out: set[str]) -> None:
    if isinstance(value, list):
        for item in value:
            _extract_result_ids(item, out)
        return
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.startswith(("{", "[")):
            try:
                _extract_result_ids(json.loads(stripped), out)
            except (json.JSONDecodeError, TypeError):
                pass
        for doc_id, chunk in _CITE_TOKEN_RE.findall(value):
            out.add(f"{doc_id}#{_canonical_index(chunk)}")
        for raw_attributes in _TAG_RE.findall(value):
            attributes = dict(_ATTR_RE.findall(raw_attributes))
            doc_id = attributes.get("docId") or attributes.get("doc_id")
            chunk = (
                attributes.get("chunk")
                or attributes.get("chunkIndex")
                or attributes.get("chunk_index")
                or attributes.get("index")
            )
            if doc_id and chunk is not None:
                out.add(f"{doc_id}#{_canonical_index(chunk)}")
        return
    if not isinstance(value, Mapping):
        return

    doc_id = value.get("docId") or value.get("itemId")
    if isinstance(doc_id, str) and doc_id:
        indices: list[Any] = []
        for key in ("chunkIndices", "relevantChunkIndices"):
            raw = value.get(key)
            if isinstance(raw, (list, tuple, set)):
                indices.extend(raw)
        for key in ("chunk", "chunkIndex"):
            raw = value.get(key)
            if raw is not None and not isinstance(raw, (list, tuple, set, dict)):
                indices.append(raw)
        for index in indices:
            out.add(f"{doc_id}#{_canonical_index(index)}")

    # Xyne's structured results place hits under result.details.hits. Walking
    # all JSON containers also supports getChunks and future normalized shapes.
    for child in value.values():
        if isinstance(child, (Mapping, list)):
            _extract_result_ids(child, out)


def retrieval_calls(flow: XyneRawFlow) -> list[dict[str, Any]]:
    """Return ordered retrieval calls, preferring first-class tool calls."""
    source = flow.tool_calls or flow.tool_events
    calls: list[dict[str, Any]] = []
    markers = ("search", "getchunks", "proximity", "foldertree")
    for call in source:
        if not isinstance(call, dict):
            continue
        name = str(call.get("toolName") or call.get("name") or "").casefold()
        if any(marker in name for marker in markers):
            calls.append(call)
    return calls


def cosine_similarity(left: Iterable[float], right: Iterable[float]) -> float:
    dot = left_norm = right_norm = 0.0
    for a, b in zip(left, right):
        fa, fb = float(a), float(b)
        dot += fa * fb
        left_norm += fa * fa
        right_norm += fb * fb
    if left_norm <= 0.0 or right_norm <= 0.0:
        return 0.0
    return max(0.0, min(1.0, dot / math.sqrt(left_norm * right_norm)))


def evidence_coverage(
    observed: set[str],
    gold: set[str],
    vector_provider: VectorProvider | None,
    *,
    exact_weight: float = 0.5,
) -> tuple[float, float, float]:
    """Return ``(combined, exact_recall, semantic_recall)`` over gold chunks.

    Semantic recall is query-independent: for each gold chunk, find the most
    similar observed chunk vector. Exact matches naturally have cosine 1.0.
    If vectors are unavailable, the combined score falls back to exact recall.
    Extra observed chunks do not reduce recall; unsupported citation spam is
    handled separately by the judge/citation-support signal.
    """
    if not gold:
        return 0.0, 0.0, 0.0
    exact = len(observed & gold) / len(gold)
    if not observed or vector_provider is None:
        return exact, exact, exact

    observed_vectors = {
        item: vector for item in observed
        if (vector := vector_provider(item)) is not None
    }
    semantic_values: list[float] = []
    for gold_id in gold:
        if gold_id in observed:
            semantic_values.append(1.0)
            continue
        gold_vector = vector_provider(gold_id)
        if gold_vector is None or not observed_vectors:
            semantic_values.append(0.0)
            continue
        semantic_values.append(max(
            cosine_similarity(gold_vector, candidate)
            for candidate in observed_vectors.values()
        ))
    semantic = sum(semantic_values) / len(semantic_values)
    weight = max(0.0, min(1.0, float(exact_weight)))
    return weight * exact + (1.0 - weight) * semantic, exact, semantic


class VespaChunkVectorStore:
    """Bounded process-wide cache for Vespa document tensor blocks."""

    _lock = threading.RLock()
    _documents: OrderedDict[tuple[str, str], dict[str, array]] = OrderedDict()
    _missing: OrderedDict[tuple[str, str], None] = OrderedDict()
    _inflight: dict[tuple[str, str], threading.Event] = {}

    def __init__(
        self,
        base_url: str | None = None,
        *,
        timeout: float = 5.0,
        max_cached_documents: int | None = None,
        max_document_bytes: int | None = None,
    ) -> None:
        self.base_url = (
            base_url
            or os.environ.get("XYNE_VESPA_DOCUMENT_URL")
            or "http://127.0.0.1:18080"
        ).rstrip("/")
        self.timeout = float(timeout)
        self.max_cached_documents = int(
            max_cached_documents
            or os.environ.get("XYNE_VESPA_VECTOR_CACHE_DOCUMENTS", "64")
        )
        self.max_document_bytes = int(
            max_document_bytes
            or os.environ.get("XYNE_VESPA_VECTOR_MAX_DOCUMENT_BYTES", str(16 << 20))
        )

    def get(self, chunk_id: str) -> array | None:
        normalized = canonical_chunk_id(chunk_id)
        if normalized is None:
            return None
        doc_id, chunk_index = normalized.rsplit("#", 1)
        key = (self.base_url, doc_id)
        with self._lock:
            cached = self._documents.get(key)
            if cached is not None:
                self._documents.move_to_end(key)
                return cached.get(chunk_index)
            if key in self._missing:
                self._missing.move_to_end(key)
                return None
            ready = self._inflight.get(key)
            owns_fetch = ready is None
            if owns_fetch:
                ready = threading.Event()
                self._inflight[key] = ready

        if not owns_fetch:
            ready.wait(timeout=max(1.0, self.timeout + 1.0))
            with self._lock:
                cached = self._documents.get(key)
                return cached.get(chunk_index) if cached is not None else None

        blocks: dict[str, array] | None = None
        try:
            blocks = self._fetch_document(doc_id)
        finally:
            with self._lock:
                if blocks is None:
                    self._missing[key] = None
                    self._missing.move_to_end(key)
                    while len(self._missing) > max(1, self.max_cached_documents):
                        self._missing.popitem(last=False)
                else:
                    self._documents[key] = blocks
                    self._documents.move_to_end(key)
                    while len(self._documents) > max(1, self.max_cached_documents):
                        self._documents.popitem(last=False)
                completed = self._inflight.pop(key, None)
                if completed is not None:
                    completed.set()

        if blocks is None:
            return None
        with self._lock:
            cached = self._documents.get(key)
            return cached.get(chunk_index) if cached is not None else None

    def _fetch_document(self, doc_id: str) -> dict[str, array] | None:
        url = (
            f"{self.base_url}/document/v1/namespace/kb_items/docid/"
            f"{quote(doc_id, safe='')}?fieldSet=kb_items%3Achunk_embeddings"
        )
        try:
            with urlopen(url, timeout=self.timeout) as response:  # noqa: S310
                content_length = response.headers.get("Content-Length")
                if content_length and int(content_length) > self.max_document_bytes:
                    return None
                body = response.read(self.max_document_bytes + 1)
                if len(body) > self.max_document_bytes:
                    return None
                payload = json.loads(body)
            raw = payload["fields"]["chunk_embeddings"]["blocks"]
            if not isinstance(raw, Mapping):
                return None
            return {
                _canonical_index(index): array("f", (float(v) for v in vector))
                for index, vector in raw.items()
                if isinstance(vector, list)
            }
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            return None


def vector_provider_from_config(config: Mapping[str, Any]) -> VectorProvider | None:
    injected = config.get("_vector_provider")
    if callable(injected):
        return injected
    if not bool(config.get("semantic_enabled", True)):
        return None
    store = VespaChunkVectorStore(
        base_url=str(config.get("vespa_document_url") or "") or None,
        timeout=float(config.get("vespa_timeout", 5.0)),
        max_cached_documents=int(config.get("vector_cache_documents", 64)),
        max_document_bytes=int(config.get("vespa_max_document_bytes", 16 << 20)),
    )
    return store.get
