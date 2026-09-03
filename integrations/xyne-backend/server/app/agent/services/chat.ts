// ChatService — business logic on top of the storage strategies.
// Auth checks live here, NOT in the repos.

import type { AgentDeps } from "../wiring"
import {
  type AgentScope,
  type DispatchableSubAgent,
  loadAgentScope,
  loadWorkspaceDefaultPromptInputs,
} from "../agent-scope"
import {
  forkSession,
  hasSession as hasPiMonoSession,
  hydrateSession as hydratePiMonoSession,
  runPiMonoTurn,
} from "../pi-mono/runner"
import {
  buildSkillAgentSystemPrompt,
  SKILL_CAPS,
} from "../pi-mono/skill-agent"
import { CITATION_REMINDER } from "../pi-mono/citation-reminder"
import { runPreflight, shouldPreflight } from "../preflight/generate"
import { DebugCapture } from "../pi-mono/debug/capture"
import {
  appendPersistedEvent,
  readPersistedEvents,
} from "../pi-mono/debug/persist"
import type { DebugEvent } from "../pi-mono/debug/types"
import { resolveAgentSystemPrompt } from "../pi-mono/system-prompt"
import type { NestedRunPersistence } from "../pi-mono/tools/dispatch-subagent"
import { generateTitle } from "../title/generate"
import { generateFollowUps } from "../follow-ups/generate"
import {
  associateAttachmentsWithMessage,
  buildUploadedFilesReminder,
  buildUploadedFilesSummaryNote,
} from "./chatAttachments"
import { baseLogger } from "../log"
import { db } from "@/platform/db/client"
import {
  getRecordItemByPathInCollections,
  getAllFolderIds,
  getCollectionItemById,
  getCollectionIdsForItems,
} from "@/platform/db/knowledgeBase"

const Logger = baseLogger("backendv2/chat")
import {
  type AppendTurnResult,
  type Block,
  type Conversation,
  type ConversationId,
  type ConversationOrigin,
  type Cursor,
  type Message,
  type MessageFeedback,
  type MessageFeedbackRating,
  type MessageId,
  type MessageWithBlocks,
  type Page,
  type Run,
  type RunId,
  type TurnId,
  type RunStatus,
  type ToolCallId,
  type Turn,
  type UserId,
  type WorkspaceId,
  asAgentId,
  asMessageId,
  asRunId,
  asToolCallId,
  asUserId,
  asWorkspaceId,
} from "../storage/types"

/** Flatten a message's `text` blocks for the pre-flight passes. */
const extractBlocksText = (blocks: Block[]): string =>
  blocks
    .filter((b): b is Extract<Block, { kind: "text" }> => b.kind === "text")
    .map((b) => b.text)
    .join("\n")
    .trim()

export type Viewer = {
  userId: UserId
  workspaceId: WorkspaceId
}

export type SendMessageInput = {
  conversationId: ConversationId
  text: string
  model?: string
  /** Deliberately NOT `c.req.raw.signal` — runs must outlive client
   *  disconnects so refresh/tab-close can resume via SSE. */
  signal?: AbortSignal
  /** When set, the agent's allowlist (apps, docIds, KB collections) drives doc
   *  visibility — how a user reads docs shared through a public agent without
   *  owning them. Permission checked against v1's `userAgentPermissions` +
   *  `isPublic`. */
  agentId?: string
  /** Maps to pi-ai's ThinkingLevel. Absent = server default (medium). */
  thinkingLevel?: "minimal" | "low" | "medium" | "high"
  /** Capture pi-mono + provider activity into the SSE stream for the debug
   *  panel. Off by default. */
  debug?: boolean
  debugVerbosity?: "summary" | "detailed"
  attachmentIds?: string[]
  /** "Generate Skills" mode: uses the in-code skill authoring agent
   *  (upsertSkill only) instead of an agent row. `skillContext` is the form
   *  snapshot upsertSkill returns on a READ. agentId/thinkingLevel ignored. */
  skillAssist?: boolean
  skillContext?: {
    mode: "create" | "edit"
    alias: string
    name: string
    description: string
    content: string
  }
  /** Edit-and-resend: keep only the first N user turns of the in-memory
   *  session before running (see runPiMonoTurn.branchKeepUserTurns). */
  branchKeepUserTurns?: number
  /** Per-turn `@`-mention doc scope; constrains retrieval to these for the turn. */
  scopedDocs?: { docId: string; name: string }[]
  /** Optional KB path (e.g. `Collection/folder/file`) narrowing this turn's
   *  retrieval. Mirrors v1's `path`. REQUIRES `agentId`: resolved to a vespa
   *  doc id, validated within the agent's KB integrations (403 otherwise),
   *  then replaces the agent's `collectionSelections` for this turn only. */
  path?: string
}

export type ChatRunResult = {
  status: RunStatus
  conversationId: ConversationId
  runId: RunId
  userMessageId?: MessageId
  assistantMessageId?: MessageId
  answer?: string
  modelId: string
  agentId: string
  error?: string
}

export const viewerFromPayload = (p: {
  sub: string
  workspaceId: string
}): Viewer => ({
  userId: asUserId(p.sub),
  workspaceId: asWorkspaceId(p.workspaceId),
})

export class ConversationNotFoundError extends Error {
  public override readonly name = "ConversationNotFoundError"
  public readonly id: ConversationId
  public constructor(id: ConversationId) {
    super(`Conversation ${String(id)} not found`)
    this.id = id
  }
}

export class MessageNotFoundError extends Error {
  public override readonly name = "MessageNotFoundError"
  public constructor(id: MessageId) {
    super(`Message ${String(id)} not found`)
  }
}

export class RunNotFoundError extends Error {
  public override readonly name = "RunNotFoundError"
  public constructor(id: RunId) {
    super(`Run ${String(id)} not found`)
  }
}

export class ForbiddenError extends Error {
  public override readonly name = "ForbiddenError"
}

/** Unresolvable `path`, or `path` without `agentId` → HTTP 400. (Resolved but
 *  outside the agent's scope is `ForbiddenError` → 403 instead, mirroring v1.) */
export class InvalidPathError extends Error {
  public override readonly name = "InvalidPathError"
}

/** New message on a conversation that already has an in-flight run. Enforced
 *  server-side so two tabs / a buggy client can't fan out parallel runs and
 *  orphan the first. */
export class ConcurrentRunError extends Error {
  public override readonly name = "ConcurrentRunError"
  public readonly conversationId: ConversationId
  public constructor(conversationId: ConversationId) {
    super(`Conversation ${String(conversationId)} already has an in-flight run`)
    this.conversationId = conversationId
  }
}

/** `agentId` that doesn't exist, is soft-deleted, or is private to another
 *  user → HTTP 403. */
export class AgentNotAccessibleError extends Error {
  public override readonly name = "AgentNotAccessibleError"
  public readonly agentExternalId: string
  public constructor(agentExternalId: string) {
    super(`Agent ${agentExternalId} is not accessible to this viewer`)
    this.agentExternalId = agentExternalId
  }
}

/** Regenerate can't proceed (no assistant response yet, or target isn't the
 *  latest) → HTTP 409. */
export class RegenerateNotAllowedError extends Error {
  public override readonly name = "RegenerateNotAllowedError"
}

export class ChatService {
  // In-flight pi-mono run per conversation, so `interrupt` can abort it. Keyed
  // by conversation (not runId): "stop" is a conversation-scoped gesture and
  // at-most-one run is active per conversation today.
  private readonly inflight = new Map<string, AbortController>()

  private readonly runCompletions = new Map<string, Promise<void>>()

  // Detached follow-up generation per conversation; aborted when a new message
  // arrives so stale chips aren't appended onto a turn we've moved past.
  private readonly followUpInflight = new Map<string, AbortController>()

  private readonly deps: AgentDeps

  public constructor(deps: AgentDeps) {
    this.deps = deps
  }

  /** Best-effort cancel of the conversation's in-flight run. Returns false when
   *  there was nothing to interrupt (idle, or already finished). */
  public async interrupt(
    viewer: Viewer,
    conversationId: ConversationId,
  ): Promise<{ interrupted: boolean }> {
    await this.getConversation(viewer, conversationId) // permission check
    const key = String(conversationId)
    const ctrl = this.inflight.get(key)
    if (!ctrl) {
      return { interrupted: false }
    }
    ctrl.abort()
    // Don't delete here — sendMessage's finally removes its own entry, so a
    // late interrupt is a harmless no-op rather than a race.
    return { interrupted: true }
  }

  /** Registers a non-agentic turn in the same single-flight slot agentic runs
   *  use, so interrupt() and the ConcurrentRunError guard apply identically. */
  public beginNonAgenticRun(conversationId: ConversationId): AbortController {
    const key = String(conversationId)
    if (this.inflight.has(key)) {
      throw new ConcurrentRunError(conversationId)
    }
    const ctrl = new AbortController()
    this.inflight.set(key, ctrl)
    return ctrl
  }

  /** Guarded release — mirrors streamRun's finally below. */
  public endNonAgenticRun(
    conversationId: ConversationId,
    ctrl: AbortController,
  ): void {
    const key = String(conversationId)
    if (this.inflight.get(key) === ctrl) {
      this.inflight.delete(key)
    }
  }

  // ─── Conversations ─────────────────────────────────────────────────────
  public async createConversation(
    viewer: Viewer,
    title: string,
    originKind?: ConversationOrigin,
    agentId?: string,
  ): Promise<Conversation> {
    return this.deps.convs.create(
      {
        ownerId: viewer.userId,
        workspaceId: viewer.workspaceId,
        title: title.trim().length > 0 ? title.trim() : "New chat",
        ...(originKind ? { originKind } : {}),
        ...(agentId ? { agentId: asAgentId(agentId) } : {}),
      },
      newIdemKey(),
    )
  }

  public async listConversations(
    viewer: Viewer,
    page: Cursor,
    originKind: ConversationOrigin = "chat",
  ): Promise<Page<Conversation>> {
    return this.deps.convs.listByOwner(viewer.userId, page, undefined, originKind)
  }

  public async getConversation(
    viewer: Viewer,
    id: ConversationId,
  ): Promise<Conversation> {
    const conv = await this.deps.convs.get(id)
    if (!conv) {
      throw new ConversationNotFoundError(id)
    }
    if (conv.ownerId !== viewer.userId) {
      throw new ForbiddenError("Not your conversation")
    }
    return conv
  }

  public async renameConversation(
    viewer: Viewer,
    id: ConversationId,
    title: string,
  ): Promise<void> {
    await this.getConversation(viewer, id) // permission check
    await this.deps.convs.patch(id, { title })
  }

  public async archiveConversation(
    viewer: Viewer,
    id: ConversationId,
  ): Promise<void> {
    await this.getConversation(viewer, id)
    await this.deps.convs.softDelete(id)
  }

  /** Star / unstar (pin) a conversation. */
  public async setConversationStarred(
    viewer: Viewer,
    id: ConversationId,
    starred: boolean,
  ): Promise<void> {
    await this.getConversation(viewer, id) // permission check
    await this.deps.convs.patch(id, { starred })
  }

  // ─── Messages ──────────────────────────────────────────────────────────
  public async sendMessage(
    viewer: Viewer,
    input: SendMessageInput,
  ): Promise<AppendTurnResult & { assistantMessage: Message }> {
    const conv = await this.getConversation(viewer, input.conversationId)
    const text = input.text.trim()
    if (!text) {
      throw new Error("Message text required")
    }

    // Cancel the previous turn's now-stale follow-up generation.
    const prevFollowUp = this.followUpInflight.get(String(conv.id))
    if (prevFollowUp) {
      prevFollowUp.abort()
      this.followUpInflight.delete(String(conv.id))
    }

    // Resolve agent scope BEFORE the inflight check so an unauthorized request
    // fails fast (no slot taken, no DB writes).
    let agentScope: AgentScope | undefined
    if (input.agentId) {
      const scope = await loadAgentScope(viewer, input.agentId)
      if (!scope) {
        throw new AgentNotAccessibleError(input.agentId)
      }
      agentScope = scope
    }

    // Optional `path` scoping (mirrors v1). Resolved up-front so an invalid or
    // forbidden path fails the POST fast (400/403) before any rows are written;
    // when set it replaces the agent's `collectionSelections` for this turn.
    if (input.path) {
      if (!agentScope) {
        throw new InvalidPathError("`path` requires an `agentId`")
      }
      // The agent's grant — NOT the viewer's ownership — is the access boundary
      // for `path`, so a public/shared agent works for callers who don't own
      // the collection.
      const allowedCollections = new Set<string>()
      const allowedFolders = new Set<string>()
      const allowedFiles = new Set<string>()
      for (const s of agentScope.collectionSelections) {
        for (const id of s.collectionIds ?? []) allowedCollections.add(id)
        for (const id of s.collectionFolderIds ?? []) allowedFolders.add(id)
        for (const id of s.collectionFileIds ?? []) allowedFiles.add(id)
      }
      // Collections the path may resolve within: directly-granted collections
      // PLUS the collections behind any granted folders/files (single query).
      const agentCollectionIds = new Set(allowedCollections)
      const folderFileCollectionIds = await getCollectionIdsForItems(
        [...allowedFolders, ...allowedFiles],
        db,
      )
      for (const collectionId of folderFileCollectionIds) {
        agentCollectionIds.add(collectionId)
      }
      // Resolve WITHIN the agent's collections (no viewer-ownership gate; also
      // disambiguates same-named collections to the one the agent is scoped to).
      const item = await getRecordItemByPathInCollections(
        input.path,
        db,
        [...agentCollectionIds],
      )
      if (!item || !item.vespaDocId) {
        throw new InvalidPathError(
          `The given path '${input.path}' is not a valid collection folder or file`,
        )
      }
      // Authorize by walking the item's ancestry UP and testing membership.
      // (Expanding the grant DOWN to every descendant times out on large
      // collections, e.g. 38k items.)
      let authorized =
        allowedCollections.has(item.collectionId) ||
        (item.type === "file" && allowedFiles.has(item.id)) ||
        (item.type === "folder" && allowedFolders.has(item.id))
      // Path may sit under an allowed ancestor folder. `visited` guards against
      // a cyclic parentId (corrupt data) looping forever.
      let ancestorId = item.parentId
      const visited = new Set<string>()
      while (!authorized && ancestorId && !visited.has(ancestorId)) {
        visited.add(ancestorId)
        if (allowedFolders.has(ancestorId)) {
          authorized = true
          break
        }
        const parent = await getCollectionItemById(db, ancestorId)
        ancestorId = parent?.parentId ?? null
      }
      if (!authorized) {
        throw new ForbiddenError(
          `Access denied: the path '${input.path}' is not accessible through this agent's integrations`,
        )
      }
      // Narrow to the resolved item. `clFd`/`docId` store BARE ids (use `item.id`
      // directly). A folder also pulls in its sub-folders because `clFd` on a doc
      // only carries its DIRECT parent. The resolver only returns folder/file —
      // guard the unexpected, since an empty selection would run search UNSCOPED.
      let selection: {
        collectionFolderIds?: string[]
        collectionFileIds?: string[]
      }
      if (item.type === "folder") {
        const subFolderIds = await getAllFolderIds([item.id], db)
        selection = {
          collectionFolderIds: [...new Set([item.id, ...subFolderIds])],
        }
      } else if (item.type === "file") {
        selection = { collectionFileIds: [item.id] }
      } else {
        throw new InvalidPathError(
          `The given path '${input.path}' is not a valid collection folder or file`,
        )
      }
      agentScope = {
        ...agentScope,
        collectionSelections: [selection],
      }
    }

    const selectedTopLevelAgentId = input.skillAssist
      ? asAgentId("skill-assistant")
      : agentScope
        ? asAgentId(agentScope.externalId)
        : (conv.agentId ?? asAgentId("main"))

    // Reject a second concurrent send (see ConcurrentRunError).
    const inflightKey = String(conv.id)
    if (this.inflight.has(inflightKey)) {
      throw new ConcurrentRunError(conv.id)
    }

    // Register this turn's AbortController for `interrupt()`, chained off any
    // external signal so both sources can cancel.
    const ctrl = new AbortController()
    if (input.signal) {
      if (input.signal.aborted) {
        ctrl.abort()
      } else {
        input.signal.addEventListener("abort", () => ctrl.abort(), {
          once: true,
        })
      }
    }
    this.inflight.set(inflightKey, ctrl)

    // Synchronous phase: create turn + user message + run + empty assistant
    // placeholder and publish initial SSE events. The pi-mono iteration is then
    // detached (`void this.streamRun(...)`) so POST returns in ms; the client's
    // SSE subscription is the real read channel for streaming content.
    let setup: AppendTurnResult & {
      assistantMessage: Message
      runId: RunId
      runLog: import("../log").Log
    }
    try {
      setup = await this.deps.uow.run(async (tx) => {
        const turnWriteKey = newIdemKey()
        const runWriteKey = `${turnWriteKey}:run`
        const asstWriteKey = `${turnWriteKey}:asst`

        const baseLog = Logger.child({
          conversationId: String(conv.id),
          userId: String(viewer.userId),
          workspaceId: String(viewer.workspaceId),
          modelLabel: input.model,
        })
        baseLog.info({ messageChars: text.length }, "chat: sendMessage start")

        const userBlock: Block = { kind: "text", text }
        const turnResult = await this.deps.msgs.appendTurn(
          {
            conversationId: conv.id,
            userMessage: { blocks: [userBlock] },
          },
          turnWriteKey,
          tx,
        )
        const turnLog = baseLog.child({
          turnId: String(turnResult.turn.id),
          userMessageId: String(turnResult.userMessage.id),
        })
        turnLog.info(
          { ordinal: turnResult.userMessage.ordinal },
          "chat: turn appended",
        )

        await this.deps.stream.publish(channelFor(conv.id), {
          kind: "turn_started",
          turnId: turnResult.turn.id,
          conversationId: conv.id,
        })

        // Stamp pending attachments BEFORE the SSE event fires so the client's
        // refetch already sees message_id set. The tx client lets the FK to the
        // just-created (uncommitted) user message resolve.
        if (input.attachmentIds && input.attachmentIds.length > 0) {
          try {
            // PostgresUnitOfWork wraps the drizzle txn behind an opaque `Tx`
            // brand (`{ _tx: true, client }`); the attachment helper wants the
            // raw client, so pluck it out (same shape postgres.ts uses).
            const txClient = (
              tx as unknown as { client: import("@/types").TxnOrClient }
            ).client
            await associateAttachmentsWithMessage({
              conversationId: String(conv.id),
              messageId: String(turnResult.userMessage.id),
              attachmentIds: input.attachmentIds,
              client: txClient,
            })
          } catch (err) {
            // Best-effort: a stale/already-associated attachment shouldn't tank the turn.
            turnLog.warn(
              {
                err: (err as Error)?.message,
                attachmentCount: input.attachmentIds.length,
              },
              "chat: failed to associate attachments with user message",
            )
          }
        }

        await this.deps.stream.publish(channelFor(conv.id), {
          kind: "message_appended",
          messageId: turnResult.userMessage.id,
          role: "user",
        })

        if (turnResult.userMessage.ordinal === 1) {
          void this.renameFromFirstMessage(conv.id, text, turnLog)
        }

        const run = await this.deps.msgs.startRun(
          turnResult.turn.id,
          {
            agentId: selectedTopLevelAgentId,
            model: input.model ?? "default",
          },
          runWriteKey,
          tx,
        )
        await this.deps.stream.publish(channelFor(conv.id), {
          kind: "run_started",
          runId: run.id,
          turnId: turnResult.turn.id,
          agentId: run.agentId,
        })

        // Empty assistant message; blocks get appended live as pi-mono streams.
        const assistantMessage = await this.deps.msgs.appendAssistantMessage(
          run.id,
          { blocks: [] },
          asstWriteKey,
          tx,
        )
        const runLog = turnLog.child({
          runId: String(run.id),
          agentId: String(run.agentId),
          assistantMessageId: String(assistantMessage.id),
        })
        runLog.info("chat: run started")
        await this.deps.stream.publish(channelFor(conv.id), {
          kind: "message_appended",
          messageId: assistantMessage.id,
          role: "assistant",
        })

        return { ...turnResult, assistantMessage, runId: run.id, runLog }
      })
    } catch (err) {
      // Setup failed — release the slot so a legitimate retry isn't bounced by the 409.
      if (this.inflight.get(inflightKey) === ctrl) {
        this.inflight.delete(inflightKey)
      }
      throw err
    }

    // Background phase: the pi-mono iteration. Detached on purpose.
    const completion = this.streamRun({
      conv,
      ctrl,
      inflightKey,
      input,
      viewerUserId: viewer.userId,
      viewerWorkspaceId: viewer.workspaceId,
      runId: setup.runId,
      assistantMessage: setup.assistantMessage,
      turn: setup.turn,
      runLog: setup.runLog,
      ...(agentScope ? { agentScope } : {}),
    })
    this.runCompletions.set(String(setup.runId), completion)
    void completion.finally(() => {
      if (this.runCompletions.get(String(setup.runId)) === completion) {
        this.runCompletions.delete(String(setup.runId))
      }
    })

    return {
      turn: setup.turn,
      userMessage: setup.userMessage,
      assistantMessage: setup.assistantMessage,
    }
  }

  /** Regenerate ANY assistant response: deletes all turns after the target's,
   *  drops that turn's assistant output (keeping its user message + attachments),
   *  then re-runs the prompt under a fresh run. The in-memory session is branched
   *  to keep only the turns before this one (branchKeepUserTurns). Targets the
   *  latest assistant message when `assistantMessageId` is omitted. */
  public async regenerateResponse(
    viewer: Viewer,
    input: {
      conversationId: ConversationId
      /** The assistant message to regenerate. Omit to target the latest. */
      assistantMessageId?: string
      /** Capture pi-mono/provider activity for the debug panel; without it the
       *  regenerated run produces no debug events. */
      debug?: boolean
      debugVerbosity?: "summary" | "detailed"
    },
  ): Promise<{ assistantMessage: Message }> {
    const conv = await this.getConversation(viewer, input.conversationId)

    // Full (paginated) message list to find the target + its turn's user prompt.
    const all: MessageWithBlocks[] = []
    let cursor: Cursor = { kind: "first", limit: 200 }
    for (;;) {
      const page = await this.deps.msgs.listMessages(conv.id, cursor)
      all.push(...page.items)
      if (!page.nextCursor) break
      cursor = { kind: "after", token: page.nextCursor, limit: 200 }
    }

    let target: MessageWithBlocks | undefined
    if (input.assistantMessageId) {
      target = all.find(
        (m) => String(m.id) === input.assistantMessageId && m.role === "assistant",
      )
    } else {
      for (let i = all.length - 1; i >= 0; i--) {
        if (all[i]!.role === "assistant") {
          target = all[i]
          break
        }
      }
    }
    if (!target) {
      throw new RegenerateNotAllowedError(
        "No matching assistant response to regenerate",
      )
    }

    const turnId = target.turnId
    const userMsg = all.find((m) => m.turnId === turnId && m.role === "user")
    const userText = extractBlocksText(userMsg?.blocks ?? [])
    if (!userMsg || !userText) {
      throw new RegenerateNotAllowedError(
        "Cannot regenerate: the turn's user prompt has no text",
      )
    }
    const keepUserTurns = all.filter(
      (m) => m.role === "user" && m.ordinal < userMsg.ordinal,
    ).length

    // Single-flight guard before the destructive delete.
    const inflightKey = String(conv.id)
    if (this.inflight.has(inflightKey)) {
      throw new ConcurrentRunError(conv.id)
    }
    const ctrl = new AbortController()
    this.inflight.set(inflightKey, ctrl)

    let setup: {
      assistantMessage: Message
      runId: RunId
      runLog: import("../log").Log
      model?: string
    }
    try {
      setup = await this.deps.uow.run(async (tx) => {
        const baseLog = Logger.child({
          conversationId: String(conv.id),
          userId: String(viewer.userId),
          workspaceId: String(viewer.workspaceId),
          turnId: String(turnId),
        })
        baseLog.info("chat: regenerate start")

        // Preserve the original run's model selection (best effort).
        const priorRuns = await this.deps.msgs.listRunsForTurn(turnId, tx)
        const parentRun = priorRuns.find((r) => !r.parentRunId)
        const model =
          parentRun?.model && parentRun.model !== "default"
            ? parentRun.model
            : undefined

        // Discard everything after this turn, then this turn's answer; the turn
        // row + its user message (and attachments) survive.
        await this.deps.msgs.deleteTurnsAfter(conv.id, turnId, tx)
        await this.deps.msgs.deleteTurnAssistantOutput(turnId, tx)

        const idem = newIdemKey()
        const run = await this.deps.msgs.startRun(
          turnId,
          { agentId: asAgentId("main"), model: model ?? "default" },
          `${idem}:run`,
          tx,
        )
        await this.deps.stream.publish(channelFor(conv.id), {
          kind: "run_started",
          runId: run.id,
          turnId,
          agentId: run.agentId,
        })

        const assistantMessage = await this.deps.msgs.appendAssistantMessage(
          run.id,
          { blocks: [] },
          `${idem}:asst`,
          tx,
        )
        await this.deps.stream.publish(channelFor(conv.id), {
          kind: "message_appended",
          messageId: assistantMessage.id,
          role: "assistant",
        })

        const runLog = baseLog.child({
          runId: String(run.id),
          assistantMessageId: String(assistantMessage.id),
        })
        return {
          assistantMessage,
          runId: run.id,
          runLog,
          ...(model ? { model } : {}),
        }
      })
    } catch (err) {
      if (this.inflight.get(inflightKey) === ctrl) {
        this.inflight.delete(inflightKey)
      }
      throw err
    }

    // Reconstruct a minimal Turn for streamRun (it only reads turn.id).
    const turn: Turn = {
      id: turnId,
      conversationId: conv.id,
      status: "running",
      startedAt: Date.now(),
    }

    void this.streamRun({
      conv,
      ctrl,
      inflightKey,
      input: {
        text: userText,
        branchKeepUserTurns: keepUserTurns,
        ...(setup.model ? { model: setup.model } : {}),
        ...(input.debug ? { debug: true } : {}),
        ...(input.debugVerbosity ? { debugVerbosity: input.debugVerbosity } : {}),
      },
      viewerUserId: viewer.userId,
      viewerWorkspaceId: viewer.workspaceId,
      runId: setup.runId,
      assistantMessage: setup.assistantMessage,
      turn,
      runLog: setup.runLog,
    })

    return { assistantMessage: setup.assistantMessage }
  }

  /** Edit a user message and re-run from there. Deletes the edited turn and
   *  everything after it, then sends `text` as a fresh turn with the session
   *  branched back to the turns before the edit (branchKeepUserTurns). */
  public async editUserMessageAndResend(
    viewer: Viewer,
    input: {
      conversationId: ConversationId
      messageId: string
      text: string
      debug?: boolean
      debugVerbosity?: "summary" | "detailed"
    },
  ): Promise<AppendTurnResult & { assistantMessage: Message }> {
    const conv = await this.getConversation(viewer, input.conversationId)
    const newText = input.text.trim()
    if (!newText) {
      throw new RegenerateNotAllowedError("Edited message cannot be empty")
    }

    const all: MessageWithBlocks[] = []
    let cursor: Cursor = { kind: "first", limit: 200 }
    for (;;) {
      const page = await this.deps.msgs.listMessages(conv.id, cursor)
      all.push(...page.items)
      if (!page.nextCursor) break
      cursor = { kind: "after", token: page.nextCursor, limit: 200 }
    }

    const edited = all.find((m) => String(m.id) === input.messageId)
    if (!edited || edited.role !== "user") {
      throw new MessageNotFoundError(asMessageId(input.messageId))
    }
    const fromOrdinal = edited.ordinal
    const keepUserTurns = all.filter(
      (m) => m.role === "user" && m.ordinal < fromOrdinal,
    ).length

    // Block the truncate if a run is in flight — checking first avoids deleting
    // turns and then failing the resend on the same guard.
    if (this.inflight.has(String(conv.id))) {
      throw new ConcurrentRunError(conv.id)
    }

    await this.deps.uow.run((tx) =>
      this.deps.msgs.deleteTurnsFrom(conv.id, fromOrdinal, tx),
    )

    return this.sendMessage(viewer, {
      conversationId: conv.id,
      text: newText,
      branchKeepUserTurns: keepUserTurns,
      ...(input.debug ? { debug: true } : {}),
      ...(input.debugVerbosity ? { debugVerbosity: input.debugVerbosity } : {}),
    })
  }

  /** Fork the conversation at `uptoMessageId` into a new one: copies the
   *  transcript up to AND including that message's turn, clones the in-memory
   *  pi-mono session to the same point (so the fork keeps LLM context when
   *  continued), and returns the new id. The original is untouched. */
  public async forkConversation(
    viewer: Viewer,
    input: { conversationId: ConversationId; uptoMessageId: string },
  ): Promise<{ conversationId: string }> {
    const conv = await this.getConversation(viewer, input.conversationId)

    const all: MessageWithBlocks[] = []
    let cursor: Cursor = { kind: "first", limit: 200 }
    for (;;) {
      const page = await this.deps.msgs.listMessages(conv.id, cursor)
      all.push(...page.items)
      if (!page.nextCursor) break
      cursor = { kind: "after", token: page.nextCursor, limit: 200 }
    }

    const target = all.find((m) => String(m.id) === input.uptoMessageId)
    if (!target) {
      throw new MessageNotFoundError(asMessageId(input.uptoMessageId))
    }
    // Keep up to and including the target message's whole turn.
    const boundaryOrdinal = all
      .filter((m) => m.turnId === target.turnId)
      .reduce((max, m) => Math.max(max, m.ordinal), 0)
    const kept = all.filter((m) => m.ordinal <= boundaryOrdinal)
    if (kept.length === 0) {
      throw new RegenerateNotAllowedError("Nothing to fork")
    }
    const keepUserTurns = kept.filter((m) => m.role === "user").length

    const baseTitle = conv.title ?? "New chat"
    const newConv = await this.deps.convs.create(
      {
        ownerId: viewer.userId,
        workspaceId: viewer.workspaceId,
        title: /\(forked\)\s*$/.test(baseTitle)
          ? baseTitle
          : `${baseTitle} (forked)`,
      },
      newIdemKey(),
    )

    // Rebuild turn by turn. The kept list is ordinal-ordered: a user message
    // opens a turn, the assistant message(s) that follow close it.
    await this.deps.uow.run(async (tx) => {
      let current: { turnId: TurnId; runId: RunId } | null = null
      const closeOpen = async (): Promise<void> => {
        if (current) {
          await this.deps.msgs.endRun(current.runId, { status: "completed" }, tx)
          await this.deps.msgs.endTurn(current.turnId, "completed", undefined, tx)
          current = null
        }
      }
      for (const m of kept) {
        if (m.role === "user") {
          await closeOpen()
          const res = await this.deps.msgs.appendTurn(
            { conversationId: newConv.id, userMessage: { blocks: m.blocks } },
            newIdemKey(),
            tx,
          )
          const run = await this.deps.msgs.startRun(
            res.turn.id,
            { agentId: asAgentId("main"), model: "default" },
            newIdemKey(),
            tx,
          )
          current = { turnId: res.turn.id, runId: run.id }
        } else if (m.role === "assistant" && current) {
          const asst = await this.deps.msgs.appendAssistantMessage(
            current.runId,
            { blocks: [] },
            newIdemKey(),
            tx,
          )
          for (const b of m.blocks) {
            await this.deps.msgs.appendBlock(asst.id, b, tx)
          }
          if (m.stats) await this.deps.msgs.setStats(asst.id, m.stats, tx)
        }
      }
      await closeOpen()
    })

    // Clone the in-memory session so the fork keeps LLM context when continued.
    forkSession(String(conv.id), String(newConv.id), keepUserTurns)

    return { conversationId: String(newConv.id) }
  }

  /** Persist one already-computed non-agentic RAG turn (see `answerNonAgentic`)
   *  as a single synchronous write, mirroring forkConversation's turn-rebuild —
   *  there's no live pi-mono run here, so no stream.publish/SSE involvement. */
  public async recordNonAgenticTurn(
    viewer: Viewer,
    conversationId: ConversationId,
    input: { userText: string; modelId: string; answerBlocks: Block[] },
  ): Promise<{ turnId: TurnId; assistantMessageId: MessageId }> {
    await this.getConversation(viewer, conversationId) // permission check

    return this.deps.uow.run(async (tx) => {
      const turnResult = await this.deps.msgs.appendTurn(
        {
          conversationId,
          userMessage: { blocks: [{ kind: "text", text: input.userText }] },
        },
        newIdemKey(),
        tx,
      )
      const run = await this.deps.msgs.startRun(
        turnResult.turn.id,
        { agentId: asAgentId("nonagentic"), model: input.modelId },
        newIdemKey(),
        tx,
      )
      const asst = await this.deps.msgs.appendAssistantMessage(
        run.id,
        { blocks: [] },
        newIdemKey(),
        tx,
      )
      for (const b of input.answerBlocks) {
        await this.deps.msgs.appendBlock(asst.id, b, tx)
      }
      await this.deps.msgs.endRun(run.id, { status: "completed" }, tx)
      await this.deps.msgs.endTurn(turnResult.turn.id, "completed", undefined, tx)

      if (turnResult.userMessage.ordinal === 1) {
        void this.renameFromFirstMessage(
          conversationId,
          input.userText,
          Logger.child({ conversationId: String(conversationId) }),
        )
      }

      return { turnId: turnResult.turn.id, assistantMessageId: asst.id }
    })
  }

  /** Background pi-mono iteration. Publishes deltas/blocks/commits + end-of-turn
   *  events to the StreamBus; clients read entirely through SSE (live +
   *  ring-buffer resume). Never rejects — any error becomes a turn_ended event
   *  with status "errored". */
  private async streamRun(args: {
    conv: Conversation
    ctrl: AbortController
    inflightKey: string
    input: {
      text: string
      model?: string
      thinkingLevel?: "minimal" | "low" | "medium" | "high"
      debug?: boolean
      debugVerbosity?: "summary" | "detailed"
      attachmentIds?: string[]
      skillAssist?: boolean
      skillContext?: SendMessageInput["skillContext"]
      /** Regenerate/edit: keep only the first N user turns before re-running. */
      branchKeepUserTurns?: number
      scopedDocs?: { docId: string; name: string }[]
    }
    viewerUserId: UserId
    viewerWorkspaceId: WorkspaceId
    runId: RunId
    assistantMessage: Message
    turn: Turn
    runLog: import("../log").Log
    agentScope?: AgentScope
  }): Promise<void> {
    const {
      conv,
      ctrl,
      inflightKey,
      input,
      viewerUserId,
      viewerWorkspaceId,
      runId,
      assistantMessage,
      turn,
      runLog,
      agentScope,
    } = args
    const text = input.text.trim()
    // Debug mode: a DebugCapture that fans every event onto the conversation's
    // SSE channel. No allocation when input.debug is false/absent.
    const debugCapture = input.debug
      ? new DebugCapture(input.debugVerbosity ?? "summary", (event) => {
          this.deps.stream
            .publish(channelFor(conv.id), {
              kind: "debug_event",
              runId,
              messageId: assistantMessage.id,
              event,
            })
            .catch(() => {})
          // Tee to disk so the DebugPanel can re-seed after a reload/redeploy.
          // Fire-and-forget by contract: appendPersistedEvent returns void and
          // swallows IO errors, so a disk failure can't break the live publish.
          appendPersistedEvent(runId, event)
        })
      : undefined

    // Each dispatched sub-agent gets a DebugCapture that tags its events with
    // the sub-agent + nested run and fans them onto the SAME parent run's stream,
    // so the panel can nest them under the dispatch.
    const makeSubAgentDebug = input.debug
      ? (nestedRunId: string, subAgentName: string): DebugCapture =>
          new DebugCapture(input.debugVerbosity ?? "summary", (event) => {
            const tagged = {
              ...event,
              subAgent: { name: subAgentName, nestedRunId },
            }
            this.deps.stream
              .publish(channelFor(conv.id), {
                kind: "debug_event",
                runId,
                messageId: assistantMessage.id,
                event: tagged,
              })
              .catch(() => {})
            appendPersistedEvent(runId, tagged)
          })
      : undefined
    try {
      const pendingToolCalls = new Map<string, ToolCallId>()
      // Diagnostic counters (logged once at first delta + once at end).
      let textDeltaCount = 0
      let thinkingDeltaCount = 0
      // Text deltas between tool boundaries, flushed as one committed block at a
      // tool call / finish — preserves document order on the wire and in MessageRepo.
      let pendingText = ""
      const flushPendingText = async (): Promise<void> => {
        const trimmed = pendingText.replace(/^\s+/, "")
        if (!trimmed) {
          pendingText = ""
          return
        }
        const block: Block = { kind: "text", text: trimmed }
        await this.deps.msgs.appendBlock(assistantMessage.id, block)
        await this.deps.stream.publish(channelFor(conv.id), {
          kind: "text_committed",
          messageId: assistantMessage.id,
          text: trimmed,
        })
        pendingText = ""
      }

      // Same buffer/flush for reasoning. Pi-mono emits thinking_start →
      // thinking_delta* → thinking_end; flushed on thinking_end (+ tool boundaries).
      let pendingThinking = ""
      const flushPendingThinking = async (): Promise<void> => {
        const trimmed = pendingThinking.trim()
        if (!trimmed) {
          pendingThinking = ""
          return
        }
        const block: Block = { kind: "thinking", text: trimmed }
        await this.deps.msgs.appendBlock(assistantMessage.id, block)
        await this.deps.stream.publish(channelFor(conv.id), {
          kind: "thinking_committed",
          messageId: assistantMessage.id,
          text: trimmed,
        })
        pendingThinking = ""
      }

      // System-prompt resolution order:
      //   1. Custom agent (agentScope set) → its overrides + sub-agents.
      //   2. No agent → workspace default agent's row, but only its
      //      prompt/tools/sub-agents; its appIntegrations are NOT applied to
      //      vespa search (search stays KB-only — we skip AgentScope here).
      //   3. No default row → omit `systemPrompt`, runner uses its baked default.
      let assembledPrompt: string | undefined
      let resolvedToolNames: string[] = []
      let resolvedSubAgents: DispatchableSubAgent[] = []
      let resolvedAgentId: string = "default-agent"
      if (input.skillAssist) {
        // In-code skill authoring agent: fixed prompt, no sub-agents, only the
        // `computer` sandbox tool. The runner adds upsertSkill from the
        // `skillAssist` arg passed to runPiMonoTurn below.
        assembledPrompt = buildSkillAgentSystemPrompt()
        resolvedToolNames = ["computer"]
        resolvedSubAgents = []
        resolvedAgentId = "skill-assistant"
      } else if (agentScope) {
        assembledPrompt = resolveAgentSystemPrompt({
          systemPromptMain: agentScope.systemPromptMain,
          systemPromptTools: agentScope.systemPromptTools,
          systemPromptSubagents: agentScope.systemPromptSubagents,
          subAgents: agentScope.subAgents,
          skills: agentScope.skills,
        })
        resolvedToolNames = agentScope.tools
        resolvedSubAgents = agentScope.subAgents
        resolvedAgentId = agentScope.externalId
      } else {
        const defaults = await loadWorkspaceDefaultPromptInputs({
          userId: viewerUserId,
          workspaceId: viewerWorkspaceId,
        })
        if (defaults) {
          assembledPrompt = resolveAgentSystemPrompt(defaults)
          resolvedToolNames = defaults.tools
          resolvedSubAgents = defaults.subAgents
          // No resolvedAgentId set: dispatch persistence below tags nested runs
          // with the parent run's agent_id (already the default agent's id).
        }
      }

      // Dispatch persistence (start/finish only): open a nested v2_chat_runs row
      // on dispatch, close it + persist the sub-agent trace on finish. The
      // dispatch tool owns the iteration; chat.ts only sees the boundaries.
      //
      // `dispatchSeq` keeps the run idem key unique for concurrent dispatches to
      // the SAME sub-agent: Date.now() alone collides within a millisecond, and
      // the idem-unique index would then dedup both into ONE nested run. Bumped
      // synchronously at the top of each start() so concurrent calls differ.
      let dispatchSeq = 0
      const dispatchPersistence: NestedRunPersistence = {
        start: async ({ subAgentExternalId, model }) => {
          const seq = dispatchSeq++
          const nested = await this.deps.msgs.startRun(
            turn.id,
            {
              parentRunId: runId,
              agentId: asAgentId(resolvedAgentId),
              subAgentId: subAgentExternalId,
              model,
            },
            `${runId}:sub:${subAgentExternalId}:${Date.now()}:${String(seq)}`,
          )
          return String(nested.id)
        },
        finish: async (nestedRunIdStr, batch) => {
          const nestedRunIdTyped = asRunId(nestedRunIdStr)
          const nestedMsg = await this.deps.msgs.appendAssistantMessage(
            nestedRunIdTyped,
            { blocks: [] },
            `${nestedRunIdStr}:msg`,
          )
          // Persist the trace as blocks in order: thinking → tool_use/tool_result
          // pairs by startedAt → final text. v2_chat_tool_calls rows fall out as a
          // side effect of the block writes (postgres MessageRepo writes both).
          if (batch.thinkingText.trim().length > 0) {
            await this.deps.msgs.appendBlock(nestedMsg.id, {
              kind: "thinking",
              text: batch.thinkingText.trim(),
            })
          }
          const sortedCalls = [...batch.toolCalls].sort(
            (a, b) => a.startedAt - b.startedAt,
          )
          for (const c of sortedCalls) {
            await this.deps.msgs.appendBlock(nestedMsg.id, {
              kind: "tool_use",
              toolCallId: asToolCallId(c.toolCallId),
              toolName: c.toolName,
              args: c.args,
            })
            await this.deps.msgs.appendBlock(nestedMsg.id, {
              kind: "tool_result",
              toolCallId: asToolCallId(c.toolCallId),
              output: c.result,
              isError: c.isError,
            })
          }
          if (batch.finalText.trim().length > 0) {
            await this.deps.msgs.appendBlock(nestedMsg.id, {
              kind: "text",
              text: batch.finalText.trim(),
            })
          }
          await this.deps.msgs.endRun(nestedRunIdTyped, {
            status: batch.status,
            tokensIn: batch.tokens.input + batch.tokens.cacheRead,
            tokensOut: batch.tokens.output,
            ...(batch.error ? { error: batch.error } : {}),
          })
        },
      }

      // Attachment context (file `/mnt/files/` paths + read-the-skill steer)
      // rides the USER MESSAGE as a <system-reminder>, NOT the system prompt:
      // ties it to its attachments and keeps per-conversation state out of the
      // stable system prompt. The runner appends it only on a turn with new
      // attachments / the first turn after compaction, and re-injects the paths
      // into the compaction summary so they survive. Gated on the `computer`
      // tool — without the sandbox there's nothing at /mnt/files/.
      const sandboxEnabled = resolvedToolNames.includes("computer")
      const uploadedFilesReminder = sandboxEnabled
        ? await buildUploadedFilesReminder(String(conv.id))
        : ""
      const uploadedFilesSummaryNote = sandboxEnabled
        ? await buildUploadedFilesSummaryNote(String(conv.id))
        : ""
      const messageHasAttachments = (input.attachmentIds?.length ?? 0) > 0

      await this.hydratePiMonoSessionIfNeeded(conv.id, turn.id, runLog)

      // Citation steer: <system-reminder> appended to the LLM message ONLY
      // (never persisted) every turn for RAG agents, reinforcing the system-prompt
      // citation rule. Gated on corpus retrieval (isRagOn, else has vespaSearch).
      const agentDoesRag =
        agentScope?.isRagOn ?? resolvedToolNames.includes("vespaSearch")
      const citationReminder = agentDoesRag ? CITATION_REMINDER : ""

      // Pre-flight: two parallel lightweight LLM passes (relevance + plan) that
      // ride the main turn's first request as a <system-reminder>. Gated to
      // non-trivial messages; best-effort (errors → "").
      let preflightReminder = ""
      if (shouldPreflight(text)) {
        try {
          const all: MessageWithBlocks[] = []
          let cursor: Cursor = { kind: "first", limit: 200 }
          for (;;) {
            const page = await this.deps.msgs.listMessages(conv.id, cursor)
            all.push(...page.items)
            if (!page.nextCursor) break
            cursor = { kind: "after", token: page.nextCursor, limit: 200 }
          }
          const history = all
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({
              role: m.role as "user" | "assistant",
              text: extractBlocksText(m.blocks),
            }))
            .filter((m) => m.text.length > 0)
          const last = history[history.length - 1]
          if (last && last.role === "user" && last.text.trim() === text.trim()) {
            history.pop()
          }
          preflightReminder = await runPreflight({
            userMessage: text,
            history,
            skills: agentScope?.skills ?? [],
            toolNames: resolvedToolNames,
            logger: runLog,
            signal: ctrl.signal,
          })
        } catch (err) {
          runLog.warn(
            { err: (err as Error)?.message },
            "preflight: skipped (history build failed)",
          )
        }
      }

      const piResult = await runPiMonoTurn({
        conversationId: String(conv.id),
        userEmail: String(viewerUserId),
        message: text,
        ...(preflightReminder ? { preflightReminder } : {}),
        ...(input.scopedDocs && input.scopedDocs.length > 0
          ? { scopedDocs: input.scopedDocs }
          : {}),
        ...(typeof input.branchKeepUserTurns === "number"
          ? { branchKeepUserTurns: input.branchKeepUserTurns }
          : {}),
        ...(uploadedFilesReminder
          ? { attachmentReminder: uploadedFilesReminder }
          : {}),
        ...(uploadedFilesSummaryNote
          ? { attachmentSummaryNote: uploadedFilesSummaryNote }
          : {}),
        ...(messageHasAttachments ? { messageHasAttachments: true } : {}),
        ...(citationReminder ? { citationReminder } : {}),
        logger: runLog,
        ...(input.model ? { modelId: input.model } : {}),
        ...(agentScope ? { agentScope } : {}),
        ...(assembledPrompt ? { systemPrompt: assembledPrompt } : {}),
        // Verbatim from the agent row's `tools` (or the workspace default's);
        // [] means the LLM has no tools.
        toolNames: resolvedToolNames,
        // Enable dispatch only with BOTH sub-agents AND persistence callbacks —
        // the runner won't dispatch without somewhere to write the nested trace.
        ...(resolvedSubAgents.length > 0
          ? {
              dispatchableSubAgents: resolvedSubAgents,
              dispatchPersistence,
            }
          : {}),
        ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
        ...(input.skillAssist
          ? {
              skillAssist: {
                context: input.skillContext ?? {
                  mode: "create" as const,
                  alias: "",
                  name: "",
                  description: "",
                  content: "",
                },
                caps: { ...SKILL_CAPS },
              },
            }
          : {}),
        ...(debugCapture ? { debug: debugCapture } : {}),
        ...(makeSubAgentDebug ? { makeSubAgentDebug } : {}),
        signal: ctrl.signal,
        onTextDelta: async (delta) => {
          if (textDeltaCount === 0) {
            runLog.info(
              { firstDeltaChars: delta.length },
              "pi-mono: first text_delta",
            )
          }
          textDeltaCount++
          pendingText += delta
          await this.deps.stream.publish(channelFor(conv.id), {
            kind: "text_delta",
            messageId: assistantMessage.id,
            delta,
          })
        },
        onThinkingDelta: async (delta) => {
          if (thinkingDeltaCount === 0) {
            runLog.info(
              { firstDeltaChars: delta.length },
              "pi-mono: first thinking_delta",
            )
          }
          thinkingDeltaCount++
          pendingThinking += delta
          await this.deps.stream.publish(channelFor(conv.id), {
            kind: "thinking_delta",
            messageId: assistantMessage.id,
            delta,
          })
        },
        onThinkingEnd: async () => {
          await flushPendingThinking()
        },
        onToolCall: async (call) => {
          runLog.info(
            { toolName: call.toolName, toolCallId: call.toolCallId },
            "pi-mono: tool_call event",
          )
          // Flush accumulated text/thinking so the tool chip renders AFTER it.
          await flushPendingThinking()
          await flushPendingText()
          const id = asToolCallId(call.toolCallId)
          pendingToolCalls.set(call.toolCallId, id)
          const block: Block = {
            kind: "tool_use",
            toolCallId: id,
            toolName: call.toolName,
            args: call.args,
          }
          await this.deps.msgs.appendBlock(assistantMessage.id, block)
          await this.deps.stream.publish(channelFor(conv.id), {
            kind: "block_appended",
            messageId: assistantMessage.id,
            block,
          })
        },
        onToolResult: async (result) => {
          const id =
            pendingToolCalls.get(result.toolCallId) ??
            asToolCallId(result.toolCallId)
          const block: Block = {
            kind: "tool_result",
            toolCallId: id,
            output: result.result,
            isError: result.isError,
          }
          await this.deps.msgs.appendBlock(assistantMessage.id, block)
          await this.deps.stream.publish(channelFor(conv.id), {
            kind: "block_appended",
            messageId: assistantMessage.id,
            block,
          })
        },
        onToolProgress: async (toolCallId, label, level) => {
          await this.deps.stream.publish(channelFor(conv.id), {
            kind: "tool_progress",
            runId,
            toolCallId,
            label,
            level,
            at: Date.now(),
          })
        },
        // Sub-agent dispatch lifecycle → `subagent_status` SSE. Sync callback
        // from the dispatch loop, so fire-and-forget — must never block dispatch.
        onSubAgentStatus: (s) => {
          void this.deps.stream
            .publish(channelFor(conv.id), {
              kind: "subagent_status",
              runId,
              toolCallId: s.parentToolCallId,
              index: s.index,
              subAgentName: s.subAgentName,
              subAgentExternalId: s.subAgentExternalId,
              status: s.status,
              ...(s.nestedRunId ? { nestedRunId: s.nestedRunId } : {}),
              ...(s.durationMs !== undefined
                ? { durationMs: s.durationMs }
                : {}),
              ...(s.error ? { error: s.error } : {}),
              at: Date.now(),
            })
            .catch(() => {})
        },
        // Live activity inside a sub-agent (its tool calls) → `subagent_activity`.
        onSubAgentActivity: (a) => {
          void this.deps.stream
            .publish(channelFor(conv.id), {
              kind: "subagent_activity",
              runId,
              toolCallId: a.parentToolCallId,
              index: a.index,
              subAgentName: a.subAgentName,
              label: a.label,
              at: Date.now(),
            })
            .catch(() => {})
        },
      })

      runLog.info(
        {
          textDeltaCount,
          thinkingDeltaCount,
          toolCalls: pendingToolCalls.size,
        },
        "pi-mono: stream summary",
      )

      // Final flush — text/thinking after the last tool call (or the whole answer).
      await flushPendingThinking()
      await flushPendingText()

      // Stats: BOTH persisted on the Message (so a refresh hydrates them via
      // listMessages) AND published (so the live view sees them at run end).
      const persistedStats = {
        tokenUsage: piResult.stats.tokenUsage,
        cacheHitRatio: piResult.stats.cacheHitRatio,
        ...(piResult.stats.contextUsage
          ? { contextUsage: piResult.stats.contextUsage }
          : {}),
        compactionRounds: piResult.stats.compactionRounds,
        retryAttempts: piResult.stats.retryAttempts,
        durationMs: piResult.stats.durationMs,
      }
      await this.deps.msgs.setStats(assistantMessage.id, persistedStats)
      await this.deps.stream.publish(channelFor(conv.id), {
        kind: "run_stats",
        runId,
        messageId: assistantMessage.id,
        ...persistedStats,
      })

      if (piResult.error) {
        const errBlock: Block = {
          kind: "error",
          code: "pi_mono_error",
          message: piResult.error,
        }
        await this.deps.msgs.appendBlock(assistantMessage.id, errBlock)
        await this.deps.stream.publish(channelFor(conv.id), {
          kind: "block_appended",
          messageId: assistantMessage.id,
          block: errBlock,
        })
      }

      const runStatus = piResult.error ? "errored" : "completed"
      await this.deps.msgs.endRun(
        runId,
        piResult.error
          ? { status: runStatus, error: piResult.error }
          : { status: runStatus },
      )
      await this.deps.stream.publish(channelFor(conv.id), {
        kind: "run_ended",
        runId,
        stats: piResult.error
          ? { status: runStatus, error: piResult.error }
          : { status: runStatus },
      })
      await this.deps.msgs.endTurn(turn.id, runStatus, piResult.error)
      await this.deps.stream.publish(channelFor(conv.id), {
        kind: "turn_ended",
        turnId: turn.id,
        status: runStatus,
        ...(piResult.error ? { error: piResult.error } : {}),
      })

      runLog.info(
        {
          status: runStatus,
          stopReason: piResult.stopReason,
          assistantTextChars: piResult.text.length,
          error: piResult.error,
        },
        "chat: turn finished",
      )

      // Follow-ups run AFTER turn_ended (so the UI drops the reasoning indicator)
      // and detached (so they don't delay the turn or hold the inflight slot);
      // chips arrive via a later block_appended SSE on the still-open EventSource.
      if (!piResult.error && piResult.text.trim().length > 0) {
        const fuKey = String(conv.id)
        const fuCtrl = new AbortController()
        // Keep the map single-valued (sendMessage should already have aborted any prior).
        this.followUpInflight.get(fuKey)?.abort()
        this.followUpInflight.set(fuKey, fuCtrl)
        void (async (): Promise<void> => {
          try {
            const followUps = await generateFollowUps({
              userQuestion: text,
              assistantAnswer: piResult.text,
              logger: runLog,
              signal: fuCtrl.signal,
            })
            // A new message during generation makes these chips stale — drop them.
            if (fuCtrl.signal.aborted) return
            if (followUps && followUps.follow_up_questions.length > 0) {
              const block: Block = {
                kind: "follow_ups",
                questions: followUps.follow_up_questions,
              }
              await this.deps.msgs.appendBlock(assistantMessage.id, block)
              await this.deps.stream.publish(channelFor(conv.id), {
                kind: "block_appended",
                messageId: assistantMessage.id,
                block,
              })
            }
          } catch (err) {
            runLog.warn({ err }, "follow-ups: unexpected failure")
          } finally {
            if (this.followUpInflight.get(fuKey) === fuCtrl) {
              this.followUpInflight.delete(fuKey)
            }
          }
        })()
      }
    } catch (err) {
      // streamRun is detached: an uncaught error would be an unhandled rejection
      // that kills the process. Surface it through the same end-of-turn SSE event.
      const message = err instanceof Error ? err.message : String(err)
      runLog.error({ err }, "streamRun: unhandled error")
      try {
        await this.deps.msgs.endRun(runId, {
          status: "errored",
          error: message,
        })
        await this.deps.msgs.endTurn(turn.id, "errored", message)
        await this.deps.stream.publish(channelFor(conv.id), {
          kind: "turn_ended",
          turnId: turn.id,
          status: "errored",
          error: message,
        })
      } catch (cleanupErr) {
        runLog.error({ err: cleanupErr }, "streamRun: cleanup also failed")
      }
    } finally {
      // Release the inflight slot; the guard avoids clobbering a slot already
      // replaced by a fresh run.
      if (this.inflight.get(inflightKey) === ctrl) {
        this.inflight.delete(inflightKey)
      }
    }
  }

  public async sendMessageAndWait(
    viewer: Viewer,
    input: SendMessageInput & { waitTimeoutMs?: number },
  ): Promise<ChatRunResult> {
    const waitTimeoutMs = Math.max(0, input.waitTimeoutMs ?? 240_000)
    const started = await this.sendMessage(viewer, input)
    const runId = started.assistantMessage.runId
    if (!runId) {
      throw new Error("Assistant message missing run id")
    }
    await this.waitForRunCompletion(runId, waitTimeoutMs)
    return this.readRunResult(viewer, input.conversationId, runId)
  }

  private async waitForRunCompletion(
    runId: RunId,
    timeoutMs: number,
  ): Promise<"completed" | "timeout"> {
    const completion = this.runCompletions.get(String(runId))
    if (!completion) {
      return "completed"
    }
    if (timeoutMs <= 0) {
      return "timeout"
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        completion.then(() => "completed" as const),
        new Promise<"timeout">((resolve) => {
          timeout = setTimeout(() => resolve("timeout"), timeoutMs)
        }),
      ])
    } finally {
      if (timeout) {
        clearTimeout(timeout)
      }
    }
  }

  public async readRunResult(
    viewer: Viewer,
    conversationId: ConversationId,
    runId: RunId,
  ): Promise<ChatRunResult> {
    const conv = await this.getConversation(viewer, conversationId)
    const run = await this.deps.msgs.getRun(runId)
    if (!run || String(run.conversationId) !== String(conv.id)) {
      throw new RunNotFoundError(runId)
    }

    const { messages } = await this.deps.msgs.dumpConversation(conv.id)
    const userMessage = messages.find(
      (message) =>
        message.role === "user" &&
        String(message.turnId) === String(run.turnId),
    )
    const assistantMessage = messages.find(
      (message) =>
        message.role === "assistant" &&
        message.runId &&
        String(message.runId) === String(run.id),
    )
    const answer = assistantMessage
      ? textFromBlocks(assistantMessage.blocks)
      : ""
    const errorBlock = assistantMessage?.blocks.find(
      (block): block is Extract<Block, { kind: "error" }> =>
        block.kind === "error",
    )

    const result: ChatRunResult = {
      status: run.status,
      conversationId: run.conversationId,
      runId: run.id,
      modelId: run.model,
      agentId: String(run.agentId),
      ...(userMessage ? { userMessageId: userMessage.id } : {}),
      ...(assistantMessage ? { assistantMessageId: assistantMessage.id } : {}),
    }
    if (run.status === "completed") {
      result.answer = answer
    }
    const error = run.error ?? errorBlock?.message
    if (error) {
      result.error = error
    }
    return result
  }

  private async hydratePiMonoSessionIfNeeded(
    conversationId: ConversationId,
    currentTurnId: Turn["id"],
    log: import("../log").Log,
  ): Promise<void> {
    if (hasPiMonoSession(String(conversationId))) {
      return
    }
    const { messages, runs } =
      await this.deps.msgs.dumpConversation(conversationId)
    const completedTopLevelRunByTurn = new Map<string, Run>()
    for (const run of runs) {
      if (
        !run.parentRunId &&
        run.status === "completed" &&
        String(run.turnId) !== String(currentTurnId)
      ) {
        const key = String(run.turnId)
        if (!completedTopLevelRunByTurn.has(key)) {
          completedTopLevelRunByTurn.set(key, run)
        }
      }
    }

    const history: Array<{
      role: "user" | "assistant"
      text: string
      timestamp?: number
    }> = []
    for (const message of [...messages].sort(
      (a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id),
    )) {
      if (String(message.turnId) === String(currentTurnId)) {
        continue
      }
      const completedRun = completedTopLevelRunByTurn.get(String(message.turnId))
      if (!completedRun) {
        continue
      }
      if (message.role === "user") {
        const text = textFromBlocks(message.blocks).trim()
        if (text) {
          history.push({
            role: "user",
            text,
            timestamp: message.createdAt,
          })
        }
        continue
      }
      if (
        message.role === "assistant" &&
        message.runId &&
        String(message.runId) === String(completedRun.id)
      ) {
        const text = textFromBlocks(message.blocks).trim()
        if (text) {
          history.push({
            role: "assistant",
            text,
            timestamp: message.createdAt,
          })
        }
      }
    }

    hydratePiMonoSession(String(conversationId), history)
    if (history.length > 0) {
      log.info(
        { hydratedMessages: history.length },
        "pi-mono: hydrated session from DB text history",
      )
    }
  }

  public async listMessages(
    viewer: Viewer,
    conversationId: ConversationId,
    page: Cursor,
  ): Promise<Page<MessageWithBlocks>> {
    await this.getConversation(viewer, conversationId)
    return this.deps.msgs.listMessages(conversationId, page)
  }

  /** Full DB-backed snapshot for the debug pane's conversation dump: every
   *  message (incl. nested-run/sub-agent messages listMessages hides), run, and
   *  tool call. Gated like getConversation. */
  public async dumpConversation(
    viewer: Viewer,
    conversationId: ConversationId,
  ): Promise<{
    conversation: Conversation
    messages: MessageWithBlocks[]
    runs: import("../storage/types").Run[]
    toolCalls: import("../storage/types").ToolCall[]
  }> {
    const conv = await this.getConversation(viewer, conversationId)
    const { messages, runs, toolCalls } =
      await this.deps.msgs.dumpConversation(conversationId)
    return { conversation: conv, messages, runs, toolCalls }
  }

  /** Persisted debug events for a run, so the DebugPanel can re-seed after a
   *  reload/redeploy. Binds the (attacker-controlled) runId to the caller's own
   *  conversation before reading — mirroring readRunResult — so a viewer can't
   *  read another conversation's run. Returns [] when debug was never on. */
  public async readDebugEvents(
    viewer: Viewer,
    conversationId: ConversationId,
    runId: RunId,
  ): Promise<DebugEvent[]> {
    const conv = await this.getConversation(viewer, conversationId)
    const run = await this.deps.msgs.getRun(runId)
    if (!run || String(run.conversationId) !== String(conv.id)) {
      throw new RunNotFoundError(runId)
    }
    return readPersistedEvents(runId)
  }

  /** Full trace of every sub-agent dispatched under a parent run, in `startedAt`
   *  order with each sub-agent's messages + blocks. The UI matches the Nth
   *  `dispatchSubagent` tool_call to the Nth nested run. Gated via getConversation. */
  public async listNestedRuns(
    viewer: Viewer,
    conversationId: ConversationId,
    parentRunId: RunId,
  ): Promise<{
    nestedRuns: Array<{
      run: import("../storage/types").Run
      messages: MessageWithBlocks[]
    }>
  }> {
    await this.getConversation(viewer, conversationId)
    const runs = await this.deps.msgs.listChildRuns(
      conversationId,
      parentRunId,
    )
    const nested = await Promise.all(
      runs.map(async (run) => {
        const messages = await this.deps.msgs.listMessagesByRun(run.id)
        return { run, messages }
      }),
    )
    return { nestedRuns: nested }
  }

  // ─── Message feedback ──────────────────────────────────────────────────
  // Wrappers around MessageFeedbackRepo (which does no auth): the service
  // enforces conversation ownership + message membership, and snapshots
  // model/latency/tokens/retrievedSourceIds at write time so a later
  // regenerate / model swap doesn't change what the user rated.
  public async setMessageFeedback(
    viewer: Viewer,
    conversationId: ConversationId,
    messageId: MessageId,
    input: {
      rating: MessageFeedbackRating
      tags?: string[]
      comment?: string
      shareChat?: boolean
    },
  ): Promise<MessageFeedback> {
    await this.getConversation(viewer, conversationId)
    const msg = await this.deps.msgs.getMessage(messageId)
    if (!msg || msg.conversationId !== conversationId) {
      // Collapse "not found" + "wrong conversation" into one 404 — don't leak
      // the existence of foreign messages.
      throw new MessageNotFoundError(messageId)
    }
    if (msg.role !== "assistant") {
      throw new ForbiddenError("Only assistant messages can be rated")
    }

    // Snapshot the model from the run that produced this message.
    let modelSnapshot: string | undefined
    if (msg.runId) {
      const runs = await this.deps.msgs.listRunsForTurn(msg.turnId)
      const run = runs.find((r) => r.id === msg.runId)
      if (run) modelSnapshot = run.model
    }

    const retrievedSourceIds = collectCitationDocIds(msg.blocks)
    const stats = msg.stats

    return this.deps.feedback.upsert(
      {
        messageId,
        conversationId,
        userId: viewer.userId,
        workspaceId: viewer.workspaceId,
        ...(msg.runId ? { runId: msg.runId } : {}),
      },
      {
        rating: input.rating,
        ...(input.tags ? { tags: input.tags } : {}),
        ...(input.comment ? { comment: input.comment } : {}),
        ...(input.shareChat !== undefined ? { shareChat: input.shareChat } : {}),
        ...(modelSnapshot ? { modelSnapshot } : {}),
        ...(stats?.durationMs !== undefined
          ? { latencyMs: stats.durationMs }
          : {}),
        ...(stats?.tokenUsage.input !== undefined
          ? { tokensIn: stats.tokenUsage.input }
          : {}),
        ...(stats?.tokenUsage.output !== undefined
          ? { tokensOut: stats.tokenUsage.output }
          : {}),
        ...(retrievedSourceIds.length > 0 ? { retrievedSourceIds } : {}),
      },
    )
  }

  public async getMessageFeedback(
    viewer: Viewer,
    conversationId: ConversationId,
    messageId: MessageId,
  ): Promise<MessageFeedback | null> {
    await this.getConversation(viewer, conversationId)
    return this.deps.feedback.get({ messageId, userId: viewer.userId })
  }

  public async deleteMessageFeedback(
    viewer: Viewer,
    conversationId: ConversationId,
    messageId: MessageId,
  ): Promise<boolean> {
    await this.getConversation(viewer, conversationId)
    return this.deps.feedback.delete({ messageId, userId: viewer.userId })
  }

  public async subscribe(
    viewer: Viewer,
    conversationId: ConversationId,
    onEvent: (e: import("../storage/types").StreamEvent, seq: number) => void,
    opts?: { sinceSeq?: number },
  ): Promise<() => void> {
    await this.getConversation(viewer, conversationId) // permission check
    return this.deps.stream.subscribe(channelFor(conversationId), onEvent, opts)
  }

  private async renameFromFirstMessage(
    conversationId: ConversationId,
    text: string,
    parentLog: import("../log").Log,
  ): Promise<void> {
    const log = parentLog.child({ task: "rename" })
    const startedAt = Date.now()
    log.info("rename: title generation start")
    try {
      const title = await generateTitle(text, log)
      if (!title) {
        log.info(
          { durationMs: Date.now() - startedAt },
          "rename: empty title — skipping",
        )
        return
      }
      await this.deps.convs.patch(conversationId, { title })
      await this.deps.stream.publish(channelFor(conversationId), {
        kind: "conversation_renamed",
        conversationId,
        title,
      })
      log.info(
        { title, durationMs: Date.now() - startedAt },
        "rename: applied + broadcast",
      )
    } catch (err) {
      log.warn(
        { err, durationMs: Date.now() - startedAt },
        "rename failed; keeping placeholder",
      )
    }
  }
}

export const channelFor = (conversationId: ConversationId): string =>
  `conv:${String(conversationId)}`

// DocIds the model actually cited; empty when nothing was cited — downstream
// feedback distinguishes "no retrieval" from "retrieval failed" by this presence.
const collectCitationDocIds = (blocks: Block[]): string[] => {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const b of blocks) {
    if (b.kind === "citation" && !seen.has(b.docId)) {
      seen.add(b.docId)
      ids.push(b.docId)
    }
  }
  return ids
}

export const textFromBlocks = (blocks: Block[]): string =>
  blocks
    .filter((block): block is Extract<Block, { kind: "text" }> =>
      block.kind === "text",
    )
    .map((block) => block.text)
    .join("")

const newIdemKey = (): string =>
  crypto.randomUUID().split("-").slice(0, 2).join("") ||
  Math.random().toString(36).slice(2)
