# Xyne Vespa Tool/Profile Fixes

Last verified: 2026-08-12 on RTX1 (`rtx1`)

## Final Status

Live Vespa deployment is session 42 in container `siraj-vespa`.

Verified working:

- `chunk_tf_prox_coverage` ranking profile
- `default_native_dynamic_chunks_file_v6_rsf_vec` ranking profile
- `document-summary lean`
- `kb_items.document_date` remains `string`, matching the existing data
- Vespa config server is up
- Search responses contain non-empty `docId`, `fileName`, and `top_chunks_summary`

## Original Symptoms

The agent received native retrieval tools, but results were unusable:

- `documentSearch` returned a missing ranking-profile error.
- `proximitySearch` returned a missing ranking-profile error.
- `vespaSearch` returned hits with empty document metadata.
- Repeated tool calls occurred because the model received no useful document content.

This was not an agent permission or phase-timeout problem. The database tool allowlist was already working: the run produced real tool calls and tool results.

## Root Cause

The Xyne backend/tool code and live Vespa schema were from different deployments.

The backend requests:

```text
presentation.summary=lean
```

and the tools require:

```text
default_native_dynamic_chunks_file_v6_rsf_vec
chunk_tf_prox_coverage
```

The old live Vespa session 38 did not contain those summaries or profiles. The current Xyne source schema did contain them.

The old deployment also lacked newer `kb_items` fields used by the result parser, including `ai_summary`, `documentOutline`, and the `best_summary_chunks` rank function.

## Applied Fix

1. Staged the current Xyne Vespa schemas and search rules without editing the read-only backend source.
2. Replaced `v[DIMS]` placeholders with the live 1024-dimensional embedding shape.
3. Preserved the deployed `services.xml`, including the working `tei-batch-proxy` endpoint.
4. Added validation overrides with a Vespa-accepted 28-day expiry.
5. Restored `kb_items.document_date` to `string` to match the existing indexed data.
6. Restored unrelated `chat_container` and `ticket` schemas from the previous live session so their existing tensor dimensions were not changed.
7. Deployed to `siraj-vespa`; final deployment session: 42.

No data volume was deleted and no reindex was performed.

## Verification

Direct queries against `http://127.0.0.1:18081/search/` succeeded for both profiles with `presentation.summary=lean`:

- `default_native_dynamic_chunks_file_v6_rsf_vec`: returned a non-empty `docId`, `fileName`, and `top_chunks_summary`.
- `chunk_tf_prox_coverage`: returned a non-empty `docId`, `fileName`, and `top_chunks_summary`.
- No missing-profile or missing-summary errors were returned.
- Vespa status reported the container ready and the config server up.

## Future Deployment Rule

When Xyne tool code changes its Vespa ranking profiles or summary names, deploy the matching schema package before testing the harness. Compare the backend requests in:

```text
server/app/agent/pi-mono/tools/vespa/searchCore.ts
server/app/agent/pi-mono/tools/vespa/documentSearch.ts
server/app/agent/pi-mono/tools/vespa/proximitySearch.ts
```

against the active `kb_items.sd` inside `siraj-vespa`.

Use a temporary staged package. Do not edit the mounted Xyne backend source or delete `/data/siraj/xyne_s/vespa-dump/sebi-local/data/vespa-var`.

Before deploying, confirm:

- Embedding tensor dimensions match the existing live schema.
- Existing field types, especially `document_date`, are preserved unless a deliberate migration is planned.
- `services.xml` points at the currently available embedder service.
- Validation override dates are no more than 30 days in the future.

After deploying, query every newly referenced profile directly and verify non-empty metadata before running a full harness test.

## Related LiteLLM Note

The attached LiteLLM `config.ts` fallback fix is separate. It can help model discovery and allowlists, but it does not fix Vespa ranking profiles or document summaries.
