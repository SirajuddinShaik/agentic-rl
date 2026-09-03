// Storage types for the agent layer.
//
// Repos carry no auth — services enforce permissions before calling. Writes
// spanning multiple repos must run inside a UnitOfWork transaction.

// ─── Branded ids ─────────────────────────────────────────────────────────────
type Brand<T, K extends string> = T & { readonly _brand: K }

export type WorkspaceId = Brand<string, "WorkspaceId">
export type UserId = Brand<string, "UserId">
export type AgentId = Brand<string, "AgentId">
export type ConversationId = Brand<string, "ConversationId">
export type TurnId = Brand<string, "TurnId">
export type RunId = Brand<string, "RunId">
export type MessageId = Brand<string, "MessageId">
export type ToolCallId = Brand<string, "ToolCallId">
export type MessageFeedbackId = Brand<string, "MessageFeedbackId">
export type BlobRef = Brand<string, "BlobRef">

export const asWorkspaceId = (v: string): WorkspaceId => v as WorkspaceId
export const asUserId = (v: string): UserId => v as UserId
export const asAgentId = (v: string): AgentId => v as AgentId
export const asConversationId = (v: string): ConversationId =>
  v as ConversationId
export const asTurnId = (v: string): TurnId => v as TurnId
export const asRunId = (v: string): RunId => v as RunId
export const asMessageId = (v: string): MessageId => v as MessageId
export const asToolCallId = (v: string): ToolCallId => v as ToolCallId
export const asMessageFeedbackId = (v: string): MessageFeedbackId =>
  v as MessageFeedbackId
export const asBlobRef = (v: string): BlobRef => v as BlobRef

// ─── Content blocks (discriminated union) ────────────────────────────────────
export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool_use"
      toolCallId: ToolCallId
      toolName: string
      args: unknown
    }
  | {
      kind: "tool_result"
      toolCallId: ToolCallId
      output: unknown
      isError: boolean
      blobRef?: BlobRef
    }
  | { kind: "image"; blobRef: BlobRef; mime: string; alt?: string }
  | {
      kind: "citation"
      index: number
      docId: string
      url?: string
      title?: string
    }
  | { kind: "handoff"; targetAgentId: AgentId; reason: string }
  | { kind: "error"; code: string; message: string }
  | { kind: "follow_ups"; questions: string[] }

export type BlockKind = Block["kind"]

// `extract` is the programmatic extractor endpoint — same tables as `chat`,
// filtered out of the chat sidebar.
export type ConversationOrigin = "chat" | "extract" | "ephemeral"

// ─── Entities ────────────────────────────────────────────────────────────────
export type Conversation = {
  id: ConversationId
  ownerId: UserId
  workspaceId: WorkspaceId
  title: string
  agentId?: AgentId
  createdAt: number
  updatedAt: number
  archivedAt?: number
  originKind: ConversationOrigin
  starred: boolean
}

export type ConversationInit = {
  ownerId: UserId
  workspaceId: WorkspaceId
  title: string
  agentId?: AgentId
  originKind?: ConversationOrigin
}

export type ConversationPatch = {
  title?: string
  archivedAt?: number | null
  starred?: boolean
}

export type TurnStatus = "running" | "completed" | "errored" | "aborted"

export type Turn = {
  id: TurnId
  conversationId: ConversationId
  status: TurnStatus
  startedAt: number
  endedAt?: number
  error?: string
}

export type RunStatus = TurnStatus

export type Run = {
  id: RunId
  conversationId: ConversationId // denormalized for fast filtering / analytics
  turnId: TurnId
  parentRunId?: RunId
  /** Sub-agent's `external_id` as plain text (no FK); set on nested runs. */
  subAgentId?: string
  /** Resolved sub-agent slug, populated by listChildRuns so a reloaded page
   *  (no live SSE) can match a dispatch lane to its nested run by name. */
  subAgentName?: string
  agentId: AgentId
  model: string
  status: RunStatus
  startedAt: number
  endedAt?: number
  tokensIn?: number
  tokensOut?: number
  costUsd?: number
  error?: string
}

export type RunInit = {
  parentRunId?: RunId
  agentId: AgentId
  model: string
  /** Sub-agent's external_id as plain text (no FK); omitted on parent runs. */
  subAgentId?: string
}

export type RunStats = {
  status: RunStatus
  tokensIn?: number
  tokensOut?: number
  costUsd?: number
  error?: string
}

export type MessageRole = "user" | "assistant" | "system"

/** Per-turn telemetry persisted on the assistant Message so a refresh's
 *  GET /messages restores it — the run_stats SSE event fires only once. */
export type MessageStats = {
  tokenUsage: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
  cacheHitRatio: number
  contextUsage?: {
    tokens?: number
    contextWindow?: number
    percent?: number
  }
  compactionRounds: number
  retryAttempts: number
  durationMs: number
}

export type Message = {
  id: MessageId
  conversationId: ConversationId
  turnId: TurnId
  runId?: RunId // assistant/system messages belong to a Run; user messages don't
  role: MessageRole
  ordinal: number
  parentMessageId?: MessageId
  createdAt: number
  stats?: MessageStats
}

export type MessageWithBlocks = Message & { blocks: Block[] }

// ─── Pagination / transaction ────────────────────────────────────────────────
export type Cursor =
  | { kind: "first"; limit: number }
  | { kind: "after"; token: string; limit: number }

export type Page<T> = {
  items: T[]
  nextCursor?: string
}

// Opaque transaction handle — InMemory uses a no-op, Postgres a real tx.
export type Tx = { readonly _tx: true }

export interface UnitOfWork {
  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
}

// ─── Inputs for atomic writes ────────────────────────────────────────────────
export type NewUserMessage = {
  blocks: Block[]
  parentMessageId?: MessageId
}

export type AppendTurnInput = {
  conversationId: ConversationId
  userMessage: NewUserMessage
}

export type AppendTurnResult = {
  turn: Turn
  userMessage: Message
}

export type NewAssistantMessage = {
  blocks: Block[]
  parentMessageId?: MessageId
}

// ─── Stream bus events ───────────────────────────────────────────────────────
export type StreamEvent =
  | { kind: "turn_started"; turnId: TurnId; conversationId: ConversationId }
  | {
      kind: "run_started"
      runId: RunId
      turnId: TurnId
      parentRunId?: RunId
      agentId: AgentId
    }
  | { kind: "run_ended"; runId: RunId; stats: RunStats }
  | { kind: "message_appended"; messageId: MessageId; role: MessageRole }
  | { kind: "block_appended"; messageId: MessageId; block: Block }
  // Live streaming delta — not a committed block.
  | { kind: "text_delta"; messageId: MessageId; delta: string }
  // Final commit at a boundary; frontend drains its delta buffer into a block.
  | { kind: "text_committed"; messageId: MessageId; text: string }
  // Thinking on a separate channel so the UI renders it apart from the answer.
  | { kind: "thinking_delta"; messageId: MessageId; delta: string }
  | { kind: "thinking_committed"; messageId: MessageId; text: string }
  // Emitted once when the pi-mono run wraps.
  | {
      kind: "run_stats"
      runId: RunId
      messageId: MessageId
      tokenUsage: {
        input: number
        output: number
        cacheRead: number
        cacheWrite: number
      }
      cacheHitRatio: number
      contextUsage?: {
        tokens?: number
        contextWindow?: number
        percent?: number
      }
      compactionRounds: number
      retryAttempts: number
      durationMs: number
    }
  | {
      kind: "turn_ended"
      turnId: TurnId
      status: TurnStatus
      error?: string
    }
  | {
      kind: "conversation_renamed"
      conversationId: ConversationId
      title: string
    }
  // Only emitted when the caller opted into debug mode on POST /messages.
  // `event` is kept `unknown` to avoid pulling the debug module into the
  // storage type graph — actual shape is DebugEvent from
  // server/backendv2/agent/pi-mono/debug/types.ts.
  | {
      kind: "debug_event"
      runId: RunId
      messageId: MessageId
      event: unknown
    }
  // Progress lines for a tool call's hidden lifecycle (e.g. sandbox boot
  // before exec). UI attaches them to the tool_use block by toolCallId.
  | {
      kind: "tool_progress"
      runId: RunId
      toolCallId: string
      label: string
      level: "info" | "ok" | "error"
      at: number
    }
  // Per-sub-agent dispatch lifecycle — lets the UI flip each lane independently
  // while the parent's combined tool_result still waits for all of them.
  // Attached to the dispatch tool_use block by toolCallId; nestedRunId fetches
  // that sub-agent's trace.
  | {
      kind: "subagent_status"
      runId: RunId
      toolCallId: string
      index: number
      subAgentName: string
      subAgentExternalId: string
      status: "started" | "completed" | "errored"
      nestedRunId?: string
      durationMs?: number
      error?: string
      at: number
    }
  // A dispatched sub-agent's own tool calls forwarded live, so the UI shows
  // what each lane is doing in real time (not just the trace on expand).
  | {
      kind: "subagent_activity"
      runId: RunId
      toolCallId: string
      index: number
      subAgentName: string
      label: string
      at: number
    }

export type Unsubscribe = () => void

export type BlobMeta = {
  mime: string
  filename?: string
  ownerUserId?: UserId
  byteSize?: number
}

export type StoredBlob = {
  ref: BlobRef
  content: Uint8Array
  meta: BlobMeta
}

// ─── ToolCall projection ─────────────────────────────────────────────────────
// Sideways index of every tool invocation, populated as tool_use/tool_result
// blocks are appended, so analytics queries don't have to parse JSONB.
export type ToolCallStatus = "pending" | "completed" | "error"

export type ToolCall = {
  id: ToolCallId
  conversationId: ConversationId
  turnId: TurnId
  runId: RunId
  agentId: AgentId
  messageId: MessageId // message containing the `tool_use` block
  toolName: string
  args: unknown
  result?: unknown
  isError: boolean
  status: ToolCallStatus
  startedAt: number
  completedAt?: number
}

// Per-write key services generate to satisfy unique indexes on the chat tables.
export type IdemKey = string

// ─── The 4 strategy interfaces ───────────────────────────────────────────────
export interface ConversationRepo {
  create(
    init: ConversationInit,
    idemKey: IdemKey,
    tx?: Tx,
  ): Promise<Conversation>
  get(id: ConversationId, tx?: Tx): Promise<Conversation | null>
  listByOwner(
    ownerId: UserId,
    page: Cursor,
    tx?: Tx,
    /** Filters by origin; sidebar passes "chat" to hide extract-origin convs. */
    originKind?: ConversationOrigin,
  ): Promise<Page<Conversation>>
  patch(id: ConversationId, patch: ConversationPatch, tx?: Tx): Promise<void>
  softDelete(id: ConversationId, tx?: Tx): Promise<void>
}

export interface MessageRepo {
  // Atomic: create a Turn + insert the user Message + its blocks
  appendTurn(
    input: AppendTurnInput,
    idemKey: IdemKey,
    tx?: Tx,
  ): Promise<AppendTurnResult>

  // Agent execution within a turn (can nest via parentRunId for sub-agents)
  startRun(
    turnId: TurnId,
    init: RunInit,
    idemKey: IdemKey,
    tx?: Tx,
  ): Promise<Run>
  endRun(runId: RunId, stats: RunStats, tx?: Tx): Promise<void>

  // Assistant/system messages produced during a run
  appendAssistantMessage(
    runId: RunId,
    message: NewAssistantMessage,
    idemKey: IdemKey,
    tx?: Tx,
  ): Promise<Message>

  // tool_use/tool_result blocks are projected into the `toolCalls` index.
  appendBlock(messageId: MessageId, block: Block, tx?: Tx): Promise<void>

  // So a refresh's listMessages() can rehydrate the stats footer.
  setStats(messageId: MessageId, stats: MessageStats, tx?: Tx): Promise<void>

  endTurn(
    turnId: TurnId,
    status: TurnStatus,
    error: string | undefined,
    tx?: Tx,
  ): Promise<void>

  // Drops a turn's assistant messages and runs (parent + nested) but keeps the
  // turn row and its user message, so regenerate can re-run the same turn.
  deleteTurnAssistantOutput(turnId: TurnId, tx?: Tx): Promise<void>

  // Truncates the conversation: deletes every turn owning a message with
  // `ordinal >= fromOrdinal`. Drops turn rows so messages/runs/tool_calls
  // cascade away. Used by editUserMessageAndResend.
  deleteTurnsFrom(
    conversationId: ConversationId,
    fromOrdinal: number,
    tx?: Tx,
  ): Promise<void>

  // Deletes every turn started strictly after `turnId` (by started_at). Paired
  // with deleteTurnAssistantOutput(turnId) so regenerate drops the answer + all
  // later turns while keeping that turn's user message.
  deleteTurnsAfter(
    conversationId: ConversationId,
    turnId: TurnId,
    tx?: Tx,
  ): Promise<void>

  // Reads — messages / runs
  listMessages(
    conversationId: ConversationId,
    page: Cursor,
    tx?: Tx,
  ): Promise<Page<MessageWithBlocks>>
  getMessage(id: MessageId, tx?: Tx): Promise<MessageWithBlocks | null>
  getRun(id: RunId, tx?: Tx): Promise<Run | null>
  listRunsForTurn(turnId: TurnId, tx?: Tx): Promise<Run[]>
  listRunsForConversation(
    conversationId: ConversationId,
    page: Cursor,
    tx?: Tx,
  ): Promise<Page<Run>>

  // Nested-run replay surface.
  // listChildRuns: runs with `parent_run_id = parentRunId`, started_at ASC
  // (the order the parent dispatched sub-agents).
  // listMessagesByRun: messages with `run_id = runId`, ordinal ASC. Unlike
  // listMessages, does NOT filter out nested sub-agent messages.
  listChildRuns(
    conversationId: ConversationId,
    parentRunId: RunId,
    tx?: Tx,
  ): Promise<Run[]>
  listMessagesByRun(
    runId: RunId,
    tx?: Tx,
  ): Promise<MessageWithBlocks[]>

  // Reads — tool call projection (analytics surface)
  getToolCall(id: ToolCallId, tx?: Tx): Promise<ToolCall | null>
  listToolCalls(
    filter: {
      conversationId?: ConversationId
      turnId?: TurnId
      runId?: RunId
      toolName?: string
    },
    page: Cursor,
    tx?: Tx,
  ): Promise<Page<ToolCall>>

  // Full conversation snapshot — every message/run/toolCall (incl. nested),
  // regardless of nested-run filtering. Backs /v2/chat/conversations/:id/dump.
  dumpConversation(
    conversationId: ConversationId,
    tx?: Tx,
  ): Promise<{
    messages: MessageWithBlocks[]
    runs: Run[]
    toolCalls: ToolCall[]
  }>
}

// ─── Message feedback ────────────────────────────────────────────────────────
// Mirrors v1's shared enum so cross-version analytics can union the two tables.
export type MessageFeedbackRating = "like" | "dislike"

export type MessageFeedback = {
  id: MessageFeedbackId
  messageId: MessageId
  conversationId: ConversationId
  runId?: RunId
  userId: UserId
  workspaceId: WorkspaceId
  rating: MessageFeedbackRating
  tags: string[]
  comment?: string
  shareChat: boolean
  modelSnapshot?: string
  latencyMs?: number
  tokensIn?: number
  tokensOut?: number
  retrievedSourceIds?: string[]
  createdAt: number
  updatedAt: number
}

export type MessageFeedbackInput = {
  rating: MessageFeedbackRating
  tags?: string[]
  comment?: string
  shareChat?: boolean
  modelSnapshot?: string
  latencyMs?: number
  tokensIn?: number
  tokensOut?: number
  retrievedSourceIds?: string[]
}

export interface MessageFeedbackRepo {
  upsert(
    keys: {
      messageId: MessageId
      conversationId: ConversationId
      userId: UserId
      workspaceId: WorkspaceId
      runId?: RunId
    },
    input: MessageFeedbackInput,
    tx?: Tx,
  ): Promise<MessageFeedback>

  get(
    keys: { messageId: MessageId; userId: UserId },
    tx?: Tx,
  ): Promise<MessageFeedback | null>

  delete(
    keys: { messageId: MessageId; userId: UserId },
    tx?: Tx,
  ): Promise<boolean>
}

export interface StreamBus {
  /** Returns the per-channel monotonic seq# for this event; the SSE handler
   *  writes it as `id:` so the browser replays it as `Last-Event-ID` on
   *  reconnect, enabling exact resume. */
  publish(channelId: string, event: StreamEvent): Promise<number>
  /** @param sinceSeq replays buffered events with seq > sinceSeq to the new
   *  subscriber BEFORE attaching it for future events (avoids a gap). */
  subscribe(
    channelId: string,
    onEvent: (e: StreamEvent, seq: number) => void,
    opts?: { sinceSeq?: number },
  ): Unsubscribe
}

export interface BlobStore {
  put(content: Uint8Array, meta: BlobMeta): Promise<BlobRef>
  get(ref: BlobRef): Promise<StoredBlob | null>
  delete(ref: BlobRef): Promise<void>
}
