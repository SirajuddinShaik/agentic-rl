/* eslint-disable @typescript-eslint/naming-convention --
 * Vespa schema uses snake_case fields (chunk_index, page_numbers); mirrored
 * in the tool's output and details, matching search.ts. */
// `proximitySearch` — narrow exact-string locator over body chunks, pinned to
// the chunk_tf_prox_coverage rank profile.

import { defineTool } from "@earendil-works/pi-coding-agent"
import { Type, type TSchema } from "@sinclair/typebox"
import { Value } from "@sinclair/typebox/value"

import type { AgentScope } from "../../../agent-scope"
import type { Log } from "../../../log"
import {
  computeCursor,
  hasAnyFilter,
  intDateToIso,
  isoDateToInt,
  runLlmFilter,
  runUnifiedSearch,
  summarizeAppliedFilters,
  type FilterCandidate,
  type FilterOperatorBag,
  type LlmHandle,
  type UnifiedSearchParams,
  type VespaHit,
} from "./searchCore"
import {
  getSearchFilterFields,
  type FieldDef,
  type Operator,
} from "./searchFilterConfig"
import {
  formatPages,
  snippetForLeanChunk,
  textResult,
  titleOf,
  topChunkIndices,
  truncate,
} from "./util"

// ─── Tool configuration ──────────────────────────────────────────────────────

const TOOL_NAME = "proximitySearch"
const TOOL_LABEL = "Proximity search (exact string)"
const RANK_PROFILE = "chunk_tf_prox_coverage"
// 0.3 aligns with documentSearch; applies to plain and filtered queries alike.
const DEFAULT_ALPHA = 0.3
// Exact-string locator — no concept to embed.
const SEMANTIC_CHANNEL = false
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 20
const TOP_CHUNKS_PER_DOC = 3
const CHUNKS_PER_DOC_FOR_FILTER = 5

const DESCRIPTION_INTRO =
  "`proximitySearch` — exact-string locator over document BODY-TEXT chunks " +
  "(filename/title are NOT scored).\n" +
  "HOW IT RETRIEVES & RANKS: it scores each candidate chunk on three " +
  "signals — " +
  "(1) COVERAGE: how many of your query terms appear in the chunk (it needs " +
  "nearly ALL of them, not just one); (2) PROXIMITY: how CLOSE those terms " +
  "sit to each other — tightly-clustered tokens score far higher than the " +
  "same words scattered across the chunk; (3) term FREQUENCY of the matched " +
  "tokens. A chunk therefore only ranks when almost every query token " +
  "appears packed together in one passage. That makes it a precise locator " +
  "for a literal value, and effectively useless for loose / conceptual " +
  "matching.\n" +
  "BECAUSE OF THAT RANKING: pass the EXACT token cluster only — a " +
  "circular/regulation number, a section/clause reference, an id, an " +
  "order/certificate/ISIN number, or a precise named entity / " +
  "quoted phrase ('CIR/2023/70', 'regulation 30(4)', the " +
  "entity's full name as printed). Keep it SHORT, one target per call; every " +
  "extra topical word must ALSO co-occur next to the rest or good chunks " +
  "stop matching.\n" +
  "NARROW tool — use SPARINGLY, NOT as a default/general search. For " +
  'topical / conceptual / "find all" / title-finding questions (the vast ' +
  "majority), and when in doubt, use `documentSearch`."

const PROMPT_SNIPPET =
  "`proximitySearch` — narrow exact-string locator. Its ranking only scores " +
  "a chunk when nearly ALL query terms appear " +
  "CLOSE TOGETHER in one body passage (filename/title ignored), so pass just " +
  "the exact token cluster (a circular/regulation/PAN/ISIN number, section " +
  "ref, or quoted phrase), short, one per call. NOT a general search — for " +
  'topical / "find all" / title questions use `documentSearch`.'

// ─── Standalone execute glue ─────────────────────────────────────────────────
// Helpers below mirror search.ts's private internals (param coercion + schema)
// so this tool behaves identically to vespaSearch apart from the pinned rank
// profile. Copied, not imported (search.ts doesn't export them), so that file
// stays untouched — keep in sync if its schema/description change.

type Params = Record<string, unknown>

// ─── Description + schema builders (mirrored from search.ts) ──────────────────

const descriptionStatic = (chunksPerDoc: number): string =>
  [
  "Unified semantic + structured search across the ingested corpus. ",
  "Pass a topical `query` for keyword/semantic discovery, OR pass structured ",
  "filters (see field list below) for concrete-identifier lookups, OR pass ",
  "both together to rank matches within a filtered set. ",
  `Each hit returns up to ${String(chunksPerDoc)} top-scoring `,
  `chunk${chunksPerDoc === 1 ? "" : "s"} `,
  "from the same document. Issue multiple varied queries (synonyms, ",
  "regulation/circular numbers, section names) to maximise recall. ",
  'For folder-scoped search ("everything in Legal/Circulars"), pass the ',
  "path from `getFolderTree` as `filters.folder.contains` (single path) or ",
  "`filters.folder.containsAny` (multiple) — the tool resolves the path to a ",
  "`clFd in (...)` clause that Vespa pre-filters against HNSW for correct ",
  "high-recall folder scoping. ",
  "IMPORTANT for 'find all X' / 'list every X in <period>' survey questions: ",
  "every response carries both `total_count` (corpus matches) and `next_offset` ",
  "(when more pages exist). If total_count > the number of hits returned, the ",
  "result is TRUNCATED — paginate with `offset=<next_offset>` until next_offset ",
  "stops appearing, OR tighten the filters to bring total_count under the ",
  "limit. DO NOT treat the first page as the complete answer when total_count ",
  "exceeds it. ",
  "Optional `filter`+`questionContext` runs an in-tool LLM relevance pass ",
  "that drops candidates that don't help answer the user's question — use ",
  "it when you've over-recalled and want a vetted shortlist before drilling ",
  "in with `getChunks`.",
  ].join("")

const buildDescription = (
  fields: ReadonlyArray<FieldDef>,
  chunksPerDoc: number,
): string => {
  const staticPart = descriptionStatic(chunksPerDoc)
  const exposed = fields.filter((f) => f.filter.tier !== "none")
  if (exposed.length === 0) return staticPart
  const lines = exposed.map((f) => {
    if (f.filter.tier === "none") return ""
    const ops = f.filter.operators.join("/")
    return `  - \`${f.name}\` (${f.dataType}${f.multiValued ? "[]" : ""}, ${f.filter.tier}, ops: ${ops})`
  })
  return (
    staticPart +
    "\n\n## Filter fields\n" +
    "Pass filters as nested operator bags: " +
    `\`filters: { <field_name>: { <op>: <value>, ... } }\`. ` +
    "Available fields for this deployment:\n" +
    lines.join("\n")
  )
}

const valueSchemaForOp = (field: FieldDef, op: Operator): TSchema => {
  const isNumber = field.dataType === "number"
  const isDate = field.dataType === "date"
  const isBoolean = field.dataType === "boolean"
  switch (op) {
    case "eq":
      if (isNumber) return Type.Number()
      if (isDate) return Type.String({ minLength: 4, maxLength: 32 })
      if (isBoolean) return Type.Boolean()
      return Type.String({ minLength: 1 })
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      if (isNumber) return Type.Number()
      if (isDate) return Type.String({ minLength: 4, maxLength: 32 })
      return Type.String({ minLength: 1 })
    case "in":
    case "nin":
      if (isNumber)
        return Type.Array(Type.Number(), { minItems: 1, maxItems: 50 })
      if (isDate)
        return Type.Array(Type.String({ minLength: 4, maxLength: 32 }), {
          minItems: 1,
          maxItems: 50,
        })
      return Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: 50,
      })
    case "contains":
      return Type.String({ minLength: 1, maxLength: 300 })
    case "containsAny":
      return Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: 20,
      })
  }
}

const opBagSchemaForField = (field: FieldDef): TSchema => {
  if (field.filter.tier === "none") {
    return Type.Optional(Type.Object({}, { description: field.description }))
  }
  const opShape: Record<string, TSchema> = {}
  for (const op of field.filter.operators) {
    opShape[op] = Type.Optional(valueSchemaForOp(field, op))
  }
  return Type.Optional(
    Type.Object(opShape, {
      description: `${field.description} (ops: ${field.filter.operators.join("/")})`,
      additionalProperties: false,
    }),
  )
}

// Matches this tool's actual default so the LLM isn't told a value it doesn't use.
const alphaDescription = (defaultAlpha: number): string =>
  defaultAlpha === 0
    ? "Hybrid weight between lexical (BM25) and vector match " +
      "(0 = lexical only, 1 = vector only). Default 0 — LEXICAL ONLY; the " +
      "embedder is not blended in. Only set this (e.g. 0.5–1) when you " +
      "deliberately want semantic/vector matching instead of exact lexical."
    : "Hybrid weight between lexical (BM25 + nativeRank) and vector match " +
      `(0 = lexical only, 1 = vector only). Default ${String(defaultAlpha)} ` +
      "for both plain and filtered queries (the vector still votes inside a " +
      "filtered set). Set to 0 for rare proper-noun queries the embedder " +
      "doesn't know; 1 for pure semantic discovery."

const buildParamsSchema = (
  fields: ReadonlyArray<FieldDef>,
  defaultAlpha: number,
  defaultLimit: number,
  maxLimit: number,
  semanticChannel: boolean,
): TSchema => {
  const exposed = fields.filter((f) => f.filter.tier !== "none")
  const filtersShape: Record<string, TSchema> = {}
  for (const field of exposed) {
    filtersShape[field.name] = opBagSchemaForField(field)
  }
  const shape: Record<string, TSchema> = {
    query: Type.Optional(
      Type.String({
        description:
          "Short, content-focused search query — 3-8 important KEYWORDS is " +
          "usually best (drives exact lexical / BM25 matching). Omit when you " +
          "are only filtering by structured filters under `filters`." +
          (semanticChannel
            ? " Pair it with `semantic_query` (a full sentence) for best results."
            : ""),
        minLength: 2,
        maxLength: 200,
      }),
    ),
    ...(semanticChannel
      ? {
          semantic_query: Type.Optional(
            Type.String({
              description:
                "A fluent natural-language SENTENCE describing the document " +
                'you want (e.g. "The minimum notice period required to ' +
                'terminate the agreement and the penalty for early ' +
                'termination"). This is EMBEDDED for semantic / vector matching, ' +
                "while `query` (keywords) drives exact lexical matching. " +
                "Always pass BOTH — keywords in `query`, a real sentence here " +
                "— so each retrieval channel gets its ideal phrasing.",
              minLength: 2,
              maxLength: 400,
            }),
          ),
        }
      : {}),
    alpha: Type.Optional(
      Type.Number({
        description: alphaDescription(defaultAlpha),
        minimum: 0,
        maximum: 1,
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        description:
          `Maximum hits to return per call (1–${String(maxLimit)}). Default ` +
          `${String(defaultLimit)}. Paginate the same query with \`offset\` ` +
          "to drain the result set page-by-page beyond this cap.",
        minimum: 1,
        maximum: maxLimit,
      }),
    ),
    offset: Type.Optional(
      Type.Number({
        description:
          "Skip the first N results. Use with `limit` to paginate the SAME " +
          "query/filter set — call again with `offset = previous_offset + " +
          "previous_limit` (the response's `next_offset` gives you this " +
          "directly). Ranking is deterministic so pages never overlap. " +
          "Cap: 1000.",
        minimum: 0,
        maximum: 1000,
      }),
    ),
    filter: Type.Optional(
      Type.Boolean({
        description:
          "When true, an extra LLM pass scores each retrieved candidate " +
          "against the user's original question and drops ones that clearly " +
          "can't help answer it. Requires `questionContext`. Adds one LLM " +
          "round-trip (~2-5s extra latency).",
      }),
    ),
    questionContext: Type.Optional(
      Type.String({
        description:
          "Required when `filter=true` — the user's ORIGINAL question, " +
          "verbatim (not your rewritten search query). The filter LLM needs " +
          "the original framing to judge relevance correctly.",
        minLength: 1,
        maxLength: 2000,
      }),
    ),
    filters: Type.Optional(
      Type.Object(filtersShape, {
        description:
          "Structured filters as nested operator bags: " +
          `\`{ <field>: { <op>: <value> } }\`. See per-field descriptions ` +
          "for available ops.",
        additionalProperties: false,
      }),
    ),
  }
  return Type.Object(shape, { additionalProperties: false })
}

const stringOrUndef = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined
const numberOrUndef = (v: unknown): number | undefined =>
  typeof v === "number" ? v : undefined
const booleanOrUndef = (v: unknown): boolean | undefined =>
  typeof v === "boolean" ? v : undefined

/** Build per-doc chunks (full text, with their original chunk_index) for the
 *  filter LLM. Mirrors search.ts's candidateChunksForFilter. */
const candidateChunksForFilter = (
  fields: Record<string, unknown>,
): Array<{ index: number; text: string }> => {
  const top = topChunkIndices(fields, CHUNKS_PER_DOC_FOR_FILTER)
  const out: Array<{ index: number; text: string }> = []
  for (const c of top) {
    const text = snippetForLeanChunk(fields, c.index)
    if (text) out.push({ index: c.index, text })
  }
  if (out.length === 0) {
    const text = snippetForLeanChunk(fields, 0)
    if (text) out.push({ index: 0, text })
  }
  return out
}

const dateBoundForOp = (op: Operator): "lower" | "upper" => {
  if (op === "lt" || op === "lte") return "upper"
  return "lower"
}

const coerceOpValue = (
  field: FieldDef,
  op: Operator,
  raw: unknown,
): string | number | ReadonlyArray<string | number> | undefined => {
  if (raw === undefined || raw === null) return undefined
  const isDateEncoded =
    field.dataType === "date" &&
    field.filter.tier === "range" &&
    field.filter.encoding === "yyyymmddInt"

  const coerceOne = (v: unknown): string | number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v
    if (typeof v === "boolean") return v ? 1 : 0
    if (typeof v === "string") {
      if (isDateEncoded) {
        const n = isoDateToInt(v, dateBoundForOp(op))
        if (n === null) {
          throw new Error(
            `${field.name}.${op}: could not parse "${v}" as a date — use YYYY, YYYY-MM, or YYYY-MM-DD`,
          )
        }
        return n
      }
      if (field.dataType === "number") {
        const n = Number(v)
        return Number.isFinite(n) ? n : null
      }
      return v.length > 0 ? v : null
    }
    return null
  }

  if (Array.isArray(raw)) {
    const out: Array<string | number> = []
    for (const elem of raw) {
      const c = coerceOne(elem)
      if (c !== null) out.push(c)
    }
    return out.length > 0 ? out : undefined
  }
  const c = coerceOne(raw)
  return c === null ? undefined : c
}

/** Translate the tool's raw params bag into UnifiedSearchParams. Mirrors
 *  search.ts's toUnifiedParams. */
const toUnifiedParams = (
  p: Params,
  fields: ReadonlyArray<FieldDef>,
  limit: number,
  offset: number,
  defaultAlpha: number,
  semanticChannel: boolean,
): UnifiedSearchParams => {
  const rawFiltersBag = p["filters"]
  const filtersIn: Record<string, unknown> =
    rawFiltersBag && typeof rawFiltersBag === "object"
      ? (rawFiltersBag as Record<string, unknown>)
      : {}

  const filtersOut: Record<string, FilterOperatorBag> = {}
  for (const field of fields) {
    if (field.filter.tier === "none") continue
    const fieldBagRaw = filtersIn[field.name]
    if (!fieldBagRaw || typeof fieldBagRaw !== "object") continue
    const fieldBag = fieldBagRaw as Record<string, unknown>
    const outBag: FilterOperatorBag = {}
    for (const op of field.filter.operators) {
      const coerced = coerceOpValue(field, op, fieldBag[op])
      if (coerced !== undefined) {
        outBag[op] = coerced
      }
    }
    if (Object.keys(outBag).length > 0) {
      filtersOut[field.name] = outBag
    }
  }

  const explicitAlpha = numberOrUndef(p["alpha"])
  // Filters do NOT force alpha to 0 — keep defaultAlpha so the vector channel
  // stays active inside a filtered set. LLM can override.
  const alpha = explicitAlpha ?? defaultAlpha
  const queryStr = stringOrUndef(p["query"])
  const semanticStr = semanticChannel
    ? stringOrUndef(p["semantic_query"])
    : undefined

  return {
    ...(queryStr ? { query: queryStr } : {}),
    ...(semanticStr ? { semanticQuery: semanticStr } : {}),
    alpha,
    limit,
    offset,
    ...(Object.keys(filtersOut).length > 0 ? { filters: filtersOut } : {}),
  }
}

// Same arg shape as buildVespaSearchTool, so the registry builds this identically.
export type SearchToolArgs = {
  userEmail: string
  logger: Log
  agentScope?: AgentScope
  llm?: LlmHandle
}

export const buildProximitySearchTool = (
  va: SearchToolArgs,
): ReturnType<typeof defineTool> => {
  const toolName = TOOL_NAME
  const fields = getSearchFilterFields()
  // Fed to both the schema (param description) and toUnifiedParams (runtime
  // default) so they stay in lockstep.
  const defaultAlpha = DEFAULT_ALPHA
  const defaultLimit = DEFAULT_LIMIT
  const maxLimit = MAX_LIMIT
  const chunksPerDoc = TOP_CHUNKS_PER_DOC
  const semanticChannel = SEMANTIC_CHANNEL
  const paramsSchema = buildParamsSchema(
    fields,
    defaultAlpha,
    defaultLimit,
    maxLimit,
    semanticChannel,
  )
  const description = `${DESCRIPTION_INTRO}\n\n${buildDescription(fields, chunksPerDoc)}`
  const promptSnippet = PROMPT_SNIPPET

  return defineTool({
    name: toolName,
    label: TOOL_LABEL,
    description,
    promptSnippet,
    parameters: paramsSchema,
    async execute(toolCallId, raw) {
      const log = va.logger.child({ toolName, toolCallId })

      if (!Value.Check(paramsSchema, raw)) {
        const errs = [...Value.Errors(paramsSchema, raw)].slice(0, 6)
        const detail = errs
          .map((e) => `${e.path || "/"}: ${e.message}`)
          .join("; ")
        const msg =
          `${toolName} refused: invalid arguments — ${detail}. ` +
          "Every filter (folder, app, …) MUST be nested under `filters` as " +
          "`{ <field>: { <op>: <value> } }` — e.g. " +
          `\`filters: { folder: { contains: "Legal/Circulars" } }\`. ` +
          "Do not pass filter fields, or any unlisted key, as a top-level " +
          "argument. Only query/alpha/limit/offset/filter/questionContext/" +
          "filters are accepted."
        log.info({ detail }, `tool: ${toolName} refused (invalid arguments)`)
        return textResult(msg, { error: "invalid_arguments", detail }, true)
      }

      const p = raw as Params
      const startedAt = Date.now()
      const limit = Math.min(
        Math.max(numberOrUndef(p["limit"]) ?? defaultLimit, 1),
        maxLimit,
      )
      const offset = Math.max(0, Math.min(numberOrUndef(p["offset"]) ?? 0, 1000))

      const agentSaysFilter = va.agentScope?.searchFilterEnabled ?? true
      const llmOptedIn = booleanOrUndef(p["filter"]) === true
      const filterRequested = agentSaysFilter && (llmOptedIn || true)
      const questionContextRaw = stringOrUndef(p["questionContext"])
      const queryParam = stringOrUndef(p["query"])
      const questionContextResolved =
        questionContextRaw?.trim() || queryParam?.trim() || ""

      if (filterRequested && !va.llm) {
        log.warn(
          `tool: ${toolName} — filter on (per-agent setting) but no LLM ` +
            "handle plumbed; running unfiltered",
        )
      }
      if (!agentSaysFilter && llmOptedIn) {
        log.info(
          `tool: ${toolName} — LLM passed filter=true but agent has ` +
            "searchFilterEnabled=false; skipping filter pass",
        )
      }

      // Also where date-parse errors surface.
      let unified: UnifiedSearchParams
      try {
        unified = toUnifiedParams(
          p,
          fields,
          limit,
          offset,
          defaultAlpha,
          semanticChannel,
        )
        // The point of this variant: pin the rank profile.
        unified.rankProfile = RANK_PROFILE
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.info({ err: msg }, `tool: ${toolName} refused (bad input)`)
        return textResult(`${toolName} refused: ${msg}`, { error: msg }, true)
      }

      if (!unified.query && !hasAnyFilter(unified)) {
        log.info(`tool: ${toolName} refused — no query and no filter`)
        const filterNames =
          fields.length > 0
            ? fields.map((f) => f.name).join(" / ")
            : "(no structured filters configured)"
        return textResult(
          `${toolName} refused: pass at least a \`query\` or one structured ` +
            `filter (${filterNames}).`,
          { error: "empty_query_and_filters" },
          true,
        )
      }

      log.info(
        {
          query: unified.query,
          ...(unified.semanticQuery
            ? { semanticQuery: unified.semanticQuery }
            : {}),
          alpha: unified.alpha,
          rankProfile: unified.rankProfile,
          limit,
          offset: offset || undefined,
          filters: unified.filters,
          filter: filterRequested,
          agentScoped: !!va.agentScope,
        },
        `tool: ${toolName} start`,
      )

      try {
        const resp = await runUnifiedSearch(unified, {
          logger: log,
          ...(va.agentScope ? { agentScope: va.agentScope } : {}),
          userEmail: va.userEmail,
        })
        const cursor = computeCursor(resp, offset, limit)
        const children: VespaHit[] = resp.root?.children ?? []

        type HitView = {
          rank: number
          docId: string
          score: number
          title: string
          aiSummary: string | null
          documentDate: string | null
          totalChunks: number | undefined
          chunksMap:
            | Array<{ chunk_index: number; page_numbers?: number[] }>
            | undefined
          fields: Record<string, unknown>
        }
        const views: HitView[] = children.map((hit, i) => {
          const fields = (hit?.fields ?? {}) as Record<string, unknown>
          const rawDocId = fields["docId"]
          const docId = typeof rawDocId === "string" ? rawDocId : ""
          const title = titleOf({
            title: fields["title"] as string | undefined,
            fileName: fields["fileName"] as string | undefined,
            docId,
          })
          const score = typeof hit?.relevance === "number" ? hit.relevance : 0
          const aiSummary =
            typeof fields["ai_summary"] === "string"
              ? fields["ai_summary"]
              : null
          const rawDate = fields["document_date"]
          const documentDate =
            typeof rawDate === "number"
              ? intDateToIso(rawDate)
              : typeof rawDate === "string"
                ? rawDate
                : null
          const chunksMap = fields["chunks_map"] as
            | Array<{ chunk_index: number; page_numbers?: number[] }>
            | undefined
          const totalChunks = Array.isArray(chunksMap)
            ? chunksMap.length
            : undefined
          return {
            rank: offset + i + 1,
            docId,
            score,
            title,
            aiSummary,
            documentDate,
            totalChunks,
            chunksMap,
            fields,
          }
        })

        let dropped: Array<{ docId: string; reason: string }> = []
        let keptViews: HitView[] = views
        const keptInfoByDocId = new Map<
          string,
          { reasoning: string; relevantChunkIndices: number[] }
        >()
        if (
          filterRequested &&
          va.llm &&
          views.length > 0 &&
          questionContextResolved
        ) {
          const candidates: FilterCandidate[] = views.map((v) => ({
            docId: v.docId,
            rank: v.rank,
            title: v.title,
            aiSummary: v.aiSummary,
            chunks: candidateChunksForFilter(v.fields),
            documentDate: v.documentDate,
            ...(typeof v.fields["document_id"] === "string"
              ? { documentId: v.fields["document_id"] }
              : {}),
            ...(Array.isArray(v.fields["entities_involved"])
              ? {
                  entities: (
                    v.fields["entities_involved"] as unknown[]
                  ).filter((s): s is string => typeof s === "string"),
                }
              : {}),
          }))
          const appliedFilters = summarizeAppliedFilters(unified)
          const decision = await runLlmFilter(
            questionContextResolved,
            unified.query ?? "(no semantic query — pure structured filter)",
            appliedFilters,
            candidates,
            va.llm,
            log,
          )
          const keptSet = new Set(decision.kept.map((k) => k.docId))
          for (const k of decision.kept) {
            keptInfoByDocId.set(k.docId, {
              reasoning: k.reasoning,
              relevantChunkIndices: k.relevantChunkIndices,
            })
          }
          keptViews = views.filter((v) => keptSet.has(v.docId))
          dropped = decision.dropped
          log.info(
            {
              kept: keptViews.length,
              dropped: dropped.length,
              totalSeen: views.length,
            },
            `tool: ${toolName} filter applied`,
          )
        }

        if (keptViews.length === 0) {
          const headerAttrs =
            `query=${JSON.stringify(unified.query ?? "")} ` +
            `offset="${String(offset)}" hits="0"` +
            (cursor.totalCount !== null
              ? ` total_count="${String(cursor.totalCount)}"`
              : "") +
            (dropped.length > 0
              ? ` filtered_out="${String(dropped.length)}"`
              : "")
          log.info(
            { hits: 0, offset, durationMs: Date.now() - startedAt },
            `tool: ${toolName} done (empty)`,
          )
          return textResult(`<search_results ${headerAttrs}/>`, {
            hits: 0,
            query: unified.query,
            offset,
            totalCount: cursor.totalCount,
            nextOffset: cursor.hasMore ? cursor.nextOffset : null,
            hasMore: cursor.hasMore,
            filterKept: [],
            filterDropped: dropped,
          })
        }

        const lines: string[] = []
        const headerAttrs =
          `query=${JSON.stringify(unified.query ?? "")} ` +
          `offset="${String(offset)}" hits="${String(keptViews.length)}"` +
          (cursor.totalCount !== null
            ? ` total_count="${String(cursor.totalCount)}"`
            : "") +
          (cursor.hasMore
            ? ` next_offset="${String(cursor.nextOffset)}"`
            : "") +
          (dropped.length > 0
            ? ` filtered_out="${String(dropped.length)}"`
            : "")
        lines.push(`<search_results ${headerAttrs}>`)

        const details: Array<{
          rank: number
          docId: string
          chunkIndex: number | null
          chunkIndices: number[]
          score: number
          title: string
          aiSummary: string | null
          documentDate: string | null
          filterReasoning: string | null
          relevantChunkIndices: number[] | null
        }> = []

        for (const v of keptViews) {
          const topChunks = topChunkIndices(v.fields, chunksPerDoc)
          const renderedChunks = topChunks
            .map((c) => {
              const snippet = snippetForLeanChunk(v.fields, c.index)
              const pages = Array.isArray(v.chunksMap)
                ? formatPages(
                    v.chunksMap.find((m) => m.chunk_index === c.index)
                      ?.page_numbers,
                  )
                : ""
              return { ...c, snippet, pages }
            })
            .filter((c) => c.snippet)

          const keptInfo = keptInfoByDocId.get(v.docId) ?? null

          lines.push(
            `  <hit rank="${String(v.rank)}" docId=${JSON.stringify(v.docId)} ` +
              `score="${v.score.toFixed(4)}"` +
              (v.documentDate
                ? ` document_date=${JSON.stringify(v.documentDate)}`
                : "") +
              (keptInfo && keptInfo.relevantChunkIndices.length > 0
                ? ` relevant_chunk_indices="${keptInfo.relevantChunkIndices.join(",")}"`
                : "") +
              `${typeof v.totalChunks === "number" ? ` total_chunks="${String(v.totalChunks)}"` : ""}>`,
          )
          lines.push(`    <title>${v.title}</title>`)
          if (keptInfo && keptInfo.reasoning) {
            lines.push(
              `    <filter_reasoning>${truncate(keptInfo.reasoning, 500)}</filter_reasoning>`,
            )
          }
          if (v.aiSummary) {
            lines.push(
              `    <ai_summary>${truncate(v.aiSummary, 2000)}</ai_summary>`,
            )
          }
          for (const c of renderedChunks) {
            lines.push(
              `    <chunk chunk_index="${String(c.index)}" ` +
                `score="${c.score.toFixed(4)}"` +
                `${c.pages ? ` pages="${c.pages}"` : ""}` +
                ` cite="[${v.docId}#${String(c.index)}]">` +
                `${c.snippet}</chunk>`,
            )
          }
          lines.push(`  </hit>`)

          details.push({
            rank: v.rank,
            docId: v.docId,
            chunkIndex: renderedChunks[0]?.index ?? null,
            chunkIndices: renderedChunks.map((c) => c.index),
            score: v.score,
            title: v.title,
            aiSummary: v.aiSummary,
            documentDate: v.documentDate,
            filterReasoning: keptInfo?.reasoning ?? null,
            relevantChunkIndices: keptInfo?.relevantChunkIndices ?? null,
          })
        }

        if (dropped.length > 0) {
          lines.push(
            `  <filter_summary dropped="${String(dropped.length)}" kept="${String(keptViews.length)}">`,
          )
          for (const d of dropped.slice(0, 30)) {
            lines.push(
              `    <dropped docId=${JSON.stringify(d.docId)}>${truncate(d.reason, 200)}</dropped>`,
            )
          }
          lines.push(`  </filter_summary>`)
        }

        lines.push(`</search_results>`)
        if (cursor.hasMore) {
          const remaining =
            cursor.totalCount !== null
              ? cursor.totalCount - cursor.nextOffset
              : null
          lines.push(
            `\n⚠️ MORE RESULTS AVAILABLE — your DEFAULT next action is to ` +
              `call \`${toolName}\` again with the same query/filters plus ` +
              `\`offset=${String(cursor.nextOffset)}\`` +
              (remaining !== null
                ? ` (${String(remaining)} hits remaining of ${String(cursor.totalCount)} total).`
                : ".") +
              ` Do NOT stop after this page unless you have explicitly ` +
              `gathered enough to fully answer the user's question, the next ` +
              `page is clearly off-topic, or the question was a one-shot lookup. ` +
              `For survey/"list every X"/"all in <period>" questions, KEEP ` +
              `PAGINATING until \`next_offset\` no longer appears.`,
          )
        } else {
          lines.push(
            `\nNo more pages for this query. Drill in with \`getChunks\` ` +
              `(docId + chunk_index range) for full context, or ` +
              `\`searchWithinDoc\` for other relevant chunks in the same doc.`,
          )
        }

        log.info(
          {
            hits: details.length,
            offset,
            nextOffset: cursor.hasMore ? cursor.nextOffset : undefined,
            totalCount: cursor.totalCount,
            filterDropped: dropped.length,
            topDocId: details[0]?.docId,
            durationMs: Date.now() - startedAt,
          },
          `tool: ${toolName} done`,
        )
        const filterKeptPayload = Array.from(keptInfoByDocId.entries()).map(
          ([docId, info]) => ({
            docId,
            reasoning: info.reasoning,
            relevantChunkIndices: info.relevantChunkIndices,
          }),
        )
        return textResult(lines.join("\n"), {
          query: p.query,
          hits: details,
          offset,
          totalCount: cursor.totalCount,
          nextOffset: cursor.hasMore ? cursor.nextOffset : null,
          hasMore: cursor.hasMore,
          filterKept: filterKeptPayload,
          filterDropped: dropped,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn(
          { err, query: queryParam, durationMs: Date.now() - startedAt },
          `tool: ${toolName} failed`,
        )
        return textResult(`${toolName} failed: ${msg}`, { error: msg }, true)
      }
    },
  })
}
