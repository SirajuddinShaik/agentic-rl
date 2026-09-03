/* eslint-disable @typescript-eslint/require-await --
 * Async by interface contract (so Postgres/Redis impls swap in); the in-memory
 * bodies don't need to await.
 */
// In-memory storage impls for dev/tests. Same interface as the Postgres/Redis/S3
// impls. Single-process only — state lives in closures, dies with the process.

import {
  type AppendTurnInput,
  type AppendTurnResult,
  type BlobMeta,
  type BlobRef,
  type Block,
  type Conversation,
  type ConversationId,
  type ConversationInit,
  type ConversationPatch,
  type ConversationRepo,
  type Cursor,
  type IdemKey,
  type Message,
  type MessageFeedback,
  type MessageFeedbackInput,
  type MessageFeedbackRepo,
  type MessageId,
  type MessageRepo,
  type MessageWithBlocks,
  type NewAssistantMessage,
  type Page,
  type Run,
  type RunId,
  type RunInit,
  type RunStats,
  type StoredBlob,
  type StreamBus,
  type StreamEvent,
  type ToolCall,
  type ToolCallId,
  type Turn,
  type TurnId,
  type TurnStatus,
  type Tx,
  type Unsubscribe,
  type UnitOfWork,
  type UserId,
  type WorkspaceId,
  asBlobRef,
  asConversationId,
  asMessageFeedbackId,
  asMessageId,
  asRunId,
  asTurnId,
} from "./types"

const newId = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().split("-")[0] ?? Math.random().toString(36).slice(2)}`

const now = (): number => Date.now()

const paginate = <T>(
  items: T[],
  page: Cursor,
  cursorOf: (item: T) => string,
): Page<T> => {
  const start =
    page.kind === "after"
      ? Math.max(items.findIndex((i) => cursorOf(i) === page.token) + 1, 0)
      : 0
  const limit = Math.max(1, Math.min(page.limit, 200))
  const slice = items.slice(start, start + limit)
  const last = slice[slice.length - 1]
  const nextCursor = slice.length === limit && last ? cursorOf(last) : undefined
  return nextCursor ? { items: slice, nextCursor } : { items: slice }
}

// ─── InMemoryUnitOfWork ──────────────────────────────────────────────────────
const NOOP_TX: Tx = { _tx: true }

export class InMemoryUnitOfWork implements UnitOfWork {
  public async run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return fn(NOOP_TX)
  }
}

// ─── InMemoryConversationRepo ────────────────────────────────────────────────
export class InMemoryConversationRepo implements ConversationRepo {
  private readonly byId = new Map<ConversationId, Conversation>()
  // Per-owner index, newest first.
  private readonly byOwner = new Map<UserId, ConversationId[]>()
  private readonly idemIndex = new Map<IdemKey, ConversationId>()

  public async create(
    init: ConversationInit,
    idemKey: IdemKey,
  ): Promise<Conversation> {
    const existing = this.idemIndex.get(idemKey)
    if (existing) {
      const conv = this.byId.get(existing)
      if (conv) {
        return conv
      }
    }
    const id = asConversationId(newId("conv"))
    const ts = now()
    const conv: Conversation = {
      id,
      ownerId: init.ownerId,
      workspaceId: init.workspaceId,
      title: init.title,
      ...(init.agentId ? { agentId: init.agentId } : {}),
      createdAt: ts,
      updatedAt: ts,
      originKind: init.originKind ?? "chat",
      starred: false,
    }
    this.byId.set(id, conv)
    this.idemIndex.set(idemKey, id)
    const list = this.byOwner.get(init.ownerId) ?? []
    list.unshift(id)
    this.byOwner.set(init.ownerId, list)
    return conv
  }

  public async get(id: ConversationId): Promise<Conversation | null> {
    return this.byId.get(id) ?? null
  }

  public async listByOwner(
    ownerId: UserId,
    page: Cursor,
  ): Promise<Page<Conversation>> {
    const ids = this.byOwner.get(ownerId) ?? []
    const items = ids
      .map((id) => this.byId.get(id))
      .filter((c): c is Conversation => !!c && !c.archivedAt)
    return paginate(items, page, (c) => c.id)
  }

  public async patch(
    id: ConversationId,
    patch: ConversationPatch,
  ): Promise<void> {
    const conv = this.byId.get(id)
    if (!conv) {
      return
    }
    const next: Conversation = {
      ...conv,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(typeof patch.starred === "boolean" ? { starred: patch.starred } : {}),
      updatedAt: now(),
    }
    if (patch.archivedAt === null) {
      delete next.archivedAt
    } else if (typeof patch.archivedAt === "number") {
      next.archivedAt = patch.archivedAt
    }
    this.byId.set(id, next)
  }

  public async softDelete(id: ConversationId): Promise<void> {
    await this.patch(id, { archivedAt: now() })
  }
}

// ─── InMemoryMessageRepo ─────────────────────────────────────────────────────
type StoredMessage = MessageWithBlocks

export class InMemoryMessageRepo implements MessageRepo {
  private readonly turnsById = new Map<TurnId, Turn>()
  private readonly runsById = new Map<RunId, Run>()
  private readonly msgIdsByConv = new Map<ConversationId, MessageId[]>()
  private readonly msgsById = new Map<MessageId, StoredMessage>()
  private readonly runIdsByTurn = new Map<TurnId, RunId[]>()
  private readonly runIdsByConv = new Map<ConversationId, RunId[]>()
  private readonly nextOrdinal = new Map<ConversationId, number>()

  private readonly turnIdemIndex = new Map<IdemKey, TurnId>()
  private readonly runIdemIndex = new Map<IdemKey, RunId>()
  private readonly msgIdemIndex = new Map<IdemKey, MessageId>()

  private readonly toolCallsById = new Map<ToolCallId, ToolCall>()
  private readonly toolCallIdsByConv = new Map<ConversationId, ToolCallId[]>()

  private nextOrd(conversationId: ConversationId): number {
    const v = (this.nextOrdinal.get(conversationId) ?? 0) + 1
    this.nextOrdinal.set(conversationId, v)
    return v
  }

  public async appendTurn(
    input: AppendTurnInput,
    idemKey: IdemKey,
  ): Promise<AppendTurnResult> {
    const existingTurnId = this.turnIdemIndex.get(idemKey)
    if (existingTurnId) {
      const turn = this.turnsById.get(existingTurnId)
      const ids = this.msgIdsByConv.get(input.conversationId) ?? []
      const userMsgId = ids.find((id) => {
        const m = this.msgsById.get(id)
        return m?.turnId === existingTurnId && m.role === "user"
      })
      const userMsg = userMsgId ? this.msgsById.get(userMsgId) : undefined
      if (turn && userMsg) {
        return { turn, userMessage: stripBlocks(userMsg) }
      }
    }

    const turnId = asTurnId(newId("turn"))
    const turn: Turn = {
      id: turnId,
      conversationId: input.conversationId,
      status: "running",
      startedAt: now(),
    }
    this.turnsById.set(turnId, turn)
    this.turnIdemIndex.set(idemKey, turnId)

    const msgId = asMessageId(newId("msg"))
    const msg: StoredMessage = {
      id: msgId,
      conversationId: input.conversationId,
      turnId,
      role: "user",
      ordinal: this.nextOrd(input.conversationId),
      ...(input.userMessage.parentMessageId
        ? { parentMessageId: input.userMessage.parentMessageId }
        : {}),
      createdAt: now(),
      blocks: [...input.userMessage.blocks],
    }
    this.msgsById.set(msgId, msg)
    const list = this.msgIdsByConv.get(input.conversationId) ?? []
    list.push(msgId)
    this.msgIdsByConv.set(input.conversationId, list)

    return { turn, userMessage: stripBlocks(msg) }
  }

  public async startRun(
    turnId: TurnId,
    init: RunInit,
    idemKey: IdemKey,
  ): Promise<Run> {
    const existing = this.runIdemIndex.get(idemKey)
    if (existing) {
      const run = this.runsById.get(existing)
      if (run) {
        return run
      }
    }
    const turn = this.turnsById.get(turnId)
    if (!turn) {
      throw new Error(`Turn not found: ${turnId}`)
    }
    const id = asRunId(newId("run"))
    const run: Run = {
      id,
      conversationId: turn.conversationId,
      turnId,
      ...(init.parentRunId ? { parentRunId: init.parentRunId } : {}),
      ...(init.subAgentId ? { subAgentId: init.subAgentId } : {}),
      agentId: init.agentId,
      model: init.model,
      status: "running",
      startedAt: now(),
    }
    this.runsById.set(id, run)
    this.runIdemIndex.set(idemKey, id)
    const byTurn = this.runIdsByTurn.get(turnId) ?? []
    byTurn.push(id)
    this.runIdsByTurn.set(turnId, byTurn)
    const byConv = this.runIdsByConv.get(turn.conversationId) ?? []
    byConv.push(id)
    this.runIdsByConv.set(turn.conversationId, byConv)
    return run
  }

  public async endRun(runId: RunId, stats: RunStats): Promise<void> {
    const run = this.runsById.get(runId)
    if (!run) {
      return
    }
    const next: Run = {
      ...run,
      status: stats.status,
      endedAt: now(),
      ...(stats.tokensIn !== undefined ? { tokensIn: stats.tokensIn } : {}),
      ...(stats.tokensOut !== undefined ? { tokensOut: stats.tokensOut } : {}),
      ...(stats.costUsd !== undefined ? { costUsd: stats.costUsd } : {}),
      ...(stats.error ? { error: stats.error } : {}),
    }
    this.runsById.set(runId, next)
  }

  public async appendAssistantMessage(
    runId: RunId,
    input: NewAssistantMessage,
    idemKey: IdemKey,
  ): Promise<Message> {
    const existing = this.msgIdemIndex.get(idemKey)
    if (existing) {
      const m = this.msgsById.get(existing)
      if (m) {
        return stripBlocks(m)
      }
    }
    const run = this.runsById.get(runId)
    if (!run) {
      throw new Error(`Run not found: ${runId}`)
    }
    const turn = this.turnsById.get(run.turnId)
    if (!turn) {
      throw new Error(`Turn not found for run: ${run.turnId}`)
    }
    const id = asMessageId(newId("msg"))
    const msg: StoredMessage = {
      id,
      conversationId: turn.conversationId,
      turnId: turn.id,
      runId,
      role: "assistant",
      ordinal: this.nextOrd(turn.conversationId),
      ...(input.parentMessageId
        ? { parentMessageId: input.parentMessageId }
        : {}),
      createdAt: now(),
      blocks: [],
    }
    this.msgsById.set(id, msg)
    this.msgIdemIndex.set(idemKey, id)
    const list = this.msgIdsByConv.get(turn.conversationId) ?? []
    list.push(id)
    this.msgIdsByConv.set(turn.conversationId, list)
    // Append blocks via `appendBlock` so tool-call projection runs.
    for (const b of input.blocks) {
      await this.appendBlock(id, b)
    }
    return stripBlocks(msg)
  }

  public async appendBlock(messageId: MessageId, block: Block): Promise<void> {
    const msg = this.msgsById.get(messageId)
    if (!msg) {
      throw new Error(`Message not found: ${messageId}`)
    }
    msg.blocks.push(block)
    this.projectToolCallBlock(msg, block)
  }

  public async setStats(
    messageId: MessageId,
    stats: import("./types").MessageStats,
  ): Promise<void> {
    const msg = this.msgsById.get(messageId)
    if (!msg) {
      throw new Error(`Message not found: ${messageId}`)
    }
    msg.stats = stats
  }

  private projectToolCallBlock(msg: StoredMessage, block: Block): void {
    if (block.kind === "tool_use") {
      const run = msg.runId ? this.runsById.get(msg.runId) : null
      if (!run) {
        return
      }
      const entry: ToolCall = {
        id: block.toolCallId,
        conversationId: msg.conversationId,
        turnId: msg.turnId,
        runId: run.id,
        agentId: run.agentId,
        messageId: msg.id,
        toolName: block.toolName,
        args: block.args,
        isError: false,
        status: "pending",
        startedAt: now(),
      }
      this.toolCallsById.set(block.toolCallId, entry)
      const list = this.toolCallIdsByConv.get(msg.conversationId) ?? []
      list.push(block.toolCallId)
      this.toolCallIdsByConv.set(msg.conversationId, list)
      return
    }
    if (block.kind === "tool_result") {
      const entry = this.toolCallsById.get(block.toolCallId)
      if (!entry) {
        // Orphan result — record what we can.
        const run = msg.runId ? this.runsById.get(msg.runId) : null
        if (!run) {
          return
        }
        const orphan: ToolCall = {
          id: block.toolCallId,
          conversationId: msg.conversationId,
          turnId: msg.turnId,
          runId: run.id,
          agentId: run.agentId,
          messageId: msg.id,
          toolName: "(unknown)",
          args: undefined,
          result: block.output,
          isError: block.isError,
          status: block.isError ? "error" : "completed",
          startedAt: now(),
          completedAt: now(),
        }
        this.toolCallsById.set(block.toolCallId, orphan)
        const list = this.toolCallIdsByConv.get(msg.conversationId) ?? []
        list.push(block.toolCallId)
        this.toolCallIdsByConv.set(msg.conversationId, list)
        return
      }
      const updated: ToolCall = {
        ...entry,
        result: block.output,
        isError: block.isError,
        status: block.isError ? "error" : "completed",
        completedAt: now(),
      }
      this.toolCallsById.set(block.toolCallId, updated)
    }
  }

  public async endTurn(
    turnId: TurnId,
    status: TurnStatus,
    error: string | undefined,
  ): Promise<void> {
    const turn = this.turnsById.get(turnId)
    if (!turn) {
      return
    }
    const next: Turn = {
      ...turn,
      status,
      endedAt: now(),
      ...(error ? { error } : {}),
    }
    this.turnsById.set(turnId, next)
  }

  public async deleteTurnAssistantOutput(turnId: TurnId): Promise<void> {
    const turn = this.turnsById.get(turnId)
    if (!turn) {
      return
    }
    // Remove non-user messages (assistant + nested) and their tool-call
    // projections; keep the user message and the turn row.
    const convId = turn.conversationId
    const msgIds = this.msgIdsByConv.get(convId) ?? []
    const keptMsgIds: MessageId[] = []
    const removedMsgIds = new Set<MessageId>()
    for (const id of msgIds) {
      const m = this.msgsById.get(id)
      if (m && m.turnId === turnId && m.role !== "user") {
        this.msgsById.delete(id)
        removedMsgIds.add(id)
      } else {
        keptMsgIds.push(id)
      }
    }
    this.msgIdsByConv.set(convId, keptMsgIds)

    const removedRunIds = new Set<RunId>()
    for (const [runId, run] of this.runsById) {
      if (run.turnId === turnId) {
        this.runsById.delete(runId)
        removedRunIds.add(runId)
      }
    }
    this.runIdsByTurn.delete(turnId)
    const convRunIds = this.runIdsByConv.get(convId) ?? []
    this.runIdsByConv.set(
      convId,
      convRunIds.filter((id) => !removedRunIds.has(id)),
    )

    const convToolCallIds = this.toolCallIdsByConv.get(convId) ?? []
    const keptToolCallIds: ToolCallId[] = []
    for (const id of convToolCallIds) {
      const tc = this.toolCallsById.get(id)
      if (
        tc &&
        ((tc.messageId && removedMsgIds.has(tc.messageId)) ||
          (tc.runId && removedRunIds.has(tc.runId)))
      ) {
        this.toolCallsById.delete(id)
      } else {
        keptToolCallIds.push(id)
      }
    }
    this.toolCallIdsByConv.set(convId, keptToolCallIds)
  }

  public async deleteTurnsFrom(
    conversationId: ConversationId,
    fromOrdinal: number,
  ): Promise<void> {
    const msgIds = this.msgIdsByConv.get(conversationId) ?? []
    // Turn ids that own a message at/after the cut ordinal.
    const turnIdsToDelete = new Set<TurnId>()
    for (const id of msgIds) {
      const m = this.msgsById.get(id)
      if (m && m.ordinal >= fromOrdinal) turnIdsToDelete.add(m.turnId)
    }
    this.removeTurns(conversationId, turnIdsToDelete)
  }

  public async deleteTurnsAfter(
    conversationId: ConversationId,
    turnId: TurnId,
  ): Promise<void> {
    const ref = this.turnsById.get(turnId)
    if (!ref) return
    const turnIdsToDelete = new Set<TurnId>()
    for (const [id, t] of this.turnsById) {
      if (t.conversationId === conversationId && t.startedAt > ref.startedAt) {
        turnIdsToDelete.add(id)
      }
    }
    this.removeTurns(conversationId, turnIdsToDelete)
  }

  /** Shared teardown: remove the given turns' messages, runs, and tool calls
   *  from the in-memory indexes (used by deleteTurnsFrom / deleteTurnsAfter). */
  private removeTurns(
    conversationId: ConversationId,
    turnIdsToDelete: Set<TurnId>,
  ): void {
    if (turnIdsToDelete.size === 0) return
    const msgIds = this.msgIdsByConv.get(conversationId) ?? []
    const removedMsgIds = new Set<MessageId>()
    const keptMsgIds: MessageId[] = []
    for (const id of msgIds) {
      const m = this.msgsById.get(id)
      if (m && turnIdsToDelete.has(m.turnId)) {
        this.msgsById.delete(id)
        removedMsgIds.add(id)
      } else {
        keptMsgIds.push(id)
      }
    }
    this.msgIdsByConv.set(conversationId, keptMsgIds)

    const removedRunIds = new Set<RunId>()
    for (const [runId, run] of this.runsById) {
      if (turnIdsToDelete.has(run.turnId)) {
        this.runsById.delete(runId)
        removedRunIds.add(runId)
      }
    }
    for (const turnId of turnIdsToDelete) {
      this.turnsById.delete(turnId)
      this.runIdsByTurn.delete(turnId)
    }
    const convRunIds = this.runIdsByConv.get(conversationId) ?? []
    this.runIdsByConv.set(
      conversationId,
      convRunIds.filter((id) => !removedRunIds.has(id)),
    )

    const convToolCallIds = this.toolCallIdsByConv.get(conversationId) ?? []
    const keptToolCallIds: ToolCallId[] = []
    for (const id of convToolCallIds) {
      const tc = this.toolCallsById.get(id)
      if (
        tc &&
        ((tc.messageId && removedMsgIds.has(tc.messageId)) ||
          (tc.runId && removedRunIds.has(tc.runId)))
      ) {
        this.toolCallsById.delete(id)
      } else {
        keptToolCallIds.push(id)
      }
    }
    this.toolCallIdsByConv.set(conversationId, keptToolCallIds)
  }

  public async listMessages(
    conversationId: ConversationId,
    page: Cursor,
  ): Promise<Page<MessageWithBlocks>> {
    const ids = this.msgIdsByConv.get(conversationId) ?? []
    const items = ids
      .map((id) => this.msgsById.get(id))
      .filter((m): m is StoredMessage => !!m)
    return paginate(items, page, (m) => m.id)
  }

  public async getMessage(id: MessageId): Promise<MessageWithBlocks | null> {
    return this.msgsById.get(id) ?? null
  }

  public async getRun(id: RunId): Promise<Run | null> {
    return this.runsById.get(id) ?? null
  }

  public async listRunsForTurn(turnId: TurnId): Promise<Run[]> {
    const ids = this.runIdsByTurn.get(turnId) ?? []
    return ids.map((id) => this.runsById.get(id)).filter((r): r is Run => !!r)
  }

  public async listChildRuns(
    conversationId: ConversationId,
    parentRunId: RunId,
  ): Promise<Run[]> {
    const ids = this.runIdsByConv.get(conversationId) ?? []
    return ids
      .map((id) => this.runsById.get(id))
      .filter((r): r is Run => !!r && r.parentRunId === parentRunId)
      .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
  }

  public async listMessagesByRun(
    runId: RunId,
  ): Promise<MessageWithBlocks[]> {
    // StoredMessage carries blocks inline, so just filter and sort.
    return [...this.msgsById.values()]
      .filter((m) => m.runId === runId)
      .sort((a, b) => a.ordinal - b.ordinal)
  }

  public async listRunsForConversation(
    conversationId: ConversationId,
    page: Cursor,
  ): Promise<Page<Run>> {
    const ids = this.runIdsByConv.get(conversationId) ?? []
    const items = ids
      .map((id) => this.runsById.get(id))
      .filter((r): r is Run => !!r)
    return paginate(items, page, (r) => r.id)
  }

  public async getToolCall(id: ToolCallId): Promise<ToolCall | null> {
    return this.toolCallsById.get(id) ?? null
  }

  public async listToolCalls(
    filter: {
      conversationId?: ConversationId
      turnId?: TurnId
      runId?: RunId
      toolName?: string
    },
    page: Cursor,
  ): Promise<Page<ToolCall>> {
    const base = filter.conversationId
      ? (this.toolCallIdsByConv.get(filter.conversationId) ?? [])
          .map((id) => this.toolCallsById.get(id))
          .filter((t): t is ToolCall => !!t)
      : Array.from(this.toolCallsById.values())

    const items = base.filter(
      (t) =>
        (!filter.turnId || t.turnId === filter.turnId) &&
        (!filter.runId || t.runId === filter.runId) &&
        (!filter.toolName || t.toolName === filter.toolName),
    )

    return paginate(items, page, (t) => t.id)
  }

  public async dumpConversation(
    conversationId: ConversationId,
  ): Promise<{
    messages: MessageWithBlocks[]
    runs: Run[]
    toolCalls: ToolCall[]
  }> {
    const messages = [...this.msgsById.values()]
      .filter((m) => m.conversationId === conversationId)
      .sort(
        (a, b) =>
          a.ordinal - b.ordinal || a.id.localeCompare(b.id),
      )
    const runIds = this.runIdsByConv.get(conversationId) ?? []
    const runs = runIds
      .map((id) => this.runsById.get(id))
      .filter((r): r is Run => !!r)
      .sort(
        (a, b) =>
          a.startedAt - b.startedAt || a.id.localeCompare(b.id),
      )
    const toolCallIds = this.toolCallIdsByConv.get(conversationId) ?? []
    const toolCalls = toolCallIds
      .map((id) => this.toolCallsById.get(id))
      .filter((t): t is ToolCall => !!t)
      .sort(
        (a, b) =>
          a.startedAt - b.startedAt || a.id.localeCompare(b.id),
      )
    return { messages, runs, toolCalls }
  }
}

const stripBlocks = (m: MessageWithBlocks): Message => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { blocks, ...rest } = m
  return rest
}

// ─── InMemoryStreamBus ───────────────────────────────────────────────────────
type BufferedEvent = { seq: number; event: StreamEvent }
type SeqListener = (e: StreamEvent, seq: number) => void

/** In-memory StreamBus: per-channel ring buffer + monotonic seq#.
 *
 *  - Each publish gets a new per-channel seq. Last MAX_BUFFERED events stay in
 *    the ring so a new subscriber can replay-from-cursor via `sinceSeq` (the
 *    SSE route derives that from EventSource's Last-Event-ID on reconnect).
 *  - Eviction: a `text_committed` / `thinking_committed` drops prior `*_delta`
 *    for the same messageId — the committed block already carries that content
 *    via MessageRepo, so replaying deltas would duplicate it.
 *  - `turn_ended` clears the whole buffer — that turn is fully captured in
 *    MessageRepo + stats. */
export class InMemoryStreamBus implements StreamBus {
  private readonly listeners = new Map<string, Set<SeqListener>>()
  private readonly buffers = new Map<string, BufferedEvent[]>()
  private readonly nextSeq = new Map<string, number>()
  private readonly MAX_BUFFERED = 256

  public async publish(channelId: string, event: StreamEvent): Promise<number> {
    const seq = (this.nextSeq.get(channelId) ?? 0) + 1
    this.nextSeq.set(channelId, seq)

    let buf = this.buffers.get(channelId) ?? []
    if (event.kind === "text_committed") {
      const mid = event.messageId
      buf = buf.filter(
        (b) => !(b.event.kind === "text_delta" && b.event.messageId === mid),
      )
    } else if (event.kind === "thinking_committed") {
      const mid = event.messageId
      buf = buf.filter(
        (b) =>
          !(b.event.kind === "thinking_delta" && b.event.messageId === mid),
      )
    } else if (event.kind === "turn_ended") {
      // Turn is durably in MessageRepo now; reset the buffer so reconnecting
      // subscribers don't replay a completed run. Critically, do NOT buffer the
      // turn_ended marker either: a fresh subscriber would replay it and run
      // end-of-turn cleanup (status→idle, drop streamingMessageId) for the
      // wrong turn. Live subscribers get it via the fan-out below before clear.
      buf = []
      const live = this.listeners.get(channelId)
      if (live) {
        for (const fn of live) {
          try {
            fn(event, seq)
          } catch {
            // Isolate listeners.
          }
        }
      }
      this.buffers.set(channelId, buf)
      return seq
    }
    buf.push({ seq, event })
    if (buf.length > this.MAX_BUFFERED) {
      buf = buf.slice(buf.length - this.MAX_BUFFERED)
    }
    this.buffers.set(channelId, buf)

    const set = this.listeners.get(channelId)
    if (set) {
      for (const fn of set) {
        try {
          fn(event, seq)
        } catch {
          // Isolate listeners: one bad listener must not kill the others.
        }
      }
    }
    return seq
  }

  public subscribe(
    channelId: string,
    onEvent: SeqListener,
    opts?: { sinceSeq?: number },
  ): Unsubscribe {
    // Replay from cursor BEFORE attaching, so buffered events arrive in order
    // with no live event sneaking in between.
    const since = opts?.sinceSeq ?? 0
    const buf = this.buffers.get(channelId)
    if (buf && since >= 0) {
      for (const b of buf) {
        if (b.seq > since) {
          try {
            onEvent(b.event, b.seq)
          } catch {
            // Isolate listeners.
          }
        }
      }
    }

    const set = this.listeners.get(channelId) ?? new Set<SeqListener>()
    set.add(onEvent)
    this.listeners.set(channelId, set)
    return () => {
      set.delete(onEvent)
      if (set.size === 0) {
        this.listeners.delete(channelId)
      }
    }
  }
}

// ─── InMemoryMessageFeedbackRepo ─────────────────────────────────────────────
export class InMemoryMessageFeedbackRepo implements MessageFeedbackRepo {
  private readonly byKey = new Map<string, MessageFeedback>()

  private key(messageId: MessageId, userId: UserId): string {
    return `${String(userId)}:${String(messageId)}`
  }

  public async upsert(
    keys: {
      messageId: MessageId
      conversationId: ConversationId
      userId: UserId
      workspaceId: WorkspaceId
      runId?: RunId
    },
    input: MessageFeedbackInput,
  ): Promise<MessageFeedback> {
    const k = this.key(keys.messageId, keys.userId)
    const existing = this.byKey.get(k)
    const ts = now()
    const next: MessageFeedback = {
      id: existing?.id ?? asMessageFeedbackId(newId("mfb")),
      messageId: keys.messageId,
      conversationId: keys.conversationId,
      ...(keys.runId ? { runId: keys.runId } : {}),
      userId: keys.userId,
      workspaceId: keys.workspaceId,
      rating: input.rating,
      tags: input.tags ?? [],
      ...(input.comment ? { comment: input.comment } : {}),
      shareChat: input.shareChat ?? false,
      ...(input.modelSnapshot ? { modelSnapshot: input.modelSnapshot } : {}),
      ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
      ...(input.tokensIn !== undefined ? { tokensIn: input.tokensIn } : {}),
      ...(input.tokensOut !== undefined ? { tokensOut: input.tokensOut } : {}),
      ...(input.retrievedSourceIds
        ? { retrievedSourceIds: input.retrievedSourceIds }
        : {}),
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    }
    this.byKey.set(k, next)
    return next
  }

  public async get(keys: {
    messageId: MessageId
    userId: UserId
  }): Promise<MessageFeedback | null> {
    return this.byKey.get(this.key(keys.messageId, keys.userId)) ?? null
  }

  public async delete(keys: {
    messageId: MessageId
    userId: UserId
  }): Promise<boolean> {
    return this.byKey.delete(this.key(keys.messageId, keys.userId))
  }
}

// ─── InMemoryBlobStore ───────────────────────────────────────────────────────
export class InMemoryBlobStore {
  private readonly blobs = new Map<BlobRef, StoredBlob>()

  public async put(content: Uint8Array, meta: BlobMeta): Promise<BlobRef> {
    const ref = asBlobRef(newId("blob"))
    this.blobs.set(ref, {
      ref,
      content,
      meta: { ...meta, byteSize: content.byteLength },
    })
    return ref
  }

  public async get(ref: BlobRef): Promise<StoredBlob | null> {
    return this.blobs.get(ref) ?? null
  }

  public async delete(ref: BlobRef): Promise<void> {
    this.blobs.delete(ref)
  }
}
