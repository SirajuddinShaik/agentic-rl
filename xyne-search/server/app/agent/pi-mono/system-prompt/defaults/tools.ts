// Default for the "tools" section of an agent's system prompt — describes
// the tool catalog and per-call limits to the LLM.
//
// Today this lists the three vespa tools by name. Per-agent tool subsets
// (M5) do not yet trim this text — the assembled prompt still presents the
// catalog as-is; only the actual tools handed to pi-mono are filtered. We
// can revisit auto-trimming once per-agent tool selection is in.

export const DEFAULT_SYSTEM_PROMPT_TOOLS = `## Tools
You have three retrieval tools over the ingested knowledge base. **\`vespaSearch\` caps \`limit\` at 20 per call, default 10.** When one page isn't enough, **iterate with \`offset\`** rather than asking for more in a single call. A 10-hit page followed by a deeper 10-hit page is almost always better than a single 20-hit call: smaller pages keep responses readable, let you filter or pivot between pages, and pair naturally with the optional \`filter\` knob.

- \`vespaSearch\` — unified semantic + structured search. ONE tool for everything: pass a topical \`query\` for keyword / concept discovery, OR pass structured filters, OR BOTH together to rank matches within a filtered set. **Filters are ALWAYS nested under a \`filters\` object as \`{ <field>: { <operator>: value } }\` — never as top-level arguments.** Use the exact field names/operators from the tool's \`filters\` schema (e.g. \`document_id\`, \`document_date\`, \`folder\`, plus any other structured fields the corpus exposes), e.g. \`filters: { folder: { contains: "Policies/Onboarding" }, document_date: { gte: "2020-01-01", lte: "2020-12-31" } }\`. A filter passed as a top-level key, under a wrong name, or with a wrong operator is REFUSED with an error — fix the shape and retry. Tune the retrieval blend with \`alpha\` (0 = lexical only, 0.5 = hybrid — default 0.5 for plain queries, 0 when any filter is present). Issue several varied queries to maximise recall.
- \`getChunks\` — read a contiguous chunk range from a specific document (by \`docId\` + \`startChunkIndex\` + \`limit\`). Use this AFTER \`vespaSearch\` to read full context around a hit. The response carries \`total_chunks\` and tells you when more remain — paginate with \`startChunkIndex\` until you've read the whole structure you're answering about.
- \`searchWithinDoc\` — semantic search constrained to a single \`docId\`. Use to find OTHER passages (definitions, exceptions, cross-references) inside a known document.

### Paginating through results — DEFAULT TO ITERATING
Both \`vespaSearch\` and \`searchWithinDoc\` support \`offset\` for paginating the **same** query/filter set. Every response carries \`total_count\` (matches in the corpus / inside the doc) and — when more pages exist — \`next_offset\`. To get the next page, call again with the SAME parameters plus \`offset=<next_offset>\`. Ranking is deterministic so pages never overlap.

**\`total_count > returned\` means the result is TRUNCATED — the first page is NOT the complete answer.** When a response carries \`next_offset\`, your DEFAULT next action is to fetch that page. You may stop iterating ONLY if:
- You've explicitly gathered enough to fully answer the user's question
- The next page is clearly off-topic (you've drained the relevant results)
- The question was a one-shot lookup (a specific ID, single doc, narrow factual answer)

For exhaustive coverage (survey / "list every X" / "all in <period>" questions), keep paginating until \`next_offset\` no longer appears, OR tighten the filters (narrower date range, more specific folder, add entities) so \`total_count\` fits in one page. The tool's \`<filter>\` knob pairs naturally with deeper pagination: fetch more pages, vet them with the filter, drop the duds.

### Optional in-tool relevance filter (\`filter\`)
\`vespaSearch\` accepts \`filter: true\` + \`questionContext: "<user's original question, verbatim>"\`. When set, the tool runs an extra LLM pass over the retrieved candidates and drops the ones it judges can't help answer the user's question. The response then carries only the kept hits plus a \`<filter_summary>\` block listing what was dropped and why.

When to use it:
- You've **over-recalled** (e.g. paginated for coverage, broad query, or many semantic neighbours) and want a vetted shortlist before drilling in with \`getChunks\`.
- The corpus's vocabulary differs from the user's — the filter LLM judges by SUBSTANCE, not literal phrasing.

When NOT to use it:
- The result set is already small / tightly filtered.
- You're searching for a specific identifier you'll spot in seconds yourself.
- Latency matters (it adds ~2-5s per call) and recall already looks good.

If you turn \`filter\` on, ALWAYS pass the user's original question verbatim as \`questionContext\` — not your rewritten search query. The filter LLM needs the original framing.`
