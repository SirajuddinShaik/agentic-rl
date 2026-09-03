/* eslint-disable @typescript-eslint/naming-convention --
 * Vespa schema uses snake_case (chunk_scores, chunks_summary, etc.); we mirror
 * the on-the-wire field names. */
// Shared helpers for the Vespa search tools.

import { getTracer } from "@/tracer"
import type { Span } from "@/tracer"

// Vespa helpers need a real Span (not a duck-typed stub); mint one via xyne's
// in-process tracer, the same primitive production search uses.
export const newSpan = (name: string): Span =>
  getTracer("backendv2-tools").startSpan(name)

export type ToolReturn = {
  content: { type: "text"; text: string }[]
  details: unknown
  isError?: boolean
}

export const textResult = (
  text: string,
  details: unknown = {},
  isError = false,
): ToolReturn => ({
  content: [{ type: "text", text }],
  details,
  ...(isError ? { isError: true } : {}),
})

// Bounds tool output size; agent can call getChunks for full content.
export const SNIPPET_CHARS = 2500

export const truncate = (s: string, max = SNIPPET_CHARS): string => {
  if (s.length <= max) {
    return s
  }
  return `${s.slice(0, max - 1)}…`
}

// Render a chunk's `page_numbers` as "1-3" (contiguous) or "1,2,5" so the agent
// can cross-reference citations.
export const formatPages = (pageNumbers: number[] | undefined): string => {
  if (!pageNumbers || pageNumbers.length === 0) {
    return ""
  }
  // Stored chunk pages are zero-based for PDF.js/OCR internals. Tool output is
  // user-facing and should match viewer page numbers.
  const sorted = [...pageNumbers].map((page) => page + 1).sort((a, b) => a - b)
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (
    first !== undefined &&
    last !== undefined &&
    last - first === sorted.length - 1
  ) {
    return first === last ? String(first) : `${String(first)}-${String(last)}`
  }
  return sorted.join(",")
}

// Title for a KB hit; falls back to fileName, then docId.
export const titleOf = (fields: {
  title?: string | undefined
  fileName?: string | undefined
  docId?: string | undefined
}): string => {
  return (
    (fields.title?.trim() ?? "") ||
    (fields.fileName?.trim() ?? "") ||
    (fields.docId ?? "Unknown document")
  )
}

// chunk_index of the top-scoring chunk; null when the score map is missing/empty.
export const topChunkIndex = (
  fields: Record<string, unknown>,
): number | null => {
  const top = topChunkIndices(fields, 1)
  return top[0]?.index ?? null
}

// Top-N chunks (score desc) from `matchfeatures.chunk_scores.cells`, so callers
// can render multiple snippets per document.
export const topChunkIndices = (
  fields: Record<string, unknown>,
  n: number,
): Array<{ index: number; score: number }> => {
  const mf = fields["matchfeatures"] as
    | { chunk_scores?: { cells?: Record<string, number> } }
    | undefined
  const cells = mf?.chunk_scores?.cells
  if (!cells || n <= 0) {
    return []
  }
  const ranked: Array<{ index: number; score: number }> = []
  for (const [k, v] of Object.entries(cells)) {
    if (typeof v !== "number") {
      continue
    }
    const idx = Number(k)
    if (Number.isFinite(idx)) {
      ranked.push({ index: idx, score: v })
    }
  }
  ranked.sort((a, b) => b.score - a.score)
  return ranked.slice(0, n)
}

// Fallback chunk index for keyword/lean hits that lack the semantic-only
// `matchfeatures.chunk_scores`: use the first chunk the summary actually
// materialized (chunks_pos_summary is ordered by relevance), else the hit's
// plain `chunk_index` field, else null. Prevents searchWithinDoc from emitting
// empty `chunk_index=""` hits that make the agent loop.
export const fallbackChunkIndex = (
  fields: Record<string, unknown>,
): number | null => {
  const pos = fields["chunks_pos_summary"]
  if (Array.isArray(pos) && pos.length > 0) {
    const first = pos[0]
    if (typeof first === "number" && Number.isFinite(first)) return first
  }
  const ci = fields["chunk_index"]
  if (typeof ci === "number" && Number.isFinite(ci)) return ci
  return null
}

// Positions map for a `lean`-summary hit (chunks pruned via select-elements-by).
// best_summary_chunks cell labels are the ORIGINAL element indices of the kept
// chunks; since the pruned array keeps document order, labels sorted ascending
// map pruned-array position → original chunk_index (same contract
// chunks_pos_summary gives for the `default` summary). Null if not a lean hit.
export const leanSummaryPositions = (
  fields: Record<string, unknown>,
): number[] | null => {
  const sf = fields["summaryfeatures"] as
    | { best_summary_chunks?: { cells?: Record<string, number> } }
    | undefined
  const cells = sf?.best_summary_chunks?.cells
  if (!cells) {
    return null
  }
  const indices: number[] = []
  for (const k of Object.keys(cells)) {
    const idx = Number(k)
    if (Number.isFinite(idx)) {
      indices.push(idx)
    }
  }
  indices.sort((a, b) => a - b)
  return indices
}

// Text of one chunks_summary element — a string, or a struct with a `chunk`
// member depending on the summary class.
const chunkText = (v: unknown): string => {
  if (typeof v === "string") {
    return v
  }
  if (v && typeof v === "object") {
    const obj = v as { chunk?: string }
    return obj.chunk ?? ""
  }
  return ""
}

// Snippet text for a chunk_index, two paths (else ""):
//   1) via `chunks_pos_summary[i] === chunkIndex` → chunks_summary[i]
//   2) fall back to `chunks_summary[chunkIndex]` (when the array is the full
//      document with sequential indices).
export const snippetForChunk = (
  fields: Record<string, unknown>,
  chunkIndex: number,
): string => {
  const summary = fields["chunks_summary"]
  if (!Array.isArray(summary)) {
    return ""
  }
  const positions = fields["chunks_pos_summary"]
  if (Array.isArray(positions)) {
    const at = positions.indexOf(chunkIndex)
    if (at >= 0) {
      const v: unknown = summary[at]
      if (typeof v === "string") {
        return v
      }
      if (v && typeof v === "object") {
        const obj = v as { chunk?: string }
        return obj.chunk ?? ""
      }
    }
  }
  const fallback: unknown = summary[chunkIndex]
  if (typeof fallback === "string") {
    return fallback
  }
  if (fallback && typeof fallback === "object") {
    const obj = fallback as { chunk?: string }
    return obj.chunk ?? ""
  }
  return ""
}

// Lean-summary variant for `runUnifiedSearch` hits (presentation.summary=lean on
// query-bearing calls). Lean hits carry a pruned `top_chunks_summary` — its own
// name because Vespa forbids reusing `chunks_summary` with a different element
// selector across summary classes. Positions map via best_summary_chunks; NO
// raw-index fallback here, since indexing a pruned array by chunk_index would hit
// the wrong element. Other summary classes (e.g. the `default` pure-filter path)
// delegate to `snippetForChunk`.
export const snippetForLeanChunk = (
  fields: Record<string, unknown>,
  chunkIndex: number,
): string => {
  const pruned = fields["top_chunks_summary"]
  if (Array.isArray(pruned)) {
    const positions = leanSummaryPositions(fields)
    if (positions) {
      const at = positions.indexOf(chunkIndex)
      return at >= 0 ? chunkText(pruned[at]) : ""
    }
    return ""
  }
  return snippetForChunk(fields, chunkIndex)
}
