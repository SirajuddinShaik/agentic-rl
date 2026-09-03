// Projects a custom agent record into a flat search scope for the v2 vespa
// tools. Reads the v1 `agents` table shape (`appIntegrations`, `docIds`) but
// shares no code with v1's chat module.
//
// `loadAgentScope` returning `null` means "no agent in play" — vespa keeps its
// default KB-only behavior. A non-null scope flips vespa into agent-scoped mode
// where the agent's allowlist (apps, docIds, channels, KB collections) drives
// visibility, bypassing the per-user `createdBy == email` filter on the KB profile.

import { and, eq, isNull } from "drizzle-orm"

import { db } from "@/platform/db/client"
import {
  agents,
  subAgents,
  skills,
  skillAgentMappings,
  mcps,
  mcpAgentMappings,
} from "@/platform/db/schema"
import { getUserAndWorkspaceByEmail } from "@/platform/db/user"
import { getAgentByExternalIdWithPermissionCheck } from "@/platform/db/agent"
import {
  AclResourceType,
  resolveAccess,
  accessibleResourceIds,
  type ResourceType,
} from "@/platform/authz"
import { Apps, SlackEntity } from "@xyne/vespa-ts/types"
import type { SubAgentSummary } from "./pi-mono/system-prompt"

/** SubAgentSummary (name + description, all the assembler reads) plus the
 *  columns dispatchSubagent needs to spin a nested pi-mono session. */
export type DispatchableSubAgent = SubAgentSummary & {
  externalId: string
  systemPrompt: string
  tools: string[]
  // Pulled off the sub_agents row directly so each leaf is independently
  // tunable — the parent agent's / chat request's level doesn't override it.
  thinkingLevel: "minimal" | "low" | "medium" | "high"
}

// Local copy of SubAgentsService.normaliseThinkingLevel — avoids a service-layer dep.
const VALID_THINKING_LEVELS: ReadonlyArray<"minimal" | "low" | "medium" | "high"> = [
  "minimal",
  "low",
  "medium",
  "high",
]
const normaliseThinkingLevel = (
  raw: unknown,
): DispatchableSubAgent["thinkingLevel"] =>
  typeof raw === "string" &&
  (VALID_THINKING_LEVELS as readonly string[]).includes(raw)
    ? (raw as DispatchableSubAgent["thinkingLevel"])
    : "medium"
import type { UserId, WorkspaceId } from "./storage/types"

// ─── Public types ───────────────────────────────────────────────────────────

/** A per-app filter group from the agent record. Only v2-relevant fields are
 *  typed; unknown fields pass through opaquely. */
export type AgentAppFilter = {
  id: number
  from?: string[]
  to?: string[]
  cc?: string[]
  bcc?: string[]
  senderId?: string[]
  channelId?: string[]
  timeRange?: { startDate: number; endDate: number }
}

/** v1 also persists Zoho/etc. nested filters; we pass them through opaquely. */
export type AgentAppFilters = Partial<Record<Apps, AgentAppFilter[]>>

/** A skill projected for the prompt manifest + the `skill` tool — alias/name/
 *  description only; the body is fetched on demand via the tool. */
export type SkillManifestEntry = {
  id: string
  alias: string
  name: string
  description: string
}

/** An MCP server attached to the agent, projected for the runtime connector.
 *  `config` is the decrypted connection config — server-side only. */
export type McpScopeEntry = {
  id: string
  name: string
  type: string
  config: unknown
}

export type AgentScope = {
  /** External ID — propagates to logs and the run record. */
  externalId: string
  /** Numeric users.id of the creator. Audit-only; search ignores it. */
  ownerUserId: number
  /** When false the agent has RAG disabled and tools should short-circuit. */
  isRagOn: boolean
  /** Gates the in-tool LLM relevance filter in vespaSearch. True (default) →
   *  filter runs; false → raw Vespa hits flow through unfiltered. */
  searchFilterEnabled: boolean
  /** Apps the agent is allowed to query. */
  appEnums: Apps[]
  /** `ds-`-prefixed external IDs of data sources allowlisted on the agent. */
  dataSourceIds: string[]
  /** Slack channel docIds extracted from the agent's `docIds`. */
  channelIds: string[]
  /** Per-app explicit item ID allowlist. Empty for an app means "selectedAll". */
  selectedItems: Partial<Record<Apps, string[]>>
  /** Per-app filter groups (Gmail from/to, time ranges, Slack senders). */
  appFilters: AgentAppFilters
  /** KB collection selections gathered from `selectedItems.knowledge_base`. */
  collectionSelections: Array<{
    collectionIds?: string[]
    collectionFolderIds?: string[]
    collectionFileIds?: string[]
  }>
  /** Legacy single-field prompt (pre-M2). When set and all per-section fields
   *  are NULL, the chat service treats it as a verbatim REPLACE of the whole
   *  assembled prompt. */
  prompt?: string
  /** Per-section overrides. NULL → fall back to the hard-coded default (resolved
   *  by the assembler); all-NULL + no legacy `prompt` → full default prompt. */
  systemPromptMain?: string | null
  systemPromptTools?: string | null
  systemPromptSubagents?: string | null
  /** Tool names from the pi-mono registry this agent is allowed to call.
   *  Empty = all tools (matches `buildToolsForRun(undefined, ctx)`). */
  tools: string[]
  /** Sub-agents for the assembler's `<subagents>` catalog. Empty = section
   *  suppressed from the prompt. */
  subAgents: DispatchableSubAgent[]
  /** Viewer-visible skills attached to this agent. Empty = no skills section
   *  in the prompt and no `skill` tool. */
  skills: SkillManifestEntry[]
  /** Viewer-visible MCP servers attached to this agent. Each contributes its
   *  remote tools to the agent at runtime. Empty = no MCP tools. */
  mcps: McpScopeEntry[]
  /** True when the agent must emit JSON conforming to `responseSchema`.
   *  Drives the validator + retry loop in the extract endpoint. */
  isExtractor: boolean
  /** JSON Schema the extractor must satisfy. Null when isExtractor is
   *  false, or for extractor agents whose schema is still empty. */
  responseSchema: Record<string, unknown> | null
  /** Max times to re-prompt the LLM with validation errors before
   *  surfacing a final failure. */
  extractorMaxRetries: number
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/** A drive-like app's docIds expand into `selectedItems[app]`. Other apps
 *  (Gmail, KB) carry their item IDs through `appIntegrations` instead. */
const DRIVE_LIKE_APPS: ReadonlySet<Apps> = new Set([
  Apps.GoogleDrive,
  Apps.GoogleWorkspace,
])

/** Canonicalize the various spellings of app keys the v1 UI persists. Unknown
 *  values produce `null` so callers can drop them instead of polluting the
 *  scope with garbage app enums. */
const normalizeApp = (raw: string): Apps | null => {
  const v = raw.toLowerCase()
  switch (v) {
    case "googledrive":
    case "googlesheets":
    case "googleslides":
    case "googledocs":
      return Apps.GoogleDrive
    case "gmail":
      return Apps.Gmail
    case "googlecalendar":
      return Apps.GoogleCalendar
    case "google-workspace":
      return Apps.GoogleWorkspace
    case "slack":
      return Apps.Slack
    case "knowledge_base":
    case "knowledgebase":
      return Apps.KnowledgeBase
    case "datasource":
    case "data-source":
      return Apps.DataSource
    case "zohodesk":
      return Apps.ZohoDesk
    case "github":
      return Apps.Github
    default:
      return null
  }
}

const dedupe = <T>(items: readonly T[]): T[] => Array.from(new Set(items))

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** Shape check for an `AppSelectionMap` entry. Doesn't validate filter
 *  internals — those are passed through opaquely. */
const isAppSelection = (
  v: unknown,
): v is { itemIds?: unknown; selectedAll?: boolean; filters?: unknown } => {
  if (!isPlainObject(v)) return false
  return "itemIds" in v || "selectedAll" in v || "filters" in v
}

/** True when `value` looks like `{ [appKey]: AppSelection, ... }`. */
const isAppSelectionMap = (value: unknown): boolean => {
  if (!isPlainObject(value)) return false
  if (Object.keys(value).length === 0) return true // empty map is valid
  for (const v of Object.values(value)) {
    if (!isAppSelection(v)) return false
  }
  return true
}

/** Pull a string[] off an unknown record field; non-arrays/non-strings dropped
 *  silently so a malformed filter doesn't break the whole scope. */
const pickStringList = (
  src: Record<string, unknown>,
  key: string,
): string[] | undefined => {
  const v = src[key]
  if (!Array.isArray(v)) return undefined
  const out = v.filter((s): s is string => typeof s === "string")
  return out.length > 0 ? out : undefined
}

/** Coerce arbitrary filter payloads into our typed shape. Unknown keys are
 *  ignored; the result is safe to pass into downstream vespa queries. */
const coerceFilters = (raw: unknown): AgentAppFilter[] => {
  if (!Array.isArray(raw)) return []
  const out: AgentAppFilter[] = []
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const id = typeof item["id"] === "number" ? item["id"] : 0
    const filter: AgentAppFilter = { id }
    const from = pickStringList(item, "from")
    if (from) filter.from = from
    const to = pickStringList(item, "to")
    if (to) filter.to = to
    const cc = pickStringList(item, "cc")
    if (cc) filter.cc = cc
    const bcc = pickStringList(item, "bcc")
    if (bcc) filter.bcc = bcc
    const senderId = pickStringList(item, "senderId")
    if (senderId) filter.senderId = senderId
    const channelId = pickStringList(item, "channelId")
    if (channelId) filter.channelId = channelId
    const timeRange = item["timeRange"]
    if (
      isPlainObject(timeRange) &&
      typeof timeRange["startDate"] === "number" &&
      typeof timeRange["endDate"] === "number"
    ) {
      filter.timeRange = {
        startDate: timeRange["startDate"],
        endDate: timeRange["endDate"],
      }
    }
    out.push(filter)
  }
  return out
}

type ParsedIntegrations = {
  appEnums: Set<Apps>
  selectedItems: Partial<Record<Apps, string[]>>
  appFilters: AgentAppFilters
  dataSourceIds: string[]
}

/** Parse the AppSelectionMap form of `appIntegrations`. v1 convention:
 *  `selectedAll: true` (or empty `itemIds`) → record the app enum but no item
 *  allowlist; an explicit `itemIds` list narrows visibility to those IDs. */
const parseAppSelectionMap = (
  map: Record<string, unknown>,
  acc: ParsedIntegrations,
): void => {
  for (const [appName, selection] of Object.entries(map)) {
    if (!isAppSelection(selection)) continue
    const app = normalizeApp(appName)
    if (!app) continue
    acc.appEnums.add(app)

    const itemIds = Array.isArray(selection.itemIds)
      ? (selection.itemIds as unknown[]).filter(
          (s): s is string => typeof s === "string",
        )
      : []
    const selectedAll = selection.selectedAll === true
    if (!selectedAll && itemIds.length > 0) {
      const prior = acc.selectedItems[app] ?? []
      acc.selectedItems[app] = dedupe([...prior, ...itemIds])
    }

    const filters = coerceFilters(selection.filters)
    if (filters.length > 0) {
      acc.appFilters[app] = [...(acc.appFilters[app] ?? []), ...filters]
    }
  }
}

/** Parse the legacy `string[]` form of `appIntegrations`: each entry is
 *  either an app key ("googledrive", "gmail", ...) or a data source external
 *  id (`ds-…`). Unknown values are dropped silently. */
const parseLegacyIntegrationArray = (
  values: readonly unknown[],
  acc: ParsedIntegrations,
): void => {
  for (const entry of values) {
    if (typeof entry !== "string") continue
    const lower = entry.toLowerCase()
    if (lower.startsWith("ds-") || lower.startsWith("ds_")) {
      acc.dataSourceIds.push(entry)
      acc.appEnums.add(Apps.DataSource)
      continue
    }
    const app = normalizeApp(entry)
    if (app) acc.appEnums.add(app)
  }
}

/** Merge `agent.docIds` into the scope. Slack-channel docIds become channelIds;
 *  drive-like docIds widen `selectedItems[<driveApp>]`. Other apps are ignored
 *  on purpose — v1 only expands drive-like and Slack entries into search scope. */
const mergeDocIds = (
  docIds: unknown,
  acc: ParsedIntegrations,
  channelIds: Set<string>,
): void => {
  if (!Array.isArray(docIds)) return
  const driveBucket: Partial<Record<Apps, string[]>> = {}
  for (const record of docIds) {
    if (!record) continue
    if (typeof record === "string") {
      // Bare string → implicitly a Drive docId in v1's contract.
      ;(driveBucket[Apps.GoogleDrive] ??= []).push(record)
      continue
    }
    if (!isPlainObject(record)) continue
    const docId =
      typeof record["docId"] === "string" ? record["docId"] : undefined
    if (!docId) continue
    if (
      record["app"] === Apps.Slack &&
      record["entity"] === SlackEntity.Channel
    ) {
      channelIds.add(docId)
      acc.appEnums.add(Apps.Slack)
      continue
    }
    const app = normalizeApp(String(record["app"] ?? "googledrive"))
    if (!app || !DRIVE_LIKE_APPS.has(app)) continue
    ;(driveBucket[app] ??= []).push(docId)
  }
  for (const [appKey, ids] of Object.entries(driveBucket)) {
    const app = appKey as Apps
    const deduped = dedupe(ids ?? [])
    if (!deduped.length) continue
    acc.appEnums.add(app)
    acc.selectedItems[app] = dedupe([
      ...(acc.selectedItems[app] ?? []),
      ...deduped,
    ])
  }
}

/** Expand KB selectedItems entries (with `cl-`/`clfd-`/`clf-` prefixes) into
 *  the per-collection / folder / file shape that vespa-ts consumes. */
const collectionSelectionsFromKb = (
  kbItems: readonly string[],
): AgentScope["collectionSelections"] => {
  if (kbItems.length === 0) return []
  const collectionIds: string[] = []
  const collectionFolderIds: string[] = []
  const collectionFileIds: string[] = []
  for (const raw of kbItems) {
    if (raw.startsWith("cl-")) collectionIds.push(raw.replace(/^cl[-_]/, ""))
    else if (raw.startsWith("clfd-"))
      collectionFolderIds.push(raw.replace(/^clfd[-_]/, ""))
    else if (raw.startsWith("clf-"))
      collectionFileIds.push(raw.replace(/^clf[-_]/, ""))
  }
  if (
    collectionIds.length === 0 &&
    collectionFolderIds.length === 0 &&
    collectionFileIds.length === 0
  ) {
    return []
  }
  return [
    {
      ...(collectionIds.length ? { collectionIds: dedupe(collectionIds) } : {}),
      ...(collectionFolderIds.length
        ? { collectionFolderIds: dedupe(collectionFolderIds) }
        : {}),
      ...(collectionFileIds.length
        ? { collectionFileIds: dedupe(collectionFileIds) }
        : {}),
    },
  ]
}

// Per-viewer KB scope: keep only the collections/folders/files the viewer can
// actually read (resolveAccess != null). The retrieval enforcement point
// (Decision 7) — a ref the agent lists but the viewer can't access (e.g. an
// owner's viewer-only collection that never propagated) never enters their
// scope, so visibilityGate can keep trusting the scope it is handed.
const intersectKbScopeWithViewer = async (
  selections: AgentScope["collectionSelections"],
  viewer: { userId: number; workspaceId: number },
): Promise<AgentScope["collectionSelections"]> => {
  const keep = async (
    ids: string[] | undefined,
    type: ResourceType,
  ): Promise<string[]> => {
    const out: string[] = []
    for (const id of ids ?? []) {
      if ((await resolveAccess(db, viewer, { type, id })) !== null) out.push(id)
    }
    return out
  }
  const result: AgentScope["collectionSelections"] = []
  for (const sel of selections) {
    const collectionIds = await keep(
      sel.collectionIds,
      AclResourceType.Collection,
    )
    const collectionFolderIds = await keep(
      sel.collectionFolderIds,
      AclResourceType.Folder,
    )
    const collectionFileIds = await keep(
      sel.collectionFileIds,
      AclResourceType.File,
    )
    if (
      collectionIds.length ||
      collectionFolderIds.length ||
      collectionFileIds.length
    ) {
      result.push({
        ...(collectionIds.length ? { collectionIds } : {}),
        ...(collectionFolderIds.length ? { collectionFolderIds } : {}),
        ...(collectionFileIds.length ? { collectionFileIds } : {}),
      })
    }
  }
  return result
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Load the agent record and parse it into a search scope. Returns null when the
 *  agent doesn't exist or the viewer lacks permission: public agents are visible
 *  workspace-wide, non-public ones only to the owner or shared users. */
export const loadAgentScope = async (
  viewer: { userId: UserId; workspaceId: WorkspaceId },
  agentExternalId: string,
): Promise<AgentScope | null> => {
  const { user, workspace } = await getUserAndWorkspaceByEmail(
    db,
    String(viewer.workspaceId),
    String(viewer.userId),
  )
  const agent = await getAgentByExternalIdWithPermissionCheck(
    db,
    agentExternalId,
    workspace.id,
    user.id,
  )
  if (!agent) {
    return null
  }

  const acc: ParsedIntegrations = {
    appEnums: new Set(),
    selectedItems: {},
    appFilters: {},
    dataSourceIds: [],
  }

  const integrations = agent.appIntegrations
  if (integrations) {
    if (isAppSelectionMap(integrations)) {
      parseAppSelectionMap(integrations as Record<string, unknown>, acc)
    } else if (Array.isArray(integrations)) {
      parseLegacyIntegrationArray(integrations as readonly unknown[], acc)
    }
  }

  const channelIds = new Set<string>()
  mergeDocIds(agent.docIds, acc, channelIds)

  const kbItems = acc.selectedItems[Apps.KnowledgeBase] ?? []
  const collectionSelections = await intersectKbScopeWithViewer(
    collectionSelectionsFromKb(kbItems),
    { userId: user.id, workspaceId: workspace.id },
  )

  // Live sub-agents only (soft-deleted excluded). Assembler reads name +
  // description; dispatch reads the rest of the projection.
  const subAgentRows: DispatchableSubAgent[] = (
    await db
      .select({
        externalId: subAgents.externalId,
        name: subAgents.name,
        description: subAgents.description,
        systemPrompt: subAgents.systemPrompt,
        tools: subAgents.tools,
        thinkingLevel: subAgents.thinkingLevel,
      })
      .from(subAgents)
      .where(
        and(
          eq(subAgents.parentAgentId, agent.id),
          isNull(subAgents.deletedAt),
        ),
      )
  ).map((r) => ({
    externalId: r.externalId,
    name: r.name,
    description: r.description,
    systemPrompt: r.systemPrompt,
    tools: Array.isArray(r.tools)
      ? (r.tools as unknown[]).filter((t): t is string => typeof t === "string")
      : [],
    thinkingLevel: normaliseThinkingLevel(r.thinkingLevel),
  }))

  // Skills the viewer may see, via the unified resolver (workspace-scoped) —
  // filtered against the agent's mapped skills. Replaces the legacy
  // isPrivate/createdBy filter that leaked public skills cross-workspace.
  const visibleSkillIds = new Set(
    await accessibleResourceIds(
      db,
      { userId: user.id, workspaceId: workspace.id },
      AclResourceType.Skill,
    ),
  )
  const skillRows: SkillManifestEntry[] = (
    await db
      .select({
        id: skills.id,
        alias: skills.alias,
        name: skills.name,
        description: skills.description,
      })
      .from(skillAgentMappings)
      .innerJoin(skills, eq(skillAgentMappings.skillId, skills.id))
      .where(eq(skillAgentMappings.agentId, agent.id))
      .orderBy(skills.createdAt)
  )
    .filter((r) => visibleSkillIds.has(r.id))
    .map((r) => ({
      id: r.id,
      alias: r.alias,
      name: r.name,
      description: r.description,
    }))

  // MCPs the viewer may see, filtered against the agent's mapped MCPs. Config is
  // decrypted by the column type; parsed here for the runtime connector.
  const visibleMcpIds = new Set(
    await accessibleResourceIds(
      db,
      { userId: user.id, workspaceId: workspace.id },
      AclResourceType.Mcp,
    ),
  )
  const mcpRows: McpScopeEntry[] = (
    await db
      .select({
        id: mcps.id,
        name: mcps.name,
        type: mcps.type,
        config: mcps.config,
      })
      .from(mcpAgentMappings)
      .innerJoin(mcps, eq(mcpAgentMappings.mcpId, mcps.id))
      .where(eq(mcpAgentMappings.agentId, agent.id))
      .orderBy(mcps.createdAt)
  )
    .filter((r) => visibleMcpIds.has(r.id))
    .map((r) => {
      let config: unknown = {}
      try {
        config = r.config ? JSON.parse(r.config) : {}
      } catch {
        config = {}
      }
      return { id: r.id, name: r.name, type: r.type, config }
    })

  // Filter guards against legacy rows with non-string tool entries.
  const toolNames: string[] = Array.isArray(agent.tools)
    ? (agent.tools as unknown[]).filter(
        (t): t is string => typeof t === "string",
      )
    : []

  return {
    externalId: agent.externalId,
    ownerUserId: user.id,
    isRagOn: agent.isRagOn ?? true,
    // Default true so pre-column agents keep the old "always on" behaviour.
    searchFilterEnabled: agent.searchFilterEnabled ?? true,
    appEnums: Array.from(acc.appEnums),
    dataSourceIds: dedupe(acc.dataSourceIds),
    channelIds: Array.from(channelIds),
    selectedItems: acc.selectedItems,
    appFilters: acc.appFilters,
    collectionSelections,
    ...(agent.prompt ? { prompt: agent.prompt } : {}),
    systemPromptMain: agent.systemPromptMain ?? null,
    systemPromptTools: agent.systemPromptTools ?? null,
    systemPromptSubagents: agent.systemPromptSubagents ?? null,
    tools: toolNames,
    subAgents: subAgentRows,
    skills: skillRows,
    mcps: mcpRows,
    isExtractor: agent.isExtractor === true,
    responseSchema:
      agent.responseSchema && typeof agent.responseSchema === "object"
        ? (agent.responseSchema as Record<string, unknown>)
        : null,
    extractorMaxRetries:
      typeof agent.extractorMaxRetries === "number"
        ? agent.extractorMaxRetries
        : 2,
  }
}

// ─── Workspace-default prompt inputs (M4b) ──────────────────────────────────
//
// Prompt config (section overrides, tool allowlist, sub-agents) from the
// workspace's `is_default = true` agent row, for turns with NO agent scope.
// Deliberately NOT an AgentScope: the default row's appIntegrations are never
// applied to vespa search, so un-scoped chats stay KB-only. Returns null when
// no default row exists yet (chat falls back to DEFAULT_SYSTEM_PROMPT).

export type WorkspaceDefaultPromptInputs = {
  systemPromptMain: string | null
  systemPromptTools: string | null
  systemPromptSubagents: string | null
  tools: string[]
  subAgents: DispatchableSubAgent[]
}

export const loadWorkspaceDefaultPromptInputs = async (viewer: {
  userId: UserId
  workspaceId: WorkspaceId
}): Promise<WorkspaceDefaultPromptInputs | null> => {
  const { workspace } = await getUserAndWorkspaceByEmail(
    db,
    String(viewer.workspaceId),
    String(viewer.userId),
  )
  const rows = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspace.id),
        eq(agents.isDefault, true),
        isNull(agents.deletedAt),
      ),
    )
    .limit(1)
  const defaultAgent = rows[0]
  if (!defaultAgent) return null

  // Same dispatchable projection as loadAgentScope.
  const subAgentRows: DispatchableSubAgent[] = (
    await db
      .select({
        externalId: subAgents.externalId,
        name: subAgents.name,
        description: subAgents.description,
        systemPrompt: subAgents.systemPrompt,
        tools: subAgents.tools,
        thinkingLevel: subAgents.thinkingLevel,
      })
      .from(subAgents)
      .where(
        and(
          eq(subAgents.parentAgentId, defaultAgent.id),
          isNull(subAgents.deletedAt),
        ),
      )
  ).map((r) => ({
    externalId: r.externalId,
    name: r.name,
    description: r.description,
    systemPrompt: r.systemPrompt,
    tools: Array.isArray(r.tools)
      ? (r.tools as unknown[]).filter((t): t is string => typeof t === "string")
      : [],
    thinkingLevel: normaliseThinkingLevel(r.thinkingLevel),
  }))

  const toolNames: string[] = Array.isArray(defaultAgent.tools)
    ? (defaultAgent.tools as unknown[]).filter(
        (t): t is string => typeof t === "string",
      )
    : []

  return {
    systemPromptMain: defaultAgent.systemPromptMain ?? null,
    systemPromptTools: defaultAgent.systemPromptTools ?? null,
    systemPromptSubagents: defaultAgent.systemPromptSubagents ?? null,
    tools: toolNames,
    subAgents: subAgentRows,
  }
}
