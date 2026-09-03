import { Hono, type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { streamSSE } from "hono/streaming"
import { z } from "zod"

import {
  apiKeyAuthMiddleware,
  assertApiKeyAgentAllowed,
  type ApiKeyAuthContext,
} from "../services/apiKeyAuth"
import {
  ModelNotAllowedError,
  getCanonicalModelCatalog,
  resolveCanonicalModel,
} from "../services/models"
import { chatService } from "../agent/chatServiceSingleton"
import { loadAgentScope } from "../agent/agent-scope"
import {
  answerNonAgentic,
  streamNonAgenticAnswer,
} from "../agent/services/nonAgenticAsk"
import {
  AgentNotAccessibleError,
  ConcurrentRunError,
  ConversationNotFoundError,
  ForbiddenError,
  InvalidPathError,
  RunNotFoundError,
  textFromBlocks,
  viewerFromPayload,
  type ChatRunResult,
} from "../agent/services/chat"
import {
  asConversationId,
  asRunId,
  type Block,
  type StreamEvent,
} from "../agent/storage/types"

type Vars = {
  apiKeyAuth: ApiKeyAuthContext
}

const router = new Hono<{ Variables: Vars }>()

const DEFAULT_WAIT_TIMEOUT_MS = 600_000
const MAX_WAIT_TIMEOUT_MS = 600_000

router.use("*", apiKeyAuthMiddleware)

const waitTimeoutMs = (): number => {
  const configured = Number(process.env["API_AGENT_CHAT_WAIT_TIMEOUT_MS"])
  if (!Number.isFinite(configured) || configured < 0) {
    return DEFAULT_WAIT_TIMEOUT_MS
  }
  return Math.min(configured, MAX_WAIT_TIMEOUT_MS)
}

const viewer = (auth: ApiKeyAuthContext): ReturnType<typeof viewerFromPayload> =>
  viewerFromPayload({
    sub: auth.email,
    workspaceId: auth.workspaceExternalId,
  })

const handle = async (
  c: Context<{ Variables: Vars }>,
  fn: () => Promise<Response | object>,
): Promise<Response> => {
  try {
    const result = await fn()
    return result instanceof Response ? result : c.json(result)
  } catch (err) {
    if (err instanceof ModelNotAllowedError) {
      return c.json(
        {
          error: {
            code: "MODEL_NOT_ALLOWED",
            message: err.message,
          },
        },
        400,
      )
    }
    if (err instanceof ConversationNotFoundError) {
      throw new HTTPException(404, { message: err.message })
    }
    if (err instanceof RunNotFoundError) {
      throw new HTTPException(404, { message: err.message })
    }
    if (err instanceof z.ZodError) {
      return c.json(
        { message: "Invalid input", errors: err.flatten().fieldErrors },
        400,
      )
    }
    if (err instanceof ForbiddenError || err instanceof AgentNotAccessibleError) {
      throw new HTTPException(403, { message: err.message })
    }
    if (err instanceof InvalidPathError) {
      throw new HTTPException(400, { message: err.message })
    }
    if (err instanceof ConcurrentRunError) {
      throw new HTTPException(409, { message: err.message })
    }
    if (err instanceof HTTPException) {
      throw err
    }
    const message = err instanceof Error ? err.message : "Internal error"
    throw new HTTPException(500, { message })
  }
}

const parseThinkingLevel = (
  value: unknown,
): "minimal" | "low" | "medium" | "high" | undefined => {
  const allowed = ["minimal", "low", "medium", "high"] as const
  return allowed.includes(value as (typeof allowed)[number])
    ? (value as (typeof allowed)[number])
    : undefined
}

const stripInlineCitationMarkers = (text: string): string =>
  text
    .replace(/\[\d+\]/g, "")
    .replace(/K\[\d+_\d+\]/g, "")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")

const toPublicRunResult = (
  result: ChatRunResult,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    status: result.status,
    conversationId: result.conversationId,
    runId: result.runId,
    modelId: result.modelId,
  }
  if (result.userMessageId) out["userMessageId"] = result.userMessageId
  if (result.assistantMessageId) {
    out["assistantMessageId"] = result.assistantMessageId
  }
  if (result.status === "completed") {
    out["answer"] = result.answer ?? ""
  }
  if (result.error) {
    out["error"] = result.error
  }
  return out
}

type AgentChatRequest = {
  agentId: string
  message: string
  modelId: string
  conversationId?: string
  thinkingLevel?: "minimal" | "low" | "medium" | "high"
  // Optional KB path (e.g. "Collection/folder/file") scoping this turn's
  // retrieval to a single collection/folder/file. Resolved and authorized
  // against the AGENT's grant (not the caller's ownership) in the chat
  // service — see services/chat.ts. `agentId` is always present here.
  path?: string
}

const parseAgentChatRequest = async (
  c: Context<{ Variables: Vars }>,
): Promise<AgentChatRequest> => {
  const body = (await c.req.json().catch(() => null)) as
    | Record<string, unknown>
    | null
  if (!body || typeof body !== "object") {
    throw new HTTPException(400, { message: "JSON body required" })
  }

  const agentId =
    typeof body["agentId"] === "string" ? body["agentId"].trim() : ""
  const message =
    typeof body["message"] === "string" ? body["message"].trim() : ""
  if (!agentId) {
    throw new HTTPException(400, { message: "agentId required" })
  }
  if (!message) {
    throw new HTTPException(400, { message: "message required" })
  }

  const resolvedModel = await resolveCanonicalModel(
    typeof body["modelId"] === "string" ? body["modelId"] : undefined,
  )

  const thinkingLevel = parseThinkingLevel(body["thinkingLevel"])
  if (body["thinkingLevel"] !== undefined && !thinkingLevel) {
    throw new HTTPException(400, {
      message: "thinkingLevel must be one of minimal, low, medium, high",
    })
  }

  const requestedConversationId =
    typeof body["conversationId"] === "string"
      ? body["conversationId"].trim()
      : ""

  const path = typeof body["path"] === "string" ? body["path"].trim() : ""

  return {
    agentId,
    message,
    modelId: resolvedModel.id,
    ...(requestedConversationId
      ? { conversationId: requestedConversationId }
      : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(path ? { path } : {}),
  }
}

const eventBelongsToRun = (
  event: StreamEvent,
  ids: {
    conversationId: string
    turnId: string
    runId: string
    userMessageId: string
    assistantMessageId: string
  },
): boolean => {
  switch (event.kind) {
    case "turn_started":
      return String(event.turnId) === ids.turnId
    case "run_started":
      return (
        String(event.runId) === ids.runId ||
        String(event.parentRunId ?? "") === ids.runId
      )
    case "run_ended":
      return String(event.runId) === ids.runId
    case "message_appended":
      return (
        String(event.messageId) === ids.userMessageId ||
        String(event.messageId) === ids.assistantMessageId
      )
    case "block_appended":
    case "text_delta":
    case "text_committed":
    case "thinking_delta":
    case "thinking_committed":
      return String(event.messageId) === ids.assistantMessageId
    case "run_stats":
    case "debug_event":
      return String(event.runId) === ids.runId
    case "tool_progress":
    case "subagent_status":
    case "subagent_activity":
      return String(event.runId) === ids.runId
    case "turn_ended":
      return String(event.turnId) === ids.turnId
    case "conversation_renamed":
      return String(event.conversationId) === ids.conversationId
  }
}

const assertAgentAccessible = async (
  auth: ApiKeyAuthContext,
  agentId: string,
): Promise<void> => {
  assertApiKeyAgentAllowed(auth, agentId)
  const scope = await loadAgentScope(viewer(auth), agentId)
  if (!scope) {
    throw new AgentNotAccessibleError(agentId)
  }
}

const isAgentAccessible = async (
  auth: ApiKeyAuthContext,
  agentId: string,
): Promise<boolean> => {
  const allowedAgents = auth.config.agents
  if (
    allowedAgents &&
    allowedAgents.length > 0 &&
    !allowedAgents.includes(agentId)
  ) {
    return false
  }
  const scope = await loadAgentScope(viewer(auth), agentId)
  return Boolean(scope)
}

router.get("/models", (c) =>
  handle(c, async () => {
    const models = await getCanonicalModelCatalog()
    return { models }
  }),
)

type ChatRequest = {
  message: string
  path?: string
  modelId?: string
  reasoning: boolean
  stream: boolean
  conversationId?: string
  agentId?: string
}

type NonAgenticChatContext = {
  v: ReturnType<typeof viewer>
  conversation: Awaited<ReturnType<typeof chatService.getConversation>>
  history: { role: string; content: Array<{ text: string }> }[]
  isNewConversation: boolean
}

const parseChatRequest = async (
  c: Context<{ Variables: Vars }>,
): Promise<ChatRequest> => {
  const body = (await c.req.json().catch(() => null)) as
    | Record<string, unknown>
    | null
  if (!body || typeof body !== "object") {
    throw new HTTPException(400, { message: "JSON body required" })
  }
  const message =
    typeof body["message"] === "string" ? body["message"].trim() : ""
  if (!message) {
    throw new HTTPException(400, { message: "message required" })
  }
  const path =
    typeof body["path"] === "string" && body["path"].trim()
      ? body["path"].trim()
      : undefined
  const modelId =
    typeof body["modelId"] === "string" && body["modelId"].trim()
      ? body["modelId"].trim()
      : undefined
  const conversationId =
    typeof body["conversationId"] === "string" && body["conversationId"].trim()
      ? body["conversationId"].trim()
      : undefined
  const agentId =
    typeof body["agentId"] === "string" && body["agentId"].trim()
      ? body["agentId"].trim()
      : undefined
  return {
    message,
    ...(path ? { path } : {}),
    ...(modelId ? { modelId } : {}),
    reasoning: body["reasoning"] === true,
    stream: body["stream"] === true,
    ...(conversationId ? { conversationId } : {}),
    ...(agentId ? { agentId } : {}),
  }
}

type NonAgenticAgentContext = {
  prompt?: string
}

const resolveNonAgenticAgentContext = async (
  auth: ApiKeyAuthContext,
  agentId: string | undefined,
): Promise<NonAgenticAgentContext> => {
  if (!agentId) {
    return {}
  }

  assertApiKeyAgentAllowed(auth, agentId)
  const scope = await loadAgentScope(viewer(auth), agentId)
  if (!scope) {
    throw new AgentNotAccessibleError(agentId)
  }

  const prompt = scope.systemPromptMain ?? scope.prompt
  const agentPrompt =
    typeof prompt === "string" && prompt.trim().length > 0
      ? prompt.trim()
      : undefined

  return {
    ...(agentPrompt ? { prompt: agentPrompt } : {}),
  }
}

const loadNonAgenticChatContext = async (
  auth: ApiKeyAuthContext,
  req: ChatRequest,
): Promise<NonAgenticChatContext> => {
  const v = viewer(auth)
  const isNewConversation = !req.conversationId
  const conversation = req.conversationId
    ? await chatService.getConversation(v, asConversationId(req.conversationId))
    : await chatService.createConversation(v, "New chat")

  if (conversation.agentId) {
    throw new HTTPException(409, {
      message: "Conversation belongs to an agent, not usable with /chat",
    })
  }

  let history: { role: string; content: Array<{ text: string }> }[] = []
  if (req.conversationId) {
    const { messages } = await chatService.dumpConversation(v, conversation.id)
    history = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id))
      .flatMap((m) => {
        const text = textFromBlocks(m.blocks).trim()
        return text ? [{ role: m.role, content: [{ text }] }] : []
      })
  }

  return { v, conversation, history, isNewConversation }
}

const nonAgenticAnswerParams = (
  auth: ApiKeyAuthContext,
  req: ChatRequest,
  history: { role: string; content: Array<{ text: string }> }[],
  agentContext: NonAgenticAgentContext = {},
  signal?: AbortSignal,
): Parameters<typeof answerNonAgentic>[0] => ({
  email: auth.email,
  workspaceExternalId: auth.workspaceExternalId,
  message: req.message,
  reasoning: req.reasoning,
  ...(req.path ? { path: req.path } : {}),
  ...(req.modelId ? { modelId: req.modelId } : {}),
  ...(agentContext.prompt ? { agentPrompt: agentContext.prompt } : {}),
  ...(history.length > 0 ? { messages: history } : {}),
  ...(signal ? { signal } : {}),
})

const answerBlocksFromNonAgenticResult = (
  result: Awaited<ReturnType<typeof answerNonAgentic>>,
): Block[] => [
  { kind: "text", text: result.answer },
  ...result.citations.map((cit, i) => ({
    kind: "citation" as const,
    index: i,
    docId: cit.docId,
    ...(cit.url ? { url: cit.url } : {}),
    ...(cit.title ? { title: cit.title } : {}),
  })),
]

const chatErrorResponse = (
  c: Context<{ Variables: Vars }>,
  err: unknown,
): Response => {
  if (err instanceof z.ZodError) {
    return c.json(
      { message: "Invalid input", errors: err.flatten().fieldErrors },
      400,
    )
  }
  if (err instanceof HTTPException) {
    throw err
  }
  throw err
}

// Non-agentic, single-shot RAG answer scoped to a KB `path`.
// Same api-key auth as /agents/chat, but no agent — runs the exact v1
// non-agentic RAG flow (answerNonAgentic) so demo gets identical behavior.
// `conversationId` is optional session continuity: pass none to start a new
// conversation (returned in the response), or pass one back to continue it —
// prior turns get fed into the RAG context as history.
router.post("/chat", async (c) => {
  let req: ChatRequest
  try {
    req = await parseChatRequest(c)
  } catch (err) {
    return chatErrorResponse(c, err)
  }

  const auth = c.get("apiKeyAuth")
  if (req.stream) {
    return streamSSE(c, async (stream) => {
      let ctrl: AbortController | undefined
      let conversationIdForCleanup: ReturnType<typeof asConversationId> | undefined
      try {
        const { v, conversation, history, isNewConversation } =
          await loadNonAgenticChatContext(auth, req)
        const agentContext = await resolveNonAgenticAgentContext(auth, req.agentId)

        // Registers into the same single-flight/interrupt slot the agentic flow
        // uses (ChatService.inflight), so POST .../chat/:id/interrupt can cancel
        // this run mid-stream exactly like it cancels an agentic run.
        // TODO(interrupt-race): the controller is only registered here, AFTER
        // loadNonAgenticChatContext + resolveNonAgenticAgentContext have awaited.
        // An interrupt arriving during that load window finds no inflight entry
        // and is silently lost (the run then streams to completion). For an
        // existing conversation (req.conversationId present) we could register
        // before loading, or record a pending-interrupt marker that
        // beginNonAgenticRun honours, to close the window. Low severity: a new
        // conversation's id isn't known to the client until the stream starts,
        // and the generation itself stays single-flight-guarded regardless.
        ctrl = chatService.beginNonAgenticRun(conversation.id)
        conversationIdForCleanup = conversation.id

        if (isNewConversation) {
          await stream.writeSSE({ event: "ct", data: "" })
        }
        await stream.writeSSE({
          event: "rm",
          data: JSON.stringify({ chatId: String(conversation.id) }),
        })
        await stream.writeSSE({ event: "s", data: "" })

        let finalResult: Awaited<ReturnType<typeof answerNonAgentic>> | undefined
        const contextChunks: NonNullable<
          Awaited<ReturnType<typeof answerNonAgentic>>
        >["citations"] = []
        const streamCitationMap: Record<number, number> = {}
        let displayBuffer = ""
        const flushDisplayBuffer = async (force = false): Promise<void> => {
          if (!displayBuffer) {
            return
          }
          const holdBackChars = force ? 0 : 64
          if (!force && displayBuffer.length <= holdBackChars) {
            return
          }

          const emitLength = force
            ? displayBuffer.length
            : displayBuffer.length - holdBackChars
          const candidate = displayBuffer.slice(0, emitLength)
          displayBuffer = force ? "" : displayBuffer.slice(emitLength)
          const cleaned = stripInlineCitationMarkers(candidate)
          if (cleaned) {
            await stream.writeSSE({
              event: "u",
              data: cleaned,
            })
          }
        }
        for await (const event of streamNonAgenticAnswer(
          nonAgenticAnswerParams(auth, req, history, agentContext, ctrl.signal),
        )) {
          if (event.kind === "delta") {
            displayBuffer += event.text
            await flushDisplayBuffer()
          } else if (event.kind === "citation") {
            contextChunks.push(event.item)
            streamCitationMap[event.index] = contextChunks.length - 1
            await stream.writeSSE({
              event: "cu",
              data: JSON.stringify({
                contextChunks,
                citationMap: streamCitationMap,
              }),
            })
          } else if (event.kind === "done") {
            finalResult = event.result
          }
        }
        await flushDisplayBuffer(true)

        if (!finalResult) {
          throw new Error("Non-agentic stream ended without a final result")
        }

        const recorded = await chatService.recordNonAgenticTurn(v, conversation.id, {
          userText: req.message,
          modelId: finalResult.modelId,
          answerBlocks: answerBlocksFromNonAgenticResult(finalResult),
        })

        await stream.writeSSE({
          event: "rm",
          data: JSON.stringify({
            chatId: String(conversation.id),
            messageId: String(recorded.assistantMessageId),
          }),
        })
        await stream.writeSSE({ event: "e", data: "" })
      } catch (err) {
        if (ctrl?.signal.aborted) {
          await stream.writeSSE({ event: "interrupted", data: "" })
        } else {
          await stream.writeSSE({
            event: "er",
            data: err instanceof Error ? err.message : String(err),
          })
        }
      } finally {
        if (ctrl && conversationIdForCleanup) {
          chatService.endNonAgenticRun(conversationIdForCleanup, ctrl)
        }
      }
    })
  }

  let ctrl: AbortController | undefined
  let conversationIdForCleanup: ReturnType<typeof asConversationId> | undefined
  try {
    const auth = c.get("apiKeyAuth")
    const { v, conversation, history } = await loadNonAgenticChatContext(auth, req)
    const agentContext = await resolveNonAgenticAgentContext(auth, req.agentId)

    // Same single-flight slot as the streaming branch — no interrupt endpoint
    // makes sense against a synchronous request, but this keeps a concurrent
    // stream+non-stream call on the same conversation mutually exclusive.
    ctrl = chatService.beginNonAgenticRun(conversation.id)
    conversationIdForCleanup = conversation.id

    const result = await answerNonAgentic(
      nonAgenticAnswerParams(auth, req, history, agentContext, ctrl.signal),
    )
    await chatService.recordNonAgenticTurn(v, conversation.id, {
      userText: req.message,
      modelId: result.modelId,
      answerBlocks: answerBlocksFromNonAgenticResult(result),
    })

    return c.json({ ...result, conversationId: String(conversation.id) })
  } catch (err) {
    return chatErrorResponse(c, err)
  } finally {
    if (ctrl && conversationIdForCleanup) {
      chatService.endNonAgenticRun(conversationIdForCleanup, ctrl)
    }
  }
})

// Best-effort cancel of an in-flight non-agentic run — same
// ChatService.inflight slot / interrupt() call the session-JWT route uses
// (POST /v2/chat/conversations/:id/interrupt), just fed the api-key viewer.
router.post("/chat/:conversationId/interrupt", (c) =>
  handle(c, async () =>
    chatService.interrupt(
      viewer(c.get("apiKeyAuth")),
      asConversationId(c.req.param("conversationId")),
    ),
  ),
)

router.post("/agents/chat", (c) =>
  handle(c, async () => {
    const auth = c.get("apiKeyAuth")
    const req = await parseAgentChatRequest(c)

    await assertAgentAccessible(auth, req.agentId)

    const v = viewer(auth)

    const conversation = req.conversationId
      ? await chatService.getConversation(
          v,
          asConversationId(req.conversationId),
        )
      : await chatService.createConversation(
          v,
          "New chat",
          undefined,
          req.agentId,
        )

    if (!conversation.agentId || String(conversation.agentId) !== req.agentId) {
      throw new HTTPException(409, {
        message: "Conversation belongs to a different agent",
      })
    }

    const result = await chatService.sendMessageAndWait(v, {
      conversationId: conversation.id,
      text: req.message,
      model: req.modelId,
      agentId: req.agentId,
      ...(req.thinkingLevel ? { thinkingLevel: req.thinkingLevel } : {}),
      ...(req.path ? { path: req.path } : {}),
      waitTimeoutMs: waitTimeoutMs(),
    })
    const statusCode = result.status === "running" ? 202 : 200
    return c.json(toPublicRunResult(result), statusCode)
  }),
)

router.post("/agents/chat/stream", (c) =>
  handle(c, async () => {
    const auth = c.get("apiKeyAuth")
    const req = await parseAgentChatRequest(c)

    await assertAgentAccessible(auth, req.agentId)

    const v = viewer(auth)
    const conversation = req.conversationId
      ? await chatService.getConversation(
          v,
          asConversationId(req.conversationId),
        )
      : await chatService.createConversation(
          v,
          "New chat",
          undefined,
          req.agentId,
        )

    if (!conversation.agentId || String(conversation.agentId) !== req.agentId) {
      throw new HTTPException(409, {
        message: "Conversation belongs to a different agent",
      })
    }

    return streamSSE(c, async (stream) => {
      type Pending = { event: StreamEvent; seq: number }
      const queue: Pending[] = []
      let waiter: (() => void) | null = null
      let runIds:
        | {
            conversationId: string
            turnId: string
            runId: string
            userMessageId: string
            assistantMessageId: string
          }
        | undefined
      let metadata: Record<string, unknown> | undefined
      let finalResult: Record<string, unknown> | undefined
      let streamError: Record<string, unknown> | undefined
      let done = false

      const wake = (): void => {
        const w = waiter
        waiter = null
        w?.()
      }

      const unsubscribe = await chatService.subscribe(
        v,
        conversation.id,
        (event, seq) => {
          if (runIds && !eventBelongsToRun(event, runIds)) return
          queue.push({ event, seq })
          wake()
        },
      )

      const abort = c.req.raw.signal
      let aborted = abort.aborted
      const onAbort = (): void => {
        aborted = true
        wake()
      }
      abort.addEventListener("abort", onAbort, { once: true })

      const pingTimer = setInterval(() => {
        if (!stream.closed) {
          stream
            .writeSSE({ event: "ping", data: String(Date.now()) })
            .catch(() => {})
        }
      }, 15000)

      const completion = (async (): Promise<void> => {
        try {
          const started = await chatService.sendMessage(v, {
            conversationId: conversation.id,
            text: req.message,
            model: req.modelId,
            agentId: req.agentId,
            ...(req.thinkingLevel
              ? { thinkingLevel: req.thinkingLevel }
              : {}),
            ...(req.path ? { path: req.path } : {}),
          })
          const runId = started.assistantMessage.runId
          if (!runId) {
            throw new Error("Assistant message missing run id")
          }
          runIds = {
            conversationId: String(conversation.id),
            turnId: String(started.turn.id),
            runId: String(runId),
            userMessageId: String(started.userMessage.id),
            assistantMessageId: String(started.assistantMessage.id),
          }
          metadata = {
            conversationId: runIds.conversationId,
            turnId: runIds.turnId,
            runId: runIds.runId,
            userMessageId: runIds.userMessageId,
            assistantMessageId: runIds.assistantMessageId,
            modelId: req.modelId,
          }
          wake()

          while (!aborted && !stream.closed) {
            const result = await chatService.readRunResult(
              v,
              conversation.id,
              runId,
            )
            if (result.status !== "running") {
              finalResult = toPublicRunResult(result)
              done = true
              wake()
              return
            }
            await new Promise((resolve) => setTimeout(resolve, 500))
          }
        } catch (err) {
          streamError = {
            message: err instanceof Error ? err.message : String(err),
          }
          done = true
          wake()
        }
      })()

      try {
        await stream.writeSSE({ event: "ready", data: "" })
        while (!aborted && !stream.closed) {
          if (metadata) {
            const data = metadata
            metadata = undefined
            await stream.writeSSE({
              event: "metadata",
              data: JSON.stringify(data),
            })
            continue
          }
          const next = queue.shift()
          if (next) {
            if (runIds && !eventBelongsToRun(next.event, runIds)) {
              continue
            }
            await stream.writeSSE({
              event: next.event.kind,
              data: JSON.stringify(next.event),
              id: String(next.seq),
            })
            continue
          }
          if (done) {
            if (streamError) {
              await stream.writeSSE({
                event: "error",
                data: JSON.stringify(streamError),
              })
            }
            if (finalResult) {
              await stream.writeSSE({
                event: "result",
                data: JSON.stringify(finalResult),
              })
            }
            await stream.writeSSE({ event: "end", data: "" })
            return
          }
          await new Promise<void>((resolve) => {
            waiter = resolve
          })
        }
      } finally {
        clearInterval(pingTimer)
        abort.removeEventListener("abort", onAbort)
        unsubscribe()
        await completion.catch(() => {})
      }
    })
  }),
)

router.get("/agents/chat/:conversationId/runs/:runId", (c) =>
  handle(c, async () => {
    const auth = c.get("apiKeyAuth")
    const conversationId = asConversationId(c.req.param("conversationId"))
    const runId = asRunId(c.req.param("runId"))
    const conversation = await chatService.getConversation(
      viewer(auth),
      conversationId,
    )
    const conversationAgentId = conversation.agentId
      ? String(conversation.agentId)
      : ""
    if (
      !conversationAgentId ||
      !(await isAgentAccessible(auth, conversationAgentId))
    ) {
      throw new RunNotFoundError(runId)
    }
    const result = await chatService.readRunResult(
      viewer(auth),
      conversationId,
      runId,
    )
    if (!(await isAgentAccessible(auth, result.agentId))) {
      throw new RunNotFoundError(runId)
    }
    return toPublicRunResult(result)
  }),
)

export default router
