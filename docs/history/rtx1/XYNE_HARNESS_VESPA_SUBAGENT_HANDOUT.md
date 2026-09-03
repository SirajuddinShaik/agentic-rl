# Xyne Harness, Vespa, and Sub-Agent Handout

Last verified: 2026-08-12 on RTX1

## Executive Summary

The retrieval path is working. The exact raw dump for the SEBI fine question completed successfully and contains real Vespa results, document identifiers, chunk identifiers, and citations.

Sub-agent dispatch is **not currently available for the SEBI agent** because the live `sub_agents` table has zero rows. This is a configuration gap, not a Vespa permission failure and not a retrieval failure.

## Verified Raw Dump

Dump:

```text
/data/siraj/xyne_s/flow_dumps/test_raw_1786530195346387856.json
```

Run state:

- Run status: `completed`
- Error: `None`
- `vespaSearch` calls: 2
- Both tool calls: completed
- Retrieved hits: 8 on the first call and 10 on the second call
- Final citations: 2
- Sub-agents used: 0

The second search was a focused follow-up query. It found the same judgment as the top hit and the final answer cited the exact relevant chunks.

## What Identifiers Are Preserved

The raw tool result preserves:

- `docId`: the Vespa document identifier, for example `clf-pvstegqbqv7bpznmxxjd9tej`
- `title` / `fileName`: the source document path
- `chunkIndex`: the primary selected chunk
- `chunkIndices`: the returned chunk indices for that hit
- `relevantChunkIndices`: chunks selected as relevant by the tool/filter stage
- Inline citation identifiers such as `[clf-pvstegqbqv7bpznmxxjd9tej#44]`
- The actual chunk text and page information
- `nextOffset`, `totalCount`, and `hasMore` for pagination

For the confirmed answer, the raw dump contains the judgment text at chunk `#44`:

```text
each in default of payment of fine, the accused are directed to undergo
simple imprisonment for six months.
```

The final response cites chunks `#44` and `#42`. It is not expected to cite every retrieved hit; it cites the evidence used in the answer. The full hit metadata remains in the raw dump.

## What Is Not Automatically Returned

`vespaSearch` returns bounded search evidence, not the complete source document. For full content, the agent should use the returned `docId` and chunk index with:

- `getChunks`
- `searchWithinDoc`
- `documentSearch` when a document-focused search is required

The current result is therefore sufficient for this one-shot question, but a long or multi-part question may require follow-up retrieval.

## Sub-Agent Availability

The live database schema has a `sub_agents` table, but it currently contains zero rows.

The runner behavior is:

1. Resolve sub-agents for the parent agent.
2. If at least one exists, inject the sub-agent catalog and `dispatchSubagent` tools.
3. If none exist, omit the sub-agent catalog and dispatch tools.

Therefore, the current SEBI run was not blocked after trying to dispatch. It never had a dispatchable sub-agent configured, and the model correctly answered the bounded lookup itself.

The source implementation supports:

- `dispatchSubagent` for one focused sub-agent
- `dispatchSubagentBatch` for parallel focused sub-agents
- Isolated sub-agent sessions
- Nested run/debug capture
- Citation preservation from the delegated response

There are no prebuilt named sub-agents in the current database or seed data. The UI and API provide a custom-sub-agent editor, with `researcher` shown only as a placeholder/example name. It is not an active sub-agent.

Good first custom leaves for this harness would be:

- `researcher`: deep multi-document retrieval using `getChunks`, with a citation for every claim
- `document-verifier`: checks a proposed answer against the exact source chunks and reports contradictions
- `case-finder`: locates the primary judgment for a case number and returns the strongest document/chunk evidence

These are designs we can add; they are not currently live.

To enable this later, create at least one active `sub_agents` row linked to the SEBI parent agent, with a name, description, system prompt, and an explicit tool list. Then restart/reload the harness and verify that the prompt contains a `<subagents>` catalog and that the available tool list contains `dispatchSubagent` or `dispatchSubagentBatch`.

Do not add a sub-agent merely to force delegation for a simple lookup. Use one for bounded multi-step research, separate document slices, or parallel evidence gathering.

## Current SEBI Agent Tools

The live SEBI agent has:

```text
vespaSearch
getChunks
searchWithinDoc
proximitySearch
documentSearch
getFolderTree
```

These are retrieval tools. They are separate from sub-agent dispatch.

## Verification Checklist

For every test run, inspect the raw dump and confirm:

1. `runs[0].status == "completed"`
2. Top-level `error` is `None`
3. Tool calls have `status == "completed"`
4. Tool results are not marked as errors
5. Each useful hit has a non-empty `docId`
6. Each useful hit has `chunkIndex` or `chunkIndices`
7. The returned text contains inline citation IDs when evidence is used
8. The final answer citations point to real `docId#chunk` pairs
9. `sub_agents` is non-empty only when sub-agent dispatch is intended

## Known Non-Blocking Detail

Some hits show:

```text
filter call failed — kept by default
```

This is fail-open behavior. It means the optional relevance-filter call failed, but the hit was retained. Retrieval itself succeeded and the final answer used the correct judgment chunk. For stricter production behavior, the filter failure policy should be reviewed separately.

## Related Deployment Fix

The Vespa schema mismatch was fixed in session 42. The live deployment now includes:

- `chunk_tf_prox_coverage`
- `default_native_dynamic_chunks_file_v6_rsf_vec`
- `document-summary lean`

See `XYNE_VESPA_TOOL_PROFILE_FIXES.md` for the deployment history and compatibility safeguards.
