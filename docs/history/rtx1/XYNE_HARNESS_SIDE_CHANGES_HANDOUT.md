# Xyne Harness-Side Changes Handout

Last verified: 2026-08-12 on RTX1.

## 1. Agentic Tool Execution

The harness now uses the native Pi-mono agentic path through the Xyne `/v2/chat` flow.

The agent receives real tool definitions from the database and can emit structured tool calls. This is different from the old non-agentic path, which produced a single LLM answer and could show tool syntax as plain text.

Relevant runtime areas:

```text
/data/siraj/xyne_s/xyne-search/server/app/agent/pi-mono/
/data/siraj/xyne_s/xyne-search/server/app/agent/services/chat.ts
/data/siraj/xyne_s/xyne-search/server/app/agent/pi-mono/tools/registry.ts
```

Important distinction:

- Pi-mono agentic execution: the active tool-calling path.
- JAF: not used as the retrieval execution path in this smoke setup.
- `USE_AGENTIC_FILTERING=true`: enables the optional relevance-filter step; it is not the JAF runtime.
- Sub-agents: supported by the framework, but none are configured in the live `sub_agents` table.

The backend source remains read-only. We changed runtime/database configuration, not the Xyne source repository.

## 2. Tools Enabled

The default SEBI agent database row now has:

```text
vespaSearch
getChunks
searchWithinDoc
proximitySearch
documentSearch
getFolderTree
```

This was necessary because an empty agent `tools` array gives the model no function definitions. The model then writes fake tool syntax in its answer instead of executing tools.

Verification:

```bash
docker exec siraj-xyne-db psql -U xyne -d xyne -Atc \
  "SELECT name,tools FROM agents WHERE is_default=true AND deleted_at IS NULL;"
```

## 3. Full Flow Capture

The helper now waits for a terminal run and fetches the authoritative dump endpoint:

```text
GET /v2/chat/conversations/:id/dump
```

It preserves:

- Final answer
- Structured tool calls and results
- Vespa `docId`
- `chunkIndex`, `chunkIndices`, and `relevantChunkIndices`
- Chunk text and page data
- Citations such as `[docId#44]`
- Thinking, messages, runs, token usage
- Nested sub-agent traces when configured

Standalone helper path:

```text
/data/siraj/ARL/miles/polar-pkg/polar/xyne/xyne_fetch_flow.py
```

Smoke-test wrapper:

```text
/data/siraj/test_without_polar.sh
```

The standalone wrapper validates the harness but does not provide Polar session attribution.

## 4. Vespa Schema and Ranking Profiles

The live Vespa deployment was behind the Xyne tool code. We deployed the matching schema package without deleting data or reindexing.

Final live deployment: session 42.

Added/verified:

```text
document-summary lean
chunk_tf_prox_coverage
default_native_dynamic_chunks_file_v6_rsf_vec
```

Also preserved:

- 1024-dimensional embedding tensors
- `kb_items.document_date` as `string`
- Existing `chat_container` and `ticket` tensor dimensions
- Existing `tei-batch-proxy` service endpoint

Direct smoke queries now return non-empty `docId`, `fileName`, and `top_chunks_summary`.

Detailed Vespa note:

```text
XYNE_VESPA_TOOL_PROFILE_FIXES.md
```

## 5. Reranker Setup

RTX1 also has a TEI cross-encoder reranker provisioned as:

```text
container: siraj-tei-rerank
image: ghcr.io/huggingface/text-embeddings-inference:cpu-1.5
model: Xenova--bge-reranker-base
container port: 80
host port: 18002
network alias: tei-rerank
```

The model files are mounted read-only from:

```text
/data/siraj/xyne_s/vespa-dump/sebi-local/data/tei-rerank-models
```

Health and metadata checks:

```bash
curl http://127.0.0.1:18002/
curl http://127.0.0.1:18002/info
```

The TEI service accepts reranking requests at its standard `/rerank` endpoint. The current container reports `max_input_length=512` and `auto_truncate=true`.

Important boundary: the current Xyne backend search code does not directly reference `tei-rerank` or `/rerank`. Therefore this service is healthy and ready, but it is not automatically part of the current `vespaSearch` path. Current ranking is performed by Vespa rank profiles such as `default_native_dynamic_chunks_file_v6_rsf_vec` and `chunk_tf_prox_coverage`.

To make cross-encoder reranking active, a backend search stage must explicitly send candidate query/document pairs to `http://tei-rerank:80/rerank` on the Docker network, then reorder or rescore the candidates before returning them. This should be added as a deliberate tool/backend change and tested separately from the existing Vespa schema fix.

## 6. Model Allowlist Fix

The launcher now includes:

```text
glm-latest
kimi-latest
glm-flash-experimental
open-fast
```

It also passes `MODEL` into the container correctly. Previously, `MODELS_LIST` was expanded inside a single-quoted container command, so the selected model variable was empty.

Updated launcher:

```text
/data/siraj/test_without_polar.sh
```

Example:

```bash
export JUSPAY_API_KEY='your-key'
bash /data/siraj/test_without_polar.sh 3 glm-flash-experimental
```

## 7. Verified Result

The confirmed raw run showed:

- Run status: `completed`
- Error: `None`
- Two completed `vespaSearch` calls
- Real tool results
- Non-empty document and chunk identifiers
- Two final citations
- Correct answer from the cited judgment chunk

Example raw dump:

```text
/data/siraj/xyne_s/flow_dumps/test_raw_1786530195346387856.json
```

## 8. Current Boundaries

- Polar is not used by `test_without_polar.sh`; use the Polar Xyne harness for GRPO attribution.
- Sub-agents are not active until rows are added under the parent SEBI agent.
- `filter call failed — kept by default` is fail-open behavior from the optional relevance filter; retrieval still succeeds.
- Do not edit `/data/siraj/xyne_s/xyne-search/` directly.
