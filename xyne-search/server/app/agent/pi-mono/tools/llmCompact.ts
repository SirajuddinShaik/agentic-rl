// Model-facing tool schema compactor.
//
// The vespa tool builders generate very large JSON schemas (the nested
// field/filter descriptions alone run ~5-9KB per tool, ~28KB for the set).
// Nemotron spends its whole generation reasoning about that blob and never
// emits a `tool_calls` token, which turns every rollout into a zero-trace
// dummy. pi-mono hands the raw args straight to each tool's `execute`, which
// re-validates against its OWN full closure schema, so we can safely shrink
// ONLY what the model sees here (name + a few params) without touching the
// runtime validation/dispatch path.

import { Type, type TSchema } from "@sinclair/typebox"

type ToolLike = {
  name: string
  description: string
  parameters: TSchema
  execute: (...a: unknown[]) => unknown
}

const looseFilters = Type.Object(
  {},
  { additionalProperties: Type.Unknown(), description: "Structured filters" },
)

// Compact substitute schemas, keyed by tool name.
export const COMPACT_PARAMS: Record<string, { description: string; parameters: TSchema }> = {
  vespaSearch: {
    description:
      "Semantic + structured search over the knowledge base. Pass a topical `query` and/or structured `filters`; paginate with `limit`/`offset`.",
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      filters: Type.Optional(looseFilters),
      limit: Type.Optional(Type.Number()),
      offset: Type.Optional(Type.Number()),
    }),
  },
  documentSearch: {
    description:
      "Balanced search over the knowledge base (filename/title + chunks + summary fusion). Pass `query` and/or filtered constraints; paginate with `limit`/`offset`.",
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      filters: Type.Optional(looseFilters),
      limit: Type.Optional(Type.Number()),
      offset: Type.Optional(Type.Number()),
    }),
  },
  proximitySearch: {
    description:
      "Exact-string search over the corpus (pins a literal value like an order/ISIN/PAN number or quoted phrase).",
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      filters: Type.Optional(looseFilters),
      limit: Type.Optional(Type.Number()),
      offset: Type.Optional(Type.Number()),
    }),
  },
  getChunks: {
    description: "Read a contiguous chunk range (docId + startChunkIndex + limit) from a document.",
    parameters: Type.Object({
      docId: Type.Optional(Type.String()),
      startChunkIndex: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
    }),
  },
  searchWithinDoc: {
    description: "Semantic search constrained to a single docId.",
    parameters: Type.Object({
      docId: Type.Optional(Type.String()),
      query: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Number()),
    }),
  },
  getFolderTree: {
    description: "List the collection -> folder tree.",
    parameters: Type.Object({
      path: Type.Optional(Type.String()),
    }),
  },
}

export function compactForLlm<T extends ToolLike>(tool: T): T {
  const c = COMPACT_PARAMS[tool.name]
  if (!c) return tool
  return {
    ...tool,
    description: c.description,
    parameters: c.parameters as unknown as TSchema,
  }
}
