/* eslint-disable @typescript-eslint/naming-convention --
 * Vespa schema uses snake_case fields (chunk_index, page_numbers); mirrored
 * in the tool's output. */
// searchWithinDoc — semantic search constrained to a single document.
// Wraps xyne's `searchCollectionRAG` (KB schema, docId-filterable) to find OTHER
// passages in a doc already surfaced by `vespaSearch`.
//
// GOTCHA: KB docs live in `KbItemsSchema`, not `FileSchema` — do NOT use
// `searchVespaInFiles` here; it always returns 0 hits for KB docs.

import { defineTool } from "@earendil-works/pi-coding-agent"
import { Type } from "@sinclair/typebox"

import { GetDocumentsByDocIds, searchCollectionRAG } from "@/platform/search/vespa"

import type { Log } from "../../../log"
import type { AgentScope } from "../../../agent-scope"
import { isKbDocReadable } from "./kbAccess"
import {
  formatPages,
  newSpan,
  snippetForChunk,
  textResult,
  titleOf,
  topChunkIndex,
  fallbackChunkIndex,
} from "./util"

const DESCRIPTION = [
  "Semantic search within a single document. Given a `docId` (from a ",
  "`vespaSearch` hit) and a focused `query`, returns the most relevant chunks ",
  "from that document only. Use when you need to find related passages, ",
  "definitions, exceptions, or cross-references inside the same document ",
  "without re-searching the whole corpus. ",
  "Each response carries `total_count` (matches inside this doc) and — when ",
  "more pages exist — `next_offset`. Paginate by calling again with ",
  "`offset=<next_offset>` until next_offset stops appearing.",
].join("")

const params = Type.Object({
  docId: Type.String({
    description: "The Vespa document ID to constrain the search to.",
    minLength: 1,
  }),
  query: Type.String({
    description:
      "Search query within the document — short keyword-style phrasing " +
      "(e.g., 'definition of qualified institutional buyer').",
    minLength: 2,
    maxLength: 200,
  }),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum matching chunks to return (1–20). Default 10.",
      minimum: 1,
      maximum: 20,
    }),
  ),
  offset: Type.Optional(
    Type.Number({
      description:
        "Skip the first N results. Use with `limit` to paginate the SAME " +
        "docId+query — call again with `offset=<previous_next_offset>` from " +
        "the response. Ranking is deterministic so pages never overlap. Cap: 1000.",
      minimum: 0,
      maximum: 1000,
    }),
  ),
})

export const buildSearchWithinDocTool = (
  userEmail: string,
  agentScope: AgentScope | undefined,
  parentLogger: Log,
): ReturnType<typeof defineTool> =>
  defineTool({
    name: "searchWithinDoc",
    label: "Search within a document",
    description: DESCRIPTION,
    promptSnippet:
      "Use `searchWithinDoc` to find specific passages inside a known " +
      "document without re-querying the full corpus.",
    parameters: params,
    async execute(toolCallId, p) {
      const log = parentLogger.child({
        toolName: "searchWithinDoc",
        toolCallId,
      })
      const startedAt = Date.now()
      const limit = Math.min(Math.max(p.limit ?? 10, 1), 20)
      const offset = Math.max(0, Math.min(p.offset ?? 0, 1000))
      log.info(
        { docId: p.docId, query: p.query, limit, offset: offset || undefined },
        "tool: searchWithinDoc start",
      )
      try {
        // Fail closed: authorize the docId before searching. kb_items is
        // multi-tenant, so only surface a doc the caller owns or that falls
        // inside the agent's granted scope — matching vespaSearch's gate.
        const authResp = await GetDocumentsByDocIds(
          [p.docId],
          newSpan("searchWithinDoc.authz"),
        )
        const authDoc = authResp?.root?.children?.[0] as
          | { fields?: Record<string, unknown> }
          | undefined
        if (
          !authDoc ||
          !isKbDocReadable(authDoc.fields ?? {}, userEmail, agentScope)
        ) {
          // Indistinguishable from a missing / zero-hit document.
          return textResult(
            `<doc_search docId=${JSON.stringify(p.docId)} query=${JSON.stringify(p.query)} offset="${String(offset)}" hits="0"/>`,
            {
              hits: 0,
              docId: p.docId,
              query: p.query,
              offset,
              totalCount: null,
              nextOffset: null,
              hasMore: false,
            },
          )
        }
        const resp = await searchCollectionRAG(
          p.query,
          [p.docId],
          undefined,
          limit,
          offset,
        )
        const children = resp?.root?.children ?? []
        // Vespa puts the corpus-wide match count in root.fields.totalCount when
        // ranking ran; surface it so the agent sees when the doc has more matches
        // than this page (as vespaSearch and getChunks do).
        const totalCount =
          typeof (resp?.root?.fields as { totalCount?: unknown } | undefined)
            ?.totalCount === "number"
            ? ((resp.root.fields as { totalCount: number }).totalCount)
            : null
        const nextOffset = offset + children.length
        const hasMore =
          totalCount !== null ? nextOffset < totalCount : children.length === limit
        if (children.length === 0) {
          log.info(
            { hits: 0, offset, totalCount, durationMs: Date.now() - startedAt },
            "tool: searchWithinDoc done (empty)",
          )
          return textResult(
            `<doc_search docId=${JSON.stringify(p.docId)} query=${JSON.stringify(p.query)} offset="${String(offset)}" hits="0"` +
              (totalCount !== null
                ? ` total_count="${String(totalCount)}"`
                : "") +
              `/>`,
            {
              hits: 0,
              docId: p.docId,
              query: p.query,
              offset,
              totalCount,
              nextOffset: hasMore ? nextOffset : null,
              hasMore,
            },
          )
        }

        // Total chunk count for this doc — all hits share the docId, so pull it
        // off the first hit. Lets the model gauge how much of the doc it has.
        let docTotalChunks: number | undefined
        {
          const firstFields =
            ((children[0]?.fields ?? {}) as Record<string, unknown>)["chunks_map"]
          if (Array.isArray(firstFields)) docTotalChunks = firstFields.length
        }

        const lines: string[] = []
        lines.push(
          `<doc_search docId=${JSON.stringify(p.docId)} query=${JSON.stringify(p.query)} ` +
            `offset="${String(offset)}" hits="${String(children.length)}"` +
            (totalCount !== null
              ? ` total_count="${String(totalCount)}"`
              : "") +
            (hasMore ? ` next_offset="${String(nextOffset)}"` : "") +
            (typeof docTotalChunks === "number"
              ? ` total_chunks="${String(docTotalChunks)}"`
              : "") +
            `>`,
        )
        const details: Array<{
          rank: number
          chunkIndex: number | null
          score: number
        }> = []

        children.forEach((hit, i) => {
          // Absolute rank across pages — matches the offset-aware numbering
          // used by vespaSearch so cite strings stay stable across pages.
          const rank = offset + i + 1
          const fields = (hit?.fields ?? {}) as Record<string, unknown>
          const score = typeof hit?.relevance === "number" ? hit.relevance : 0
          const title = titleOf({
            title: fields["title"] as string | undefined,
            fileName: fields["fileName"] as string | undefined,
            docId: p.docId,
          })

          const chunkIndex = topChunkIndex(fields) ?? fallbackChunkIndex(fields)
          const snippet =
            chunkIndex !== null ? snippetForChunk(fields, chunkIndex) : ""

          let pages = ""
          const chunksMap = fields["chunks_map"]
          if (Array.isArray(chunksMap) && chunkIndex !== null) {
            const entry = (chunksMap as Array<{
              chunk_index: number
              page_numbers?: number[]
            }>).find((m) => m.chunk_index === chunkIndex)
            pages = formatPages(entry?.page_numbers)
          }

          if (i === 0) {
            lines.push(`  <title>${title}</title>`)
          }
          // `cite` mirrors the ready-made citation string emitted by the
          // other vespa tools so the model can copy it verbatim per the
          // system prompt's "copy, don't construct" rule. When the
          // chunk_index couldn't be resolved we omit the attribute — the
          // prompt explicitly says "if a chunk has no cite, don't cite
          // that chunk".
          const cite =
            chunkIndex === null ? "" : ` cite="[${p.docId}#${String(chunkIndex)}]"`
          lines.push(
            `  <hit rank="${String(rank)}" chunk_index="${chunkIndex === null ? "" : String(chunkIndex)}" ` +
              `score="${score.toFixed(4)}"${pages ? ` pages="${pages}"` : ""}${cite}>`,
          )
          if (snippet) {
            lines.push(`    <snippet>${snippet}</snippet>`)
          }
          lines.push(`  </hit>`)
          details.push({ rank, chunkIndex, score })
        })

        lines.push(`</doc_search>`)
        if (hasMore) {
          const remaining =
            totalCount !== null ? totalCount - nextOffset : null
          lines.push(
            `\n⚠️ MORE MATCHES INSIDE THIS DOC — call \`searchWithinDoc\` ` +
              `again with the same docId/query plus ` +
              `\`offset=${String(nextOffset)}\`` +
              (remaining !== null
                ? ` (${String(remaining)} hits remaining of ${String(totalCount)} total).`
                : ".") +
              ` Do NOT assume this page is the full set unless you've ` +
              `gathered enough to fully answer the question — totalCount > ` +
              `returned means the result is TRUNCATED.`,
          )
        } else {
          lines.push(
            `\nFollow up with \`getChunks\` on the same docId using the ` +
              `\`chunk_index\` of the most relevant hit to read full context.`,
          )
        }

        log.info(
          {
            hits: details.length,
            offset,
            nextOffset: hasMore ? nextOffset : undefined,
            totalCount,
            topChunkIndex: details[0]?.chunkIndex,
            durationMs: Date.now() - startedAt,
          },
          "tool: searchWithinDoc done",
        )
        return textResult(lines.join("\n"), {
          docId: p.docId,
          query: p.query,
          hits: details,
          offset,
          totalCount,
          nextOffset: hasMore ? nextOffset : null,
          hasMore,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn(
          { err, docId: p.docId, query: p.query, durationMs: Date.now() - startedAt },
          "tool: searchWithinDoc failed",
        )
        return textResult(`searchWithinDoc failed: ${msg}`, { error: msg }, true)
      }
    },
  })
