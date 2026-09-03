
/* eslint-disable @typescript-eslint/naming-convention --
 * Vespa schema uses snake_case field names; the YQL strings we build mirror
 * those names so the query matches what the schema declares. */
// Shared retrieval/scoring core for vespaSearch and metadataSearch — both
// tools delegate their Vespa call (and the optional in-tool LLM relevance
// filter) here so they stay in lockstep.

import config from "@/config"

import type { AgentScope } from "../../../agent-scope"
import type { Log } from "../../../log"
import { resolveFolderPathsToClFds } from "./folderResolver"
import { getSearchFilterFields } from "./searchFilterConfig"
import type { FieldDef, Operator } from "./searchFilterConfig"

/** Canonical YAML name of the folder-scoping field. Intercepted in
 *  `buildWhereClause` (resolved via DB, emitted as `clFd in (...)`); skipped
 *  by the generic per-field loop. */
const FOLDER_FILTER_FIELD = "folder"

// ─── Shared types ───

export type VespaHitFields = Record<string, unknown>
export type VespaHit = {
  relevance?: number
  fields?: VespaHitFields
}
export type VespaSearchResponse = {
  root?: {
    fields?: { totalCount?: number }
    children?: VespaHit[]
  }
}

/** Per-operator value bag the LLM passes for one field. Values must ALREADY
 *  be coerced to YQL-emit form: number (number/date types) or string for
 *  eq/gt/gte/lt/lte; array for in/nin; string for contains; string[] for
 *  containsAny. Dates arrive as ints (tool layer's isoDateToInt) so parse
 *  errors surface as tool errors, not silently-dropped clauses. */
export type FilterOperatorBag = Partial<
  Record<Operator, string | number | ReadonlyArray<string | number>>
>

export type UnifiedSearchParams = {
  /** When omitted/empty, no `userInput` clause and ranking falls back to
   *  `unranked` — the WHERE clause IS the answer set (pure metadata lookup). */
  query?: string
  /** Separate query used ONLY for the vector embedding (e5): lexical
   *  `userInput(@query)` still matches `query` (keywords) but the embedding
   *  comes from this fluent sentence — each channel gets its ideal phrasing.
   *  Falls back to `query` when omitted. */
  semanticQuery?: string
  /** Hybrid weight: 0 = lexical only (skip nearestNeighbor + embed call),
   *  0.5 = balanced, 1 = vector only. Only meaningful when `query` is set. */
  alpha?: number
  rankProfile?: string
  /** Page size (max 50). */
  limit: number
  /** Hits to skip; caller passes `next_offset` from a previous response. */
  offset: number
  /** Filter bag keyed by field `name` from `searchFilterConfig`, then by
   *  operator. Empty/missing keys produce no clause. */
  filters?: Record<string, FilterOperatorBag | undefined>
}

/** True if at least one filter has a non-empty operator value. Tools use it
 *  to enforce "at least one filter required" policies. */
export const hasAnyFilter = (params: UnifiedSearchParams): boolean => {
  if (!params.filters) return false
  for (const bag of Object.values(params.filters)) {
    if (!bag) continue
    for (const v of Object.values(bag)) {
      if (v === undefined || v === null) continue
      if (typeof v === "string" && v.length === 0) continue
      if (Array.isArray(v) && v.length === 0) continue
      return true
    }
  }
  return false
}

export type UnifiedSearchCtx = {
  logger: Log
  agentScope?: AgentScope
  /** Unscoped sessions still pin `createdBy` to this email, matching the
   *  safety default in vespa-ts's `searchVespaKnowledgeBase`. */
  userEmail?: string
}

// ─── YQL building ───

const yqlString = (s: string): string =>
  `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

const inClause = (field: string, values: readonly string[]): string =>
  `${field} in (${values.map(yqlString).join(", ")})`

const containsAnyClause = (
  field: string,
  values: readonly string[],
): string =>
  `(${values.map((v) => `${field} contains ${yqlString(v)}`).join(" or ")})`

/** Agent-scope visibility gate. With KB collection selections (a scoped
 *  agent), allowlist by clId/clFd/docId — same gate vespa-ts's
 *  `buildCollectionFileYQL` emits. With no scope, fall back to `createdBy
 *  contains email`, mirroring `searchVespaKnowledgeBase`'s default. */
const visibilityGate = (ctx: UnifiedSearchCtx): string | null => {
  const scope = ctx.agentScope
  if (scope?.collectionSelections.length) {
    const ids: string[] = []
    const folderIds: string[] = []
    const fileIds: string[] = []
    for (const s of scope.collectionSelections) {
      if (s.collectionIds?.length) ids.push(...s.collectionIds)
      if (s.collectionFolderIds?.length)
        folderIds.push(...s.collectionFolderIds)
      if (s.collectionFileIds?.length) fileIds.push(...s.collectionFileIds)
    }
    const parts: string[] = []
    if (ids.length) parts.push(inClause("clId", ids))
    if (folderIds.length) parts.push(inClause("clFd", folderIds))
    if (fileIds.length) parts.push(inClause("itemId", fileIds))
    if (parts.length) return `(${parts.join(" or ")})`
  }
  // Fail closed: no collection allowlist was produced (no scope, or a scope
  // with empty selections) — pin to the caller's own documents. Returning null
  // here would let an apps-only / empty-scope agent read the whole index.
  if (ctx.userEmail) {
    return `createdBy contains ${yqlString(ctx.userEmail.trim())}`
  }
  return null
}

// ─── Operator → YQL ───
//
// One emitter per op, each returning one AND-able clause or `null` (dropped).
// Op legality per field is already validated via `searchFilterConfig`; these
// only guard against wrong-shape / empty values.

const isNumericType = (dt: FieldDef["dataType"]): boolean =>
  dt === "number" || dt === "date"

/** Value → YQL literal (number bare, string quoted); null on shape mismatch. */
const renderLiteral = (
  v: unknown,
  dt: FieldDef["dataType"],
  bound: "lower" | "upper" = "lower",
): string | null => {
  if (isNumericType(dt)) {
    // Accept model-sent strings for numeric/date fields instead of dropping
    // them: a dropped clause silently unfilters the query and makes the agent
    // think the filter failed, so it loops re-searching. Dates are stored as
    // YYYYMMDD longs, so coerce ISO/loose strings via isoDateToInt; numbers
    // accept numeric strings.
    if (typeof v === "number") {
      return Number.isFinite(v) ? String(v) : null
    }
    if (typeof v === "string" && v.trim().length > 0) {
      if (dt === "date") {
        const n = isoDateToInt(v, bound)
        return n !== null ? String(n) : null
      }
      const n = Number(v.trim())
      return Number.isFinite(n) ? String(n) : null
    }
    return null
  }
  if (dt === "boolean") {
    if (typeof v === "boolean") return v ? "true" : "false"
    return null
  }
  if (typeof v === "string" && v.length > 0) return yqlString(v)
  return null
}

/** Value(s) → array of validated YQL literals (single wrapped, array filtered). */
const renderLiteralList = (
  v: unknown,
  dt: FieldDef["dataType"],
): string[] => {
  const out: string[] = []
  const arr = Array.isArray(v) ? v : [v]
  for (const elem of arr) {
    const rendered = renderLiteral(elem, dt)
    if (rendered !== null) out.push(rendered)
  }
  return out
}

/** YQL for one (field, op, value) triple; null on missing/malformed input
 *  (the `buildWhereClause` loop skips it, rest of the filters still apply). */
const clauseForFieldOp = (
  field: FieldDef,
  op: Operator,
  value: unknown,
): string | null => {
  if (value === undefined || value === null) return null
  const f = field.vespaField
  switch (op) {
    case "eq": {
      const lit = renderLiteral(value, field.dataType)
      if (lit === null) return null
      return `${f} = ${lit}`
    }
    case "in": {
      const lits = renderLiteralList(value, field.dataType)
      if (lits.length === 0) return null
      return `${f} in (${lits.join(", ")})`
    }
    case "nin": {
      const lits = renderLiteralList(value, field.dataType)
      if (lits.length === 0) return null
      return `!(${f} in (${lits.join(", ")}))`
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const lit = renderLiteral(
        value,
        field.dataType,
        op === "lt" || op === "lte" ? "upper" : "lower",
      )
      if (lit === null) return null
      const sym = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[op]
      return `${f} ${sym} ${lit}`
    }
    case "contains": {
      if (typeof value !== "string" || value.length === 0) return null
      return `${f} contains ${yqlString(value)}`
    }
    case "containsAny": {
      const arr = Array.isArray(value)
        ? value.filter((s): s is string => typeof s === "string" && s.length > 0)
        : typeof value === "string" && value.length > 0
          ? [value]
          : []
      if (arr.length === 0) return null
      return containsAnyClause(f, arr)
    }
  }
}

/** Folder paths out of the filter bag (no DB hit yet); deduped + trimmed. */
const extractFolderPaths = (p: UnifiedSearchParams): string[] => {
  const bag = p.filters?.[FOLDER_FILTER_FIELD]
  if (!bag) return []
  const out = new Set<string>()
  const add = (v: unknown): void => {
    if (typeof v === "string") {
      const t = v.trim()
      if (t) out.add(t)
    }
  }
  add(bag["contains"])
  const any = bag["containsAny"]
  if (Array.isArray(any)) {
    for (const v of any) add(v)
  }
  return Array.from(out)
}

/** Compose the WHERE clause: retrieval primitive (`userInput` ±
 *  `nearestNeighbor`) AND'd with every structured filter + the visibility
 *  gate. Returns `null` when neither query nor filter is given — Vespa
 *  rejects an empty WHERE, and "no filters" is a tool-level concept, not a
 *  YQL one. Folder is intercepted here (needs an async path → UUID DB lookup
 *  before it can render as `clFd in (...)`; see `resolveFolderPathsToClFds`). */
const buildWhereClause = async (
  p: UnifiedSearchParams,
  ctx: UnifiedSearchCtx,
): Promise<string | null> => {
  const clauses: string[] = []

  // 1. Retrieval primitive.
  // alpha == 0 → lexical only (skip NN + embed); also surfaces rare-token
  //   matches the dense embedder doesn't know (the Pacheli case).
  // alpha > 0  → hybrid (OR userInput with NN). targetHits must cover the
  //   requested page, else WAND caps at ~limit and offset past the pool
  //   returns empty (same bug PR1 fixed on the userInput side).
  if (p.query && p.query.trim()) {
    if (resolveAlpha(p) > 0) {
      const targetHits = Math.max(p.limit + p.offset, 200)
      clauses.push(
        `(userInput(@query) or ({targetHits:${String(targetHits)}}nearestNeighbor(chunk_embeddings, e)))`,
      )
    } else {
      clauses.push(`userInput(@query)`)
    }
  }

  // 2a. Folder filter — intercepted before the generic loop: resolving a
  //     path → folder UUID(s) needs an async DB hit, emitted as `clFd in
  //     (...)` (the field is known by `folder`, which doesn't exist in
  //     Vespa). Unresolved paths are dropped so a typo can't lock out all
  //     results; the rest of the query still runs.
  const folderPaths = extractFolderPaths(p)
  if (folderPaths.length > 0) {
    const clFds = await resolveFolderPathsToClFds(folderPaths)
    if (clFds.length > 0) {
      clauses.push(inClause("clFd", clFds))
    } else {
      ctx.logger.warn(
        { folderPaths },
        "folder filter resolved to zero clFd UUIDs — paths may not exist; emitting query without folder scope",
      )
    }
  }

  // 2b. Structured filters — one clause per (field, op, value) triple.
  //     Illegal operators were stripped at YAML-load; trusted, not re-checked.
  const fields = getSearchFilterFields()
  for (const field of fields) {
    if (field.filter.tier === "none") continue
    if (field.name === FOLDER_FILTER_FIELD) continue // handled in 2a
    const bag = p.filters?.[field.name]
    if (!bag) continue
    for (const op of field.filter.operators) {
      const value = bag[op]
      if (value === undefined) continue
      const clause = clauseForFieldOp(field, op, value)
      if (clause) clauses.push(clause)
    }
  }

  // 3. Visibility gate — MANDATORY. A kb_items query with no per-user / agent-
  //    scope constraint reads across all tenants, so refuse when the gate can't
  //    be built (fail closed) rather than emitting an unconstrained query.
  const gate = visibilityGate(ctx)
  if (!gate) return null
  clauses.push(gate)

  return clauses.join(" and ")
}

/** Effective alpha. Default 0.7 for query-only (lean semantic), 0.2 when
 *  filters are present (they narrow the set, so semantic recall buys less but
 *  still helps rank within it). Explicit `alpha` overrides. */
const resolveAlpha = (p: UnifiedSearchParams): number => {
  if (typeof p.alpha === "number") return p.alpha
  return hasAnyFilter(p) ? 0.2 : 0.7
}

/** Summary of in-effect filters, fed to the relevance-filter LLM as
 *  `<applied_filters>` so it judges "off-topic" against the actual scope.
 *  Walks the same config as `buildWhereClause` so strings stay in sync.
 *  Format `field.op=value` joined by "; ", arrays bracketed, e.g.
 *  `document_date.gte=20240101; pan_ids.in=[AAACH7852C]`. */
export const summarizeAppliedFilters = (p: UnifiedSearchParams): string => {
  if (!p.filters) {
    return "(no structured filters — purely semantic / keyword search)"
  }
  const parts: string[] = []
  for (const field of getSearchFilterFields()) {
    if (field.filter.tier === "none") continue
    const bag = p.filters[field.name]
    if (!bag) continue
    for (const op of field.filter.operators) {
      const value = bag[op]
      if (value === undefined || value === null) continue
      if (typeof value === "string" && value.length === 0) continue
      if (Array.isArray(value) && value.length === 0) continue
      const rendered = Array.isArray(value)
        ? `[${value.map((v) => String(v)).join(", ")}]`
        : String(value)
      parts.push(`${field.name}.${op}=${rendered}`)
    }
  }
  return parts.length
    ? parts.join("; ")
    : "(no structured filters — purely semantic / keyword search)"
}

/** Top-scoring chunks the `lean` summary materializes per hit (sent as
 *  input.query(summary_chunks)). Tunable via VESPA_SUMMARY_CHUNKS_PER_DOC;
 *  falls back to 5 (the schema default). Read once at module load — restart
 *  to pick up env changes, same policy as searchFilterConfig. */
const SUMMARY_CHUNKS_PER_DOC = ((): number => {
  const fallback = 5
  const raw = process.env["VESPA_SUMMARY_CHUNKS_PER_DOC"]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.floor(n)
})()

/** E5-instruct query-side task. The embedder
 *  (`intfloat/multilingual-e5-large-instruct`) is ASYMMETRIC: queries wrap as
 *  `Instruct: <task>\nQuery: <q>`, passages embed RAW (ingest already does
 *  this — DO NOT prefix documents, no reindex). Applied ONLY when
 *  `semanticQuery` is present; the plain query embeds raw. */
const E5_INSTRUCT_TASK =
  "Given a question, retrieve relevant document passages that answer it"

/** Build the JSON body posted to Vespa. Rank profile + alpha + embed params
 *  derive from the query/alpha pair; everything else is pass-through. */
const buildRequestBody = (
  yql: string,
  p: UnifiedSearchParams,
): Record<string, unknown> => {
  const hasQuery = !!(p.query && p.query.trim())
  const alpha = resolveAlpha(p)
  const body: Record<string, unknown> = {
    yql,
    hits: p.limit,
    timeout: "30s",
    ...(p.offset > 0 ? { offset: p.offset } : {}),
  }
  if (hasQuery) {
    body["query"] = p.query
    body["ranking.profile"] = p.rankProfile ?? "default_native"
    body["input.query(alpha)"] = alpha
    // Lean summary prunes the chunk payload (top_chunks_summary) to the top
    // query(summary_chunks) chunks on the content nodes, vs every chunk of
    // every hit like `default`.
    body["presentation.summary"] = "lean"
    body["input.query(summary_chunks)"] = SUMMARY_CHUNKS_PER_DOC
    // Only compute the embedding when we use it — saves an embedder hop for
    // lexical-only / pure-filter calls.
    if (alpha > 0) {
      // Embed via a dedicated `e5_query` (not `query`) so the Instruct:/Query:
      // scaffolding never leaks into the lexical `userInput(@query)` BM25
      // clause. No semanticQuery → embed the bare query, no prefix.
      if (p.semanticQuery && p.semanticQuery.trim()) {
        body["e5_query"] = `Instruct: ${E5_INSTRUCT_TASK}\nQuery: ${p.semanticQuery}`
        body["input.query(e)"] = "embed(@e5_query)"
      } else {
        body["input.query(e)"] = "embed(@query)"
      }
    }
  } else {
    // Pure filter — ordering doesn't matter, skip the ranker.
    body["ranking"] = "unranked"
  }
  return body
}

// ─── Vespa transport ───

/** POST the unified query to Vespa; throws on HTTP error so callers can
 *  surface a user-facing tool error. */
export const runUnifiedSearch = async (
  params: UnifiedSearchParams,
  ctx: UnifiedSearchCtx,
): Promise<VespaSearchResponse> => {
  const where = await buildWhereClause(params, ctx)
  if (!where) {
    throw new Error(
      "runUnifiedSearch: nothing to query — pass at least a `query` or one " +
        "structured filter (the visibility gate alone is not a valid query).",
    )
  }
  const yql = `select * from kb_items where ${where}`
  const body = buildRequestBody(yql, params)
  const endpoint = `${config.vespaEndpoint.queryEndpoint}/search/`
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`vespa HTTP ${String(res.status)}: ${text.slice(0, 240)}`)
  }
  return (await res.json()) as VespaSearchResponse
}

// ─── Pagination cursor helper ───

export type PaginationCursor = {
  returned: number
  totalCount: number | null
  /** offset + returned — pass back to get the next page. */
  nextOffset: number
  /** Uses totalCount when present, else the heuristic "returned a full page". */
  hasMore: boolean
}

export const computeCursor = (
  resp: VespaSearchResponse,
  offset: number,
  limit: number,
): PaginationCursor => {
  const returned = resp.root?.children?.length ?? 0
  const totalCount =
    typeof resp.root?.fields?.totalCount === "number"
      ? resp.root.fields.totalCount
      : null
  const nextOffset = offset + returned
  const hasMore =
    totalCount !== null ? nextOffset < totalCount : returned === limit
  return { returned, totalCount, nextOffset, hasMore }
}

// ─── Optional in-tool LLM relevance filter ───
//
// One LLM call per candidate in parallel (Promise.allSettled), each judging
// ONE doc against the question. Chosen over one big call: same total tokens
// but latency ~max(per-call) instead of one ~10s call, plus per-doc failure
// isolation (a failed call keeps that doc, the rest go through).

export type LlmHandle = {
  model: string
  baseUrl: string
  apiKey: string
  sessionId?: string | undefined
}

/** One candidate doc passed to the filter. Send FULL ai_summary + FULL chunk
 *  text (no slicing): truncation was the main cause of wrong drops on legal
 *  text where the operative finding lives mid-paragraph. */
export type FilterCandidate = {
  docId: string
  rank: number
  title: string
  aiSummary?: string | null
  /** Top-scoring chunks, full text; index drives `relevantChunkIndices`. */
  chunks: ReadonlyArray<{ index: number; text: string }>
  documentDate?: string | null
  documentId?: string | null
  entities?: ReadonlyArray<string>
}

/** Per-doc decision returned by the filter LLM. */
export type FilterKept = {
  docId: string
  /** 1-2 sentence justification, surfaced to both the agent and the UI. */
  reasoning: string
  /** Chunks (by index) judged relevant — lets the agent prioritize `getChunks`. */
  relevantChunkIndices: number[]
}

export type FilterDecision = {
  kept: FilterKept[]
  dropped: Array<{ docId: string; reason: string }>
}

const PER_DOC_FILTER_SYSTEM_PROMPT = [
  "You are a relevance filter for a document retrieval system.",
  "Given the user's original question, the search query that was run, the ",
  "structured filters the agent applied, and ONE candidate document (title, ",
  "full ai_summary, full text of the top-scoring chunks, and key metadata), ",
  "decide whether this candidate is RELEVANT to the user's question.",
  "",
  "Rules:",
  "1. Err toward KEEPING. Only drop a candidate when you are confident it ",
  "   cannot help answer the user's question. When in doubt, keep it — the ",
  "   main agent will read more chunks and decide.",
  "2. Judge by SUBSTANCE, not literal phrasing. The corpus's drafting ",
  "   vocabulary differs from how users phrase things (e.g. 'exonerated' → ",
  "   'I do not find any merit' / 'not established' / 'stands disposed of'; ",
  "   'manipulation of books of account' → 'misrepresentation of financial ",
  "   statements' / 'round-tripping' / 'inflated revenue' / 'fictitious ",
  "   transactions').",
  "3. If <applied_filters> shows the search was already scoped (e.g. a ",
  "   specific folder or date range), err EVEN HARDER toward keeping — ",
  "   off-topic noise inside a deliberately-narrowed set is rare.",
  "4. Output ONLY a JSON object with this exact shape:",
  '   {"relevant": true|false, "reasoning": "<1-2 sentences>", "relevantChunkIndices": [int, int, ...]}',
  "5. When `relevant` is true, `reasoning` is a 1-2 sentence justification ",
  "   of why this doc helps answer the user's question (in terms of what ",
  "   the chunks SAY, not just 'matches the query'). When `relevant` is ",
  "   false, `reasoning` is one short clause explaining what's missing or ",
  "   off-topic (don't quote chunk text).",
  "6. `relevantChunkIndices` lists the chunk indices (from the input ",
  "   `<chunk index=...>` attributes) that actually carry the relevant ",
  "   content. Empty array when `relevant` is false.",
].join("\n")

const buildPerDocFilterUserPrompt = (
  questionContext: string,
  query: string,
  appliedFilters: string,
  candidate: FilterCandidate,
): string => {
  const lines: string[] = []
  lines.push(`<user_question>${questionContext}</user_question>`)
  lines.push(`<search_query>${query}</search_query>`)
  lines.push(`<applied_filters>${appliedFilters}</applied_filters>`)
  lines.push(`<doc docId="${candidate.docId}" rank="${String(candidate.rank)}">`)
  lines.push(`  <title>${candidate.title}</title>`)
  const metaParts: string[] = []
  if (candidate.documentDate) metaParts.push(`date=${candidate.documentDate}`)
  if (candidate.documentId) metaParts.push(`document_id=${candidate.documentId}`)
  if (candidate.entities && candidate.entities.length) {
    metaParts.push(`entities=${candidate.entities.slice(0, 8).join(" | ")}`)
  }
  if (metaParts.length) {
    lines.push(`  <metadata>${metaParts.join("; ")}</metadata>`)
  }
  if (candidate.aiSummary && candidate.aiSummary.trim()) {
    lines.push(`  <ai_summary>${candidate.aiSummary.trim()}</ai_summary>`)
  }
  if (candidate.chunks.length > 0) {
    lines.push(`  <chunks count="${String(candidate.chunks.length)}">`)
    for (const c of candidate.chunks) {
      lines.push(`    <chunk index="${String(c.index)}">${c.text}</chunk>`)
    }
    lines.push(`  </chunks>`)
  }
  lines.push(`</doc>`)
  lines.push(
    "Decide whether this doc is RELEVANT to <user_question> (use ",
    "<search_query> as context for what was searched and <applied_filters> ",
    "for the scope). Return JSON only.",
  )
  return lines.join("\n")
}

/** Coerce the model output into our per-doc shape. JSON mode is usually
 *  clean, but markdown fences sneak in sometimes (hence the strip below). */
type PerDocDecision = {
  relevant: boolean
  reasoning: string
  relevantChunkIndices: number[]
}
const parsePerDocFilterResponse = (raw: string): PerDocDecision | null => {
  let s = raw.trim()
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim()
  try {
    const parsed = JSON.parse(s) as unknown
    if (!parsed || typeof parsed !== "object") return null
    const obj = parsed as {
      relevant?: unknown
      reasoning?: unknown
      relevantChunkIndices?: unknown
    }
    if (typeof obj.relevant !== "boolean") return null
    const reasoning =
      typeof obj.reasoning === "string" ? obj.reasoning.trim() : ""
    const relevantChunkIndices = Array.isArray(obj.relevantChunkIndices)
      ? obj.relevantChunkIndices.filter(
          (n): n is number => typeof n === "number" && Number.isFinite(n),
        )
      : []
    return { relevant: obj.relevant, reasoning, relevantChunkIndices }
  } catch {
    return null
  }
}

const filterOneDoc = async (
  questionContext: string,
  query: string,
  appliedFilters: string,
  candidate: FilterCandidate,
  llm: LlmHandle,
  logger: Log,
  timeoutMs: number,
): Promise<PerDocDecision | null> => {
  const baseUrl = llm.baseUrl.endsWith("/v1") ? llm.baseUrl : `${llm.baseUrl}/v1`
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${llm.apiKey}`,
        ...(llm.sessionId ? { "x-session-id": llm.sessionId } : {}),
      },
      body: JSON.stringify({
        model: llm.model,
        messages: [
          { role: "system", content: PER_DOC_FILTER_SYSTEM_PROMPT },
          {
            role: "user",
            content: buildPerDocFilterUserPrompt(
              questionContext,
              query,
              appliedFilters,
              candidate,
            ),
          },
        ],
        // 600 covers a boolean + 1-2 sentences + a generous chunk-index list.
        max_tokens: 600,
        temperature: 0.1,
        response_format: { type: "json_object" },
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      logger.warn(
        { status: res.status, docId: candidate.docId, body: body.slice(0, 240) },
        "vespaSearch: per-doc filter LLM rejected request",
      )
      return null
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>
    }
    const content = json.choices?.[0]?.message?.content ?? ""
    const parsed = parsePerDocFilterResponse(content)
    if (!parsed) {
      logger.warn(
        { docId: candidate.docId, contentPreview: content.slice(0, 200) },
        "vespaSearch: per-doc filter LLM returned unparseable JSON",
      )
      return null
    }
    return parsed
  } catch (err) {
    logger.warn(
      { err, docId: candidate.docId },
      "vespaSearch: per-doc filter LLM call failed",
    )
    return null
  }
}

/** Run the per-doc filter LLM in PARALLEL across all candidates. A single
 *  call that errors / times out / returns bad JSON keeps that doc by default
 *  (synthesised reasoning); the rest are unaffected. Empty input → empty
 *  result, and the caller falls through to unfiltered behaviour. */
export const runLlmFilter = async (
  questionContext: string,
  query: string,
  appliedFilters: string,
  candidates: ReadonlyArray<FilterCandidate>,
  llm: LlmHandle,
  logger: Log,
  opts: { timeoutMs?: number } = {},
): Promise<FilterDecision> => {
  if (candidates.length === 0) return { kept: [], dropped: [] }
  const timeoutMs = opts.timeoutMs ?? 30_000
  const startedAt = Date.now()

  const results = await Promise.allSettled(
    candidates.map((c) =>
      filterOneDoc(questionContext, query, appliedFilters, c, llm, logger, timeoutMs),
    ),
  )

  const kept: FilterKept[] = []
  const dropped: Array<{ docId: string; reason: string }> = []
  let failures = 0

  results.forEach((r, i) => {
    const c = candidates[i]
    if (!c) return
    if (r.status === "rejected" || !r.value) {
      // Fail OPEN: keep the doc rather than lose it to a transient API error.
      failures += 1
      kept.push({
        docId: c.docId,
        reasoning: "(filter call failed — kept by default)",
        relevantChunkIndices: c.chunks.map((ch) => ch.index),
      })
      return
    }
    if (r.value.relevant) {
      kept.push({
        docId: c.docId,
        reasoning: r.value.reasoning || "(no reasoning returned)",
        relevantChunkIndices:
          r.value.relevantChunkIndices.length > 0
            ? r.value.relevantChunkIndices
            : c.chunks.map((ch) => ch.index),
      })
    } else {
      dropped.push({
        docId: c.docId,
        reason: r.value.reasoning || "(no reason returned)",
      })
    }
  })

  logger.info(
    {
      total: candidates.length,
      kept: kept.length,
      dropped: dropped.length,
      failures,
      durationMs: Date.now() - startedAt,
    },
    "vespaSearch: per-doc filter batch done",
  )
  return { kept, dropped }
}

// ─── Date helpers ───

// `document_date` in kb_items is a `long` encoded YYYYMMDD (per the
// 2026-05-19 schema migration). YQL range ops are numeric-only, so convert
// ISO/loose strings to ints here. Partials pad to the inclusive lower/upper
// bound of the implied period.
export const isoDateToInt = (
  input: string,
  bound: "lower" | "upper",
): number | null => {
  const s = input.trim()
  const compact = s.replace(/-/g, "")
  if (!/^\d{4}(\d{2})?(\d{2})?$/.test(compact)) return null
  const year = compact.slice(0, 4)
  const mm =
    compact.length >= 6
      ? compact.slice(4, 6)
      : bound === "lower"
        ? "01"
        : "12"
  const dd =
    compact.length === 8
      ? compact.slice(6, 8)
      : bound === "lower"
        ? "01"
        : "31"
  const n = Number(`${year}${mm}${dd}`)
  return Number.isFinite(n) ? n : null
}

/** Render the YYYYMMDD int back to "YYYY-MM-DD" for tool output. */
export const intDateToIso = (n: number): string | null => {
  if (!Number.isFinite(n)) return null
  const s = String(n).padStart(8, "0")
  if (s.length !== 8) return null
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}

// Re-exported for tools that still build their own YQL fragments.
export { yqlString }
