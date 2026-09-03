// Pi-mono runner — thin wrapper around `createRAGAgent` for backendv2.
//
// Owns the per-conversation SessionManager cache, model resolution, system
// prompt, and the event loop mapping pi-mono's RAGEvent stream to callbacks.
// Does NOT touch MessageRepo/StreamBus — the caller owns storage. History is
// in-memory only (Phase 1), keyed by conversationId; it dies with the process.

import {
  SessionManager,
  SettingsManager,
  estimateTokens,
  shouldCompact,
} from "@earendil-works/pi-coding-agent"

import { createRAGAgent, type RAGAgent } from "@/app/agent/pi-mono/core"
import type { AgentScope, DispatchableSubAgent } from "../agent-scope"
import { buildToolsForRun } from "./tools/registry"
import {
  buildDispatchSubagentBatchTool,
  buildDispatchSubagentTool,
  type NestedRunPersistence,
  type SubAgentActivityEvent,
  type SubAgentStatusEvent,
} from "./tools/dispatch-subagent"
import { buildGetSkillTool } from "./tools/get-skill"
import { buildMcpToolsForRun } from "../mcp/loader"
import {
  buildUpsertSkillTool,
  type SkillFormSnapshot,
} from "./tools/upsert-skill"
import { COMPACTION_FILE_NOTE_MARKER } from "@/app/agent/services/chatAttachments"
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt"
import {
  getActualNameFromEnum,
  getModelConfiguration,
  getModelValueFromLabel,
} from "@/platform/ai/modelConfig"
import { Models } from "@/platform/ai/types"
import config from "@/config"
import { baseLogger, type Log } from "../log"

const Logger = baseLogger("backendv2/pi-mono")

// Per-conversation cache. Each SessionManager holds the full pi-mono session
// tree (messages + compaction summaries) for one conversation.
const sessions = new Map<string, SessionManager>()

const getOrCreateSession = (conversationId: string): SessionManager => {
  let sm = sessions.get(conversationId)
  if (!sm) {
    sm = SessionManager.inMemory()
    sessions.set(conversationId, sm)
  }
  return sm
}

export const hasSession = (conversationId: string): boolean =>
  sessions.has(conversationId)

export type HydratablePiMonoMessage = {
  role: "user" | "assistant"
  text: string
  timestamp?: number
}

export const hydrateSession = (
  conversationId: string,
  messages: HydratablePiMonoMessage[],
): void => {
  if (sessions.has(conversationId) || messages.length === 0) {
    return
  }
  const sm = SessionManager.inMemory()
  for (const message of messages) {
    const timestamp = message.timestamp ?? Date.now()
    if (message.role === "user") {
      sm.appendMessage({
        role: "user",
        content: message.text,
        timestamp,
      })
      continue
    }
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: message.text }],
      api: "hydrated",
      provider: "xyne",
      model: "hydrated",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp,
    })
  }
  sessions.set(conversationId, sm)
  reminderStaleAfterCompaction.delete(conversationId)
}

export const dropSession = (conversationId: string): void => {
  sessions.delete(conversationId)
  reminderStaleAfterCompaction.delete(conversationId)
}

/** Clone a conversation's in-memory session into a new one, keeping only the
 *  first `keepUserTurns` user turns. Replays the source's AgentMessage entries
 *  (text + tool context carry over); compaction/model/thinking entries are
 *  skipped (v1). No-op if the source isn't in memory (e.g. post-restart) — the
 *  new conversation then starts empty. */
export const forkSession = (
  sourceConversationId: string,
  newConversationId: string,
  keepUserTurns: number,
): void => {
  const src = sessions.get(sourceConversationId)
  if (!src) return
  const dst = SessionManager.inMemory()
  // Root→leaf order, via reversing the leaf→root parentId chain.
  const leafToRoot: Array<{
    type: string
    parentId: string | null
    message?: unknown
  }> = []
  let walkId: string | null = src.getLeafId()
  while (walkId) {
    const entry = src.getEntry(walkId)
    if (!entry) break
    leafToRoot.push(entry)
    walkId = entry.parentId
  }
  const rootToLeaf = leafToRoot.reverse()
  let userSeen = 0
  for (const entry of rootToLeaf) {
    if (entry.type !== "message") continue
    const message = entry.message
    const role = (message as { role?: string } | undefined)?.role
    if (role === "user") {
      userSeen += 1
      if (userSeen === keepUserTurns + 1) break
    }
    if (message) {
      dst.appendMessage(message as Parameters<typeof dst.appendMessage>[0])
    }
  }
  sessions.set(newConversationId, dst)
}

// Conversations compacted since the uploaded-files reminder was last appended:
// the steer + extracted content get summarized away, so the next turn must
// re-append. Set on `compaction_start`; consumed by the next turn's reminder
// decision. Keeps the reminder off every message while surviving a summary.
const reminderStaleAfterCompaction = new Set<string>()

/** Append the uploaded-files index to the latest compaction summary so the
 *  `/mnt/files/` paths survive regardless of what the LLM summarizer kept.
 *  Mutates the live `compactionSummary` in place — `agent.getSession().messages`
 *  is the agent's live array and `convertToLlm` reads `.summary` at request
 *  time, so the append lands in the next call. Idempotent via the note's heading
 *  marker; no-op when `note` is empty or no summary exists. */
function appendFilesNoteToLatestSummary(
  agent: RAGAgent<unknown>,
  note: string,
  log: Log,
): void {
  if (!note) return
  const msgs = agent.getSession().messages as Array<{
    role?: string
    summary?: string
  }>
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m?.role !== "compactionSummary") continue
    if (
      typeof m.summary === "string" &&
      !m.summary.includes(COMPACTION_FILE_NOTE_MARKER)
    ) {
      m.summary = `${m.summary}\n\n${note}`
      log.info("pi-mono: appended uploaded-files paths to compaction summary")
    }
    return
  }
}

const resolveModelId = (label: string | undefined): string => {
  if (!label) {
    return config.defaultBestModel
  }
  const resolved = getModelValueFromLabel(label)
  if (resolved) {
    return resolved
  }
  if (label in Models) {
    return label
  }
  Logger.warn(
    { label, fallback: config.defaultBestModel },
    "pi-mono: model label did not resolve; using default",
  )
  return config.defaultBestModel
}

export type PiMonoToolCall = {
  toolName: string
  toolCallId: string
  args: unknown
}

export type PiMonoToolResult = {
  toolName: string
  toolCallId: string
  result: unknown
  isError: boolean
}

export type RunPiMonoTurnArgs = {
  conversationId: string
  userEmail: string
  message: string
  /** `<system-reminder>` (uploaded-files reading-skill steer) appended to the
   *  user message for the LLM only — never persisted/shown. Appended only on a
   *  turn carrying new attachments, or the first turn after a compaction. */
  attachmentReminder?: string
  /** Pre-flight `<system-reminder>` (relevance + decomposition plan). Appended
   *  for the LLM only; empty when pre-flight was gated out. */
  preflightReminder?: string
  /** Gates `attachmentReminder` (alongside the post-compaction re-inject). */
  messageHasAttachments?: boolean
  /** Citation `<system-reminder>` appended for the LLM only — a recency nudge
   *  for the system-prompt citation rule. Set for RAG agents every turn. */
  citationReminder?: string
  /** Per-turn `@`-mention scope: KB docs referenced this message. Constrains
   *  retrieval to these Vespa docIds and adds a naming `<system-reminder>`. */
  scopedDocs?: ReadonlyArray<{ docId: string; name: string }>
  /** Regenerate / edit-and-resend: keep only the first N user turns before
   *  re-running, dropping the edited turn onward. No-op when the session lacks
   *  that many turns (e.g. after a restart). */
  branchKeepUserTurns?: number
  /** Plain-text index of uploaded files' `/mnt/files/` paths, appended verbatim
   *  to every compaction summary so the paths survive the summary. */
  attachmentSummaryNote?: string
  /** Canonical, already-validated model id — used directly, skipping label
   *  resolution. */
  modelId?: string
  modelLabel?: string
  systemPrompt?: string
  signal?: AbortSignal
  /** Custom-agent scope: RAG tools query the agent's allowlist (apps, docIds,
   *  KB collections) instead of the user-owned KB. */
  agentScope?: AgentScope
  /** Maps directly to pi-ai's ThinkingLevel. Defaults to "medium". */
  thinkingLevel?: "minimal" | "low" | "medium" | "high"
  /** Registry tool names this turn may call. Taken literally — `undefined` and
   *  `[]` both mean "no tools". Validated by the caller. */
  toolNames?: ReadonlyArray<string>
  /** M7 — sub-agents the parent can dispatch to. Dispatch tools are appended
   *  only when this is non-empty AND `dispatchPersistence` is set. Sub-agents
   *  never receive them (flat hierarchy enforced at the runner). */
  dispatchableSubAgents?: ReadonlyArray<DispatchableSubAgent>
  /** Persistence callbacks for nested-run rows + the sub-agent trace. Required
   *  for dispatch to be enabled. */
  dispatchPersistence?: NestedRunPersistence
  /** Per-sub-agent lifecycle hook (fires independently, even in a parallel
   *  batch). Streamed as `subagent_status` SSE. */
  onSubAgentStatus?: (s: SubAgentStatusEvent) => void
  /** Per-sub-agent-tool-call hook. Streamed as `subagent_activity` SSE. */
  onSubAgentActivity?: (a: SubAgentActivityEvent) => void
  /** Factory for a per-sub-agent DebugCapture (debug mode only) so a
   *  dispatched sub-agent's debug events nest under the parent run. */
  makeSubAgentDebug?: (
    nestedRunId: string,
    subAgentName: string,
  ) => import("./debug/capture").DebugCapture
  /** "Generate Skills" mode: builds only the upsertSkill tool (read+write the
   *  skill form). `context` is the form snapshot a READ returns; `caps` bound
   *  the WRITE. Chat service supplies the matching prompt + toolNames=[]. */
  skillAssist?: {
    context: SkillFormSnapshot
    caps: {
      aliasMax: number
      nameMax: number
      descriptionMax: number
      contentMax: number
    }
  }
  /** Turn-bound logger. Falls back to the module logger when omitted (tests). */
  logger?: Log
  // Live callbacks — caller maps these to StreamBus/MessageRepo writes.
  onTextDelta?: (delta: string) => Promise<void> | void
  onThinkingDelta?: (delta: string) => Promise<void> | void
  onThinkingStart?: () => Promise<void> | void
  onThinkingEnd?: () => Promise<void> | void
  onToolCall?: (call: PiMonoToolCall) => Promise<void> | void
  onToolResult?: (result: PiMonoToolResult) => Promise<void> | void
  /** Surfaces a short lifecycle line during a tool's execution. Caller
   *  publishes it as a `tool_progress` SSE event. */
  onToolProgress?: (
    toolCallId: string,
    label: string,
    level: "info" | "ok" | "error",
  ) => Promise<void> | void
  /** Per-turn debug sink. The runner forwards tool-call boundaries +
   *  compaction + agent_end totals; the sink decides what to drop by
   *  verbosity. */
  debug?: import("./debug/capture").DebugCapture
}

export type RunPiMonoTokenUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type RunPiMonoContextUsage = {
  tokens?: number
  contextWindow?: number
  percent?: number
}

export type RunPiMonoTurnResult = {
  text: string
  stopReason?: string
  error?: string
  stats: {
    tokenUsage: RunPiMonoTokenUsage
    /** cacheRead / (cacheRead + input). 0 when nothing cached. */
    cacheHitRatio: number
    contextUsage?: RunPiMonoContextUsage
    compactionRounds: number
    retryAttempts: number
    durationMs: number
  }
}

export async function runPiMonoTurn(
  args: RunPiMonoTurnArgs,
): Promise<RunPiMonoTurnResult> {
  const log = args.logger ?? Logger
  const modelId = args.modelId ?? resolveModelId(args.modelLabel)
  const llmModelName = getActualNameFromEnum(modelId) ?? modelId

  const baseUrl = config.LiteLLMBaseUrl?.endsWith("/v1")
    ? config.LiteLLMBaseUrl
    : `${config.LiteLLMBaseUrl ?? ""}/v1`
  const apiKey = config.LiteLLMApiKey ?? ""

  const sessionManager = getOrCreateSession(args.conversationId)
  const polarSessionId = args.message.match(/\[polar-session:([^\]]+)\]/)?.[1]

  log.info(
    {
      modelLabel: args.modelLabel,
      modelId: args.modelId,
      resolvedModelId: modelId,
      llmModelName,
      messageChars: args.message.length,
    },
    "pi-mono: run starting",
  )
  const startedAt = Date.now()

  // Precedence: env override → modelConfig → global default.
  const modelCfg = getModelConfiguration(modelId)
  const contextWindow = Number(
    process.env["BACKENDV2_PI_CONTEXT_WINDOW"] ??
      String(modelCfg?.contextWindow ?? 250_000),
  )
  const reserveTokens = Number(
    process.env["BACKENDV2_PI_RESERVE_TOKENS"] ??
      String(modelCfg?.reserveTokens ?? 40_192),
  )
  const keepRecentTokens = Number(
    process.env["BACKENDV2_PI_KEEP_RECENT_TOKENS"] ??
      String(modelCfg?.keepRecentTokens ?? 50_000),
  )

  const agent: RAGAgent<unknown> = await createRAGAgent({
    model: llmModelName,
    baseUrl,
    apiKey,
    sessionId: polarSessionId,
    // Tool list comes from the agent row's `tools` column; builder takes names
    // literally ([] means "no tools").
    tools: await (async () => {
      const hasScopedDocs = (args.scopedDocs?.length ?? 0) > 0
      const buildCtx = {
        userEmail: args.userEmail,
        logger: log,
        conversationId: args.conversationId,
        ...(args.agentScope ? { agentScope: args.agentScope } : {}),
        // Same LiteLLM handle the main RAGAgent uses, so a tool's own LLM call
        // (e.g. vespaSearch's in-tool relevance filter) hits the same model.
        llm: { model: llmModelName, baseUrl, apiKey, sessionId: polarSessionId },
        ...(args.onToolProgress ? { onToolProgress: args.onToolProgress } : {}),
      }
      // @-mentioned docs need vespaSearch available even if the agent's set
      // omits it, so the model can consult them.
      const baseNames = args.toolNames ?? []
      const toolNames =
        hasScopedDocs && !baseNames.includes("vespaSearch")
          ? [...baseNames, "vespaSearch"]
          : baseNames
      const base = buildToolsForRun(toolNames, buildCtx)
      // M7: dispatch tools require both ≥1 sub-agent AND persistence — without
      // persistence the nested run can't be recorded and the trace is lost.
      const subs = args.dispatchableSubAgents ?? []
      if (subs.length > 0 && args.dispatchPersistence) {
        // Both injected here (never in the static registry), so sub-agents
        // can't receive them — the flat hierarchy holds.
        const dispatchCtx = {
          userEmail: args.userEmail,
          logger: log,
          conversationId: args.conversationId,
          ...(args.agentScope ? { agentScope: args.agentScope } : {}),
          subAgents: subs,
          llm: { model: llmModelName, baseUrl, apiKey, sessionId: polarSessionId },
          // No thinkingLevel here — each sub-agent carries its own
          // (sub_agents.thinking_level), read off the resolved sub-agent.
          maxTokens: 16384,
          contextWindow,
          reserveTokens,
          keepRecentTokens,
          timeoutMs: 8 * 60 * 60 * 1000,
          persistence: args.dispatchPersistence,
          ...(args.onSubAgentStatus
            ? { onSubAgentStatus: args.onSubAgentStatus }
            : {}),
          ...(args.onSubAgentActivity
            ? { onSubAgentActivity: args.onSubAgentActivity }
            : {}),
          ...(args.makeSubAgentDebug
            ? { makeSubAgentDebug: args.makeSubAgentDebug }
            : {}),
        }
        base.push(buildDispatchSubagentTool(dispatchCtx))
        base.push(buildDispatchSubagentBatchTool(dispatchCtx))
      }
      // `skill` tool when the agent has ≥1 viewer-visible skill.
      const agentSkills = args.agentScope?.skills ?? []
      if (agentSkills.length > 0) {
        base.push(
          buildGetSkillTool({
            skills: agentSkills,
            logger: log,
          }),
        )
      }
      // "Generate Skills" mode: upsertSkill is the only tool (caller passes
      // toolNames=[] and no agentScope).
      if (args.skillAssist) {
        base.push(
          buildUpsertSkillTool({
            context: args.skillAssist.context,
            ...args.skillAssist.caps,
            logger: log,
          }),
        )
      }
      // MCP servers attached to the agent: connect, discover, and register each
      // remote tool. Async + fail-soft (unreachable servers are skipped).
      const mcpEntries = args.agentScope?.mcps ?? []
      if (mcpEntries.length > 0) {
        base.push(...(await buildMcpToolsForRun(mcpEntries, buildCtx)))
      }
      return base
    })(),
    systemPrompt: args.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    sessionManager,
    settingsManager: SettingsManager.inMemory({
      compaction: {
        enabled: true,
        reserveTokens,
        keepRecentTokens,
      },
      retry: { enabled: true, maxRetries: 2 },
    }),
    modelOptions: {
      contextWindow,
      maxTokens: 16384,
      reasoning: true,
    },
    // Per-model sampler params (e.g. Nemotron-120B → temp 1.0 / top_p 0.95).
    ...(() => {
      const cfg = getModelConfiguration(modelId)
      return cfg?.streamOptions ? { streamOptions: cfg.streamOptions } : {}
    })(),
    ...(args.debug ? { debug: args.debug } : {}),
    // Precedence: caller arg → per-model default (e.g. Nemotron pinned "low"
    // to dodge its reasoning-truncation cliff) → "medium".
    thinkingLevel: args.thinkingLevel ?? modelCfg?.thinkingLevel ?? "medium",
    extensions: [],
    timeoutMs: 8 * 60 * 60 * 1000,
  })

  let text = ""
  let stopReason: string | undefined
  let error: string | undefined
  // Pi-mono surfaces usage on each `message_end` (upstream AgentSessionEvent),
  // but our RAGEvent wrapper drops it — so we read it via the raw event.
  const tokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let compactionRounds = 0
  let retryAttempts = 0
  const toolStartByCallId = new Map<string, number>()
  const runStartedAt = Date.now()

  const onAbort = (): void => {
    agent.stop().catch(() => {})
  }
  args.signal?.addEventListener("abort", onAbort)

  // Preemptive compaction. Pi-coding-agent's auto-compaction is reactive: it
  // fires only AFTER an assistant message, off measured usage. On the first
  // call of a turn it has none, so an over-window history goes out raw and the
  // provider rejects it (stopReason=error, 0 input) — a blank turn. Worst on a
  // rehydrated session (restart): historical messages carry no `usage`, so even
  // the SDK's error-path estimate (estimateContextTokens) bails on
  // `lastUsageIndex === null`. So estimate via the usage-independent chars/4
  // heuristic and compact up front if over the SDK's threshold. No-op normally.

  // Uploaded-files reminder gating: inject on a turn with new attachments, or
  // the first turn after a compaction (steer + content were summarized away).
  // Consume the pending post-compaction flag now; a fresh compaction below may
  // re-set the intent for this same turn.
  const attachmentReminder = args.attachmentReminder ?? ""
  const convHasUploads = attachmentReminder.length > 0
  let injectReminder =
    args.messageHasAttachments === true ||
    (convHasUploads && reminderStaleAfterCompaction.has(args.conversationId))
  reminderStaleAfterCompaction.delete(args.conversationId)

  try {
    const session = agent.getSession()
    const msgs = session.messages
    const estimatedTokens = msgs.reduce((sum, m) => sum + estimateTokens(m), 0)
    const compactionSettings = {
      enabled: true,
      reserveTokens,
      keepRecentTokens,
    }
    if (shouldCompact(estimatedTokens, contextWindow, compactionSettings)) {
      log.info(
        {
          estimatedTokens,
          contextWindow,
          reserveTokens,
          messageCount: msgs.length,
        },
        "pi-mono: preemptive compaction (estimated context over threshold before first call)",
      )
      if (args.debug) {
        args.debug.emitCompactionStart({
          reason: "preemptive",
          tokensBefore: estimatedTokens,
          at: Date.now(),
        })
      }
      const result = await session.compact()
      compactionRounds++
      // Context just summarized — re-append the steer this turn and write the
      // file paths into the fresh summary so they survive the compacted history.
      if (convHasUploads) injectReminder = true
      appendFilesNoteToLatestSummary(
        agent,
        args.attachmentSummaryNote ?? "",
        log,
      )
      log.info(
        { tokensBefore: result.tokensBefore },
        "pi-mono: preemptive compaction done",
      )
      if (args.debug) {
        args.debug.emitCompactionEnd({
          ...(typeof result.tokensBefore === "number"
            ? { tokensBefore: result.tokensBefore }
            : {}),
          ...(typeof result.summary === "string" && result.summary.length > 0
            ? { summary: result.summary }
            : {}),
          aborted: false,
          at: Date.now(),
        })
      }
    }
  } catch (err) {
    // Best-effort — the SDK's reactive overflow recovery is still the backstop.
    log.warn(
      { err: (err as Error)?.message },
      "pi-mono: preemptive compaction failed; proceeding without it",
    )
  }

  // @-mention reminder: name the referenced docs + docIds so the model can
  // consult them. Informational only — does NOT hard-scope retrieval; not
  // persisted.
  const scopedDocsReminder =
    args.scopedDocs && args.scopedDocs.length > 0
      ? [
          "",
          "<system-reminder>",
          `The user referenced ${String(args.scopedDocs.length)} document(s) for this message:`,
          ...args.scopedDocs.map((d) => `- ${d.name} (docId: ${d.docId})`),
          "Prioritise these document(s) when answering — use the retrieval tools " +
            "(e.g. searchWithinDoc / getChunks with the docId above, or vespaSearch) " +
            "to consult them. The user's message above is the primary instruction.",
          "</system-reminder>",
        ].join("\n")
      : ""

  // Message sent to the LLM: user text plus the gated <system-reminder>s. These
  // ride only on this request — the persisted user message is unchanged, so the
  // reminders never appear in the UI.
  const steers = [
    injectReminder && attachmentReminder ? attachmentReminder : "",
    args.citationReminder ?? "",
    // Pre-flight planning reminder disabled for RL/tool-calling flow by default.
    process.env["BACKENDV2_PI_INJECT_PREFLIGHT"] === "true" ? args.preflightReminder ?? "" : "",
    scopedDocsReminder,
  ].filter((s) => s.length > 0)
  const runMessage =
    steers.length > 0 ? `${args.message}\n${steers.join("\n")}` : args.message
  if (steers.length > 0) {
    log.info("pi-mono: appended system-reminder steer(s) to the user message")
  }

  // Regenerate / edit-and-resend: keep the first N user turns, drop the edited
  // turn onward. Walk root→leaf, count user entries, branch to the last entry
  // before the (N+1)-th user message. agent.run() appends the edited prompt.
  if (typeof args.branchKeepUserTurns === "number") {
    const keep = args.branchKeepUserTurns
    const leafToRoot: { id: string; type: string; parentId: string | null }[] = []
    let walkId: string | null = sessionManager.getLeafId()
    while (walkId) {
      const entry = sessionManager.getEntry(walkId)
      if (!entry) break
      leafToRoot.push(entry)
      walkId = entry.parentId
    }
    const rootToLeaf = leafToRoot.reverse()
    let userSeen = 0
    let branchTargetId: string | null = null
    let cut = false
    for (const entry of rootToLeaf) {
      if (entry.type === "message") {
        const role = (entry as { message?: { role?: string } }).message?.role
        if (role === "user") {
          userSeen += 1
          if (userSeen === keep + 1) {
            cut = true
            break
          }
        }
      }
      branchTargetId = entry.id
    }
    if (cut) {
      if (branchTargetId) sessionManager.branch(branchTargetId)
      else sessionManager.resetLeaf()
      log.info(
        { keepUserTurns: keep },
        "pi-mono: edit — branched session to keep first N user turns",
      )
    } else {
      log.info(
        { keepUserTurns: keep },
        "pi-mono: edit — session has <= N user turns; running without branch",
      )
    }
  }

  try {
    for await (const event of agent.run(runMessage)) {
      // `raw` carries the original AgentSessionEvent — the RAGEvent mapper
      // drops usage + lifecycle events (compaction/retry), so we tap raw for
      // those. Everything else flows through the mapped events below.
      if (event.type === "raw") {
        const e = event.event as {
          type?: string
          message?: {
            role?: string
            usage?: {
              input?: number
              output?: number
              cacheRead?: number
              cacheWrite?: number
            }
          }
          reason?: string
          aborted?: boolean
          willRetry?: boolean
          errorMessage?: string
          attempt?: number
          maxAttempts?: number
          success?: boolean
          finalError?: string
          // Optional — some providers omit pre/post token counts.
          tokensBefore?: number
          tokensAfter?: number
          // compaction_end payload; present only on a non-aborted result.
          result?: {
            summary?: string
            firstKeptEntryId?: string
            tokensBefore?: number
          }
        }
        if (
          e.type === "message_end" &&
          e.message?.role === "assistant" &&
          e.message.usage
        ) {
          const u = e.message.usage
          tokenUsage.input += u.input ?? 0
          tokenUsage.output += u.output ?? 0
          tokenUsage.cacheRead += u.cacheRead ?? 0
          tokenUsage.cacheWrite += u.cacheWrite ?? 0
        } else if (e.type === "compaction_start") {
          // Pi-coding-agent ≥0.74 emits `compaction_start`/`compaction_end`
          // (agent-session.js:1451, :1569), not the older `auto_compaction_*`.
          compactionRounds++
          // Reactive compaction summarizes away the file content + steer
          // mid-turn; the user message is already sent, so re-append next turn.
          if (convHasUploads)
            reminderStaleAfterCompaction.add(args.conversationId)
          log.info({ reason: e.reason }, "pi-mono: compaction_start")
          if (args.debug) {
            args.debug.emitCompactionStart({
              reason: e.reason ?? "threshold",
              ...(typeof e.tokensBefore === "number"
                ? { tokensBefore: e.tokensBefore }
                : {}),
              at: Date.now(),
            })
          }
        } else if (e.type === "compaction_end") {
          log.info(
            {
              aborted: e.aborted,
              willRetry: e.willRetry,
              errorMessage: e.errorMessage?.slice(0, 300),
            },
            "pi-mono: compaction_end",
          )
          // Write the uploaded-files paths into the fresh summary so they survive it.
          if (!e.aborted) {
            appendFilesNoteToLatestSummary(
              agent,
              args.attachmentSummaryNote ?? "",
              log,
            )
          }
          if (args.debug) {
            // `tokensBefore` appears top-level (older runs) and nested in
            // `result` (newer pi-coding-agent); prefer nested when both present.
            const tokensBefore =
              typeof e.result?.tokensBefore === "number"
                ? e.result.tokensBefore
                : typeof e.tokensBefore === "number"
                  ? e.tokensBefore
                  : undefined
            args.debug.emitCompactionEnd({
              ...(tokensBefore !== undefined ? { tokensBefore } : {}),
              ...(typeof e.tokensAfter === "number"
                ? { tokensAfter: e.tokensAfter }
                : {}),
              ...(typeof e.result?.summary === "string" &&
              e.result.summary.length > 0
                ? { summary: e.result.summary }
                : {}),
              ...(typeof e.result?.firstKeptEntryId === "string"
                ? { firstKeptEntryId: e.result.firstKeptEntryId }
                : {}),
              ...(typeof e.errorMessage === "string" &&
              e.errorMessage.length > 0
                ? { errorMessage: e.errorMessage }
                : {}),
              at: Date.now(),
              aborted: !!e.aborted,
            })
            // Aborted compaction is a real failure — the summary didn't write
            // and the next call retries with the same large context.
            if (e.aborted) {
              args.debug.emitError({
                message: e.errorMessage ?? "compaction aborted",
              })
            }
          }
        } else if (e.type === "auto_retry_start") {
          retryAttempts++
          log.warn(
            {
              attempt: e.attempt,
              maxAttempts: e.maxAttempts,
              errorMessage: e.errorMessage?.slice(0, 300),
            },
            "pi-mono: auto_retry_start",
          )
          if (args.debug) {
            args.debug.emitRetryAttempt({
              phase: "start",
              attempt: e.attempt ?? retryAttempts,
              ...(typeof e.maxAttempts === "number"
                ? { maxAttempts: e.maxAttempts }
                : {}),
              ...(typeof e.errorMessage === "string"
                ? { errorMessage: e.errorMessage }
                : {}),
              at: Date.now(),
            })
          }
        } else if (e.type === "auto_retry_end") {
          log.info(
            {
              attempt: e.attempt,
              success: e.success,
              finalError: e.finalError?.slice(0, 300),
            },
            "pi-mono: auto_retry_end",
          )
          if (args.debug) {
            args.debug.emitRetryAttempt({
              phase: "end",
              attempt: e.attempt ?? retryAttempts,
              ...(typeof e.success === "boolean" ? { success: e.success } : {}),
              ...(typeof e.finalError === "string"
                ? { errorMessage: e.finalError }
                : {}),
              at: Date.now(),
            })
          }
        }
        continue
      }
      switch (event.type) {
        case "text_delta": {
          if (!event.delta) {
            break
          }
          text += event.delta
          if (args.onTextDelta) {
            await args.onTextDelta(event.delta)
          }
          break
        }
        case "thinking_start": {
          if (args.onThinkingStart) {
            await args.onThinkingStart()
          }
          break
        }
        case "thinking_delta": {
          if (!event.delta) {
            break
          }
          if (args.onThinkingDelta) {
            await args.onThinkingDelta(event.delta)
          }
          break
        }
        case "thinking_end": {
          if (args.onThinkingEnd) {
            await args.onThinkingEnd()
          }
          break
        }
        case "tool_call": {
          if (args.debug) {
            toolStartByCallId.set(event.toolCallId, Date.now())
            args.debug.emitToolCallStart({
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              args: event.args,
              startedAt: Date.now(),
            })
          }
          if (args.onToolCall) {
            await args.onToolCall({
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              args: event.args,
            })
          }
          break
        }
        case "tool_result": {
          if (args.debug) {
            const startedAt = toolStartByCallId.get(event.toolCallId)
            const durationMs =
              startedAt !== undefined ? Date.now() - startedAt : 0
            toolStartByCallId.delete(event.toolCallId)
            args.debug.emitToolCallEnd({
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              durationMs,
              isError: event.isError,
              result: event.result,
            })
            // Also emit a separate `error` event so the debug timeline
            // highlights the failure without expanding the tool_call_end row.
            if (event.isError) {
              const msg =
                event.result &&
                typeof event.result === "object" &&
                "error" in event.result &&
                typeof (event.result as { error?: unknown }).error === "string"
                  ? (event.result as { error: string }).error
                  : `${event.toolName} returned isError=true`
              args.debug.emitError({
                message: msg,
                toolName: event.toolName,
              })
            }
          }
          if (args.onToolResult) {
            await args.onToolResult({
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              result: event.result,
              isError: event.isError,
            })
          }
          break
        }
        case "message_end": {
          if (event.message.role === "assistant" && event.message.stopReason) {
            stopReason = event.message.stopReason
          }
          // Pi-mono sometimes fills full content only on message_end (no
          // text_delta) — pick it up if we didn't stream anything.
          if (
            event.message.role === "assistant" &&
            !text.trim() &&
            event.message.content
          ) {
            const content = event.message.content
            const final = typeof content === "string" ? content.trim() : ""
            if (final) {
              text = final
              if (args.onTextDelta) {
                await args.onTextDelta(final)
              }
            }
          }
          break
        }
        case "error": {
          // Surface upstream stream errors (LiteLLM timeouts, parse failures)
          // in the run log so a stuck turn has a debuggable footprint.
          error = event.error.message
          log.error(
            { errorMessage: event.error.message, code: event.error.code },
            "pi-mono: error event",
          )
          if (args.debug) {
            args.debug.emitError({ message: event.error.message })
          }
          break
        }
        default:
          break
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    log.error({ err }, "pi-mono run failed")
    if (args.debug) {
      args.debug.emitError({ message: error })
    }
  } finally {
    args.signal?.removeEventListener("abort", onAbort)
  }

  // Snapshot context usage BEFORE disposing the session, via
  // agent.getSession().getContextUsage().
  let contextUsage:
    | { tokens?: number; contextWindow?: number; percent?: number }
    | undefined
  try {
    const sess = (
      agent as unknown as {
        getSession?: () => {
          getContextUsage?: () =>
            | { tokens?: number; contextWindow?: number; percent?: number }
            | undefined
        }
      }
    ).getSession?.()
    const usage = sess?.getContextUsage?.()
    if (usage) {
      // Conditional spreads — exactOptionalPropertyTypes rejects explicit
      // `: undefined` on optional fields.
      contextUsage = {
        ...(usage.tokens !== undefined ? { tokens: usage.tokens } : {}),
        ...(usage.contextWindow !== undefined
          ? { contextWindow: usage.contextWindow }
          : {}),
        ...(usage.percent !== undefined ? { percent: usage.percent } : {}),
      }
    }
  } catch {
    // best-effort, never block run completion on telemetry
  }
  agent.dispose()

  const durationMs = Date.now() - startedAt
  const cacheHitRatio =
    tokenUsage.cacheRead + tokenUsage.input > 0
      ? Number(
          (
            tokenUsage.cacheRead /
            (tokenUsage.cacheRead + tokenUsage.input)
          ).toFixed(3),
        )
      : 0
  const stats: RunPiMonoTurnResult["stats"] = {
    tokenUsage,
    cacheHitRatio,
    ...(contextUsage ? { contextUsage } : {}),
    compactionRounds,
    retryAttempts,
    durationMs,
  }

  log.info(
    { stopReason, error, textChars: text.length, ...stats },
    error ? "pi-mono: run errored" : "pi-mono: run completed",
  )

  if (args.debug) {
    if (error) {
      args.debug.emitError({ message: error })
    }
    args.debug.emitAgentEnd({
      stopReason: stopReason ?? (error ? "error" : "stop"),
      tokenUsage,
      durationMs: Date.now() - runStartedAt,
    })
  }

  return error
    ? { text, ...(stopReason !== undefined && { stopReason }), error, stats }
    : { text, ...(stopReason !== undefined && { stopReason }), stats }
}
