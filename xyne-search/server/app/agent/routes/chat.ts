import { Hono, type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { streamSSE } from "hono/streaming"
import {
  AgentNotAccessibleError,
  ConcurrentRunError,
  ConversationNotFoundError,
  ForbiddenError,
  InvalidPathError,
  MessageNotFoundError,
  RegenerateNotAllowedError,
  RunNotFoundError,
  viewerFromPayload,
} from "../services/chat"
import { chatService as service } from "../chatServiceSingleton"
import {
  ChatAttachmentError,
  deleteChatAttachment,
  listChatAttachments,
  readChatAttachmentBytes,
  uploadChatAttachment,
  type ChatAttachment,
} from "../services/chatAttachments"
import {
  ModelNotAllowedError,
  resolveCanonicalModel,
} from "@/app/services/models"
import { safeFileServeHeaders } from "@/app/lib/fileServe"
import {
  asConversationId,
  asMessageId,
  asRunId,
  type Cursor,
  type MessageFeedbackRating,
  type StreamEvent,
} from "../storage/types"

type Vars = {
  jwtPayload: { sub: string; workspaceId: string }
}

const router = new Hono<{ Variables: Vars }>()

const viewer = (
  c: Context<{ Variables: Vars }>,
): ReturnType<typeof viewerFromPayload> =>
  viewerFromPayload(c.get("jwtPayload"))

const readCursor = (c: Context): Cursor => {
  const limitRaw = c.req.query("limit")
  const limit = Math.max(
    1,
    Math.min(Number.parseInt(limitRaw ?? "50", 10) || 50, 200),
  )
  const token = c.req.query("cursor")
  if (token) {
    return { kind: "after", token, limit }
  }
  return { kind: "first", limit }
}

const handle = async (
  c: Context,
  fn: () => Promise<Response | object>,
): Promise<Response> => {
  try {
    const result = await fn()
    if (result instanceof Response) {
      return result
    }
    return c.json(result)
  } catch (err) {
    if (err instanceof ConversationNotFoundError) {
      throw new HTTPException(404, { message: err.message })
    }
    if (err instanceof MessageNotFoundError) {
      throw new HTTPException(404, { message: err.message })
    }
    if (err instanceof RunNotFoundError) {
      throw new HTTPException(404, { message: err.message })
    }
    if (err instanceof ForbiddenError) {
      throw new HTTPException(403, { message: err.message })
    }
    if (err instanceof InvalidPathError) {
      throw new HTTPException(400, { message: err.message })
    }
    if (err instanceof ConcurrentRunError) {
      throw new HTTPException(409, { message: err.message })
    }
    if (err instanceof RegenerateNotAllowedError) {
      throw new HTTPException(409, { message: err.message })
    }
    if (err instanceof AgentNotAccessibleError) {
      throw new HTTPException(403, { message: err.message })
    }
    if (err instanceof ModelNotAllowedError) {
      throw new HTTPException(400, {
        message: err.message,
        cause: { code: "MODEL_NOT_ALLOWED" },
      })
    }
    if (err instanceof HTTPException) {
      throw err
    }
    const message = err instanceof Error ? err.message : "Internal error"
    throw new HTTPException(500, { message })
  }
}

// POST /v2/chat/conversations
router.post("/conversations", (c) =>
  handle(c, async () => {
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string
      // Ephemeral conversations never appear in chat history.
      ephemeral?: boolean
      agentId?: string
    }
    const conv = await service.createConversation(
      viewer(c),
      body.title ?? "New chat",
      body.ephemeral ? "ephemeral" : undefined,
      body.agentId,
    )
    return conv
  }),
)

// GET /v2/chat/conversations
router.get("/conversations", (c) =>
  handle(c, async () => service.listConversations(viewer(c), readCursor(c))),
)

// GET /v2/chat/conversations/:id
router.get("/conversations/:id", (c) =>
  handle(c, async () =>
    service.getConversation(viewer(c), asConversationId(c.req.param("id"))),
  ),
)

// PATCH /v2/chat/conversations/:id
router.patch("/conversations/:id", (c) =>
  handle(c, async () => {
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string
      starred?: boolean
    }
    const id = asConversationId(c.req.param("id"))
    if (body.title === undefined && typeof body.starred !== "boolean") {
      throw new HTTPException(400, { message: "title or starred required" })
    }
    if (body.title !== undefined) {
      if (!body.title) {
        throw new HTTPException(400, { message: "title cannot be empty" })
      }
      await service.renameConversation(viewer(c), id, body.title)
    }
    if (typeof body.starred === "boolean") {
      await service.setConversationStarred(viewer(c), id, body.starred)
    }
    return { ok: true }
  }),
)

// DELETE /v2/chat/conversations/:id
router.delete("/conversations/:id", (c) =>
  handle(c, async () => {
    await service.archiveConversation(
      viewer(c),
      asConversationId(c.req.param("id")),
    )
    return { ok: true }
  }),
)

// POST /v2/chat/conversations/:id/messages
router.post("/conversations/:id/messages", (c) =>
  handle(c, async () => {
    const body = (await c.req.json().catch(() => ({}))) as {
      text?: string
      model?: string
      agentId?: string
      // KB path scoping (e.g. "Collection/folder/file"); requires agentId.
      path?: string
      thinkingLevel?: string
      debug?: boolean
      debugVerbosity?: string
      attachmentIds?: string[]
      // "Generate Skills" mode — uses the in-code skill agent; skillContext
      // carries the current form snapshot for the upsertSkill tool.
      skillAssist?: boolean
      skillContext?: {
        mode?: string
        alias?: string
        name?: string
        description?: string
        content?: string
      }
      scopedDocs?: Array<{ docId?: unknown; name?: unknown }>
    }
    if (!body.text) {
      throw new HTTPException(400, { message: "text required" })
    }
    const skillContext =
      body.skillAssist && body.skillContext
        ? {
            mode:
              body.skillContext.mode === "edit"
                ? ("edit" as const)
                : ("create" as const),
            alias: String(body.skillContext.alias ?? ""),
            name: String(body.skillContext.name ?? ""),
            description: String(body.skillContext.description ?? ""),
            content: String(body.skillContext.content ?? ""),
          }
        : undefined
    // Keep only well-formed {docId, name} string entries.
    const scopedDocs = Array.isArray(body.scopedDocs)
      ? body.scopedDocs.flatMap((d) =>
          typeof d?.docId === "string" && typeof d?.name === "string"
            ? [{ docId: d.docId, name: d.name }]
            : [],
        )
      : []
    const allowedLevels = ["minimal", "low", "medium", "high"] as const
    type ThinkingLevel = (typeof allowedLevels)[number]
    const thinkingLevel: ThinkingLevel | undefined = allowedLevels.includes(
      body.thinkingLevel as ThinkingLevel,
    )
      ? (body.thinkingLevel as ThinkingLevel)
      : undefined
    const allowedVerbosity = ["summary", "detailed"] as const
    type DebugVerbosity = (typeof allowedVerbosity)[number]
    const debugVerbosity: DebugVerbosity | undefined =
      allowedVerbosity.includes(body.debugVerbosity as DebugVerbosity)
        ? (body.debugVerbosity as DebugVerbosity)
        : undefined
    // DO NOT forward c.req.raw.signal: the pi-mono run must outlive client
    // disconnects so the user can reattach to the SSE stream and resume a
    // partial answer. The run stays bounded by pi-mono's own timeouts.
    // Explicit cancel is a separate endpoint (TODO), not coupled to TCP teardown.
    const resolvedModel = await resolveCanonicalModel(body.model)
    return service.sendMessage(viewer(c), {
      conversationId: asConversationId(c.req.param("id")),
      text: body.text,
      model: resolvedModel.id,
      ...(body.agentId ? { agentId: body.agentId } : {}),
      ...(body.path ? { path: body.path } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(body.debug ? { debug: true } : {}),
      ...(debugVerbosity ? { debugVerbosity } : {}),
      ...(Array.isArray(body.attachmentIds) && body.attachmentIds.length > 0
        ? {
            attachmentIds: body.attachmentIds.filter(
              (id): id is string => typeof id === "string",
            ),
          }
        : {}),
      ...(body.skillAssist ? { skillAssist: true } : {}),
      ...(skillContext ? { skillContext } : {}),
      ...(scopedDocs.length > 0 ? { scopedDocs } : {}),
    })
  }),
)

// GET /v2/chat/conversations/:id/dump
router.get("/conversations/:id/dump", (c) =>
  handle(c, async () =>
    service.dumpConversation(
      viewer(c),
      asConversationId(c.req.param("id")),
    ),
  ),
)

// GET /v2/chat/conversations/:id/debug-events?runId=...
// Re-seeds the DebugPanel's in-memory store on reload; the live SSE stream
// and client store are both ephemeral.
router.get("/conversations/:id/debug-events", (c) =>
  handle(c, async () => {
    const runId = c.req.query("runId")
    if (!runId) {
      throw new HTTPException(400, { message: "runId query param is required" })
    }
    // Ownership + run↔conversation binding are enforced inside readDebugEvents,
    // so a viewer can't read another conversation's run by supplying its runId.
    const events = await service.readDebugEvents(
      viewer(c),
      asConversationId(c.req.param("id")),
      asRunId(runId),
    )
    return { runId, events }
  }),
)

// POST /v2/chat/conversations/:id/interrupt
router.post("/conversations/:id/interrupt", (c) =>
  handle(c, async () =>
    service.interrupt(viewer(c), asConversationId(c.req.param("id"))),
  ),
)

// POST /v2/chat/conversations/:id/regenerate
// `assistantMessageId` guards against a stale client regenerating the wrong
// turn. Run is detached and streamed over SSE like sendMessage.
router.post("/conversations/:id/regenerate", (c) =>
  handle(c, async () => {
    const body = (await c.req.json().catch(() => ({}))) as {
      assistantMessageId?: string
      debug?: boolean
      debugVerbosity?: string
    }
    const allowedVerbosity = ["summary", "detailed"] as const
    type DebugVerbosity = (typeof allowedVerbosity)[number]
    const debugVerbosity: DebugVerbosity | undefined =
      allowedVerbosity.includes(body.debugVerbosity as DebugVerbosity)
        ? (body.debugVerbosity as DebugVerbosity)
        : undefined
    return service.regenerateResponse(viewer(c), {
      conversationId: asConversationId(c.req.param("id")),
      ...(typeof body.assistantMessageId === "string"
        ? { assistantMessageId: body.assistantMessageId }
        : {}),
      ...(body.debug ? { debug: true } : {}),
      ...(debugVerbosity ? { debugVerbosity } : {}),
    })
  }),
)

// POST /v2/chat/conversations/:id/messages/:messageId/edit
// Truncates the conversation from this message onward and re-runs with the
// new text. Streams over SSE like sendMessage.
router.post("/conversations/:id/messages/:messageId/edit", (c) =>
  handle(c, async () => {
    const body = (await c.req.json().catch(() => ({}))) as {
      text?: string
      debug?: boolean
      debugVerbosity?: string
    }
    if (!body.text) {
      throw new HTTPException(400, { message: "text required" })
    }
    const allowedVerbosity = ["summary", "detailed"] as const
    type DebugVerbosity = (typeof allowedVerbosity)[number]
    const debugVerbosity: DebugVerbosity | undefined =
      allowedVerbosity.includes(body.debugVerbosity as DebugVerbosity)
        ? (body.debugVerbosity as DebugVerbosity)
        : undefined
    return service.editUserMessageAndResend(viewer(c), {
      conversationId: asConversationId(c.req.param("id")),
      messageId: c.req.param("messageId"),
      text: body.text,
      ...(body.debug ? { debug: true } : {}),
      ...(debugVerbosity ? { debugVerbosity } : {}),
    })
  }),
)

// POST /v2/chat/conversations/:id/fork
// Forks into a new conversation containing the transcript up to and including
// uptoMessageId's turn; returns the new conversation id.
router.post("/conversations/:id/fork", (c) =>
  handle(c, async () => {
    const body = (await c.req.json().catch(() => ({}))) as {
      uptoMessageId?: string
    }
    if (!body.uptoMessageId) {
      throw new HTTPException(400, { message: "uptoMessageId required" })
    }
    return service.forkConversation(viewer(c), {
      conversationId: asConversationId(c.req.param("id")),
      uptoMessageId: body.uptoMessageId,
    })
  }),
)

// GET /v2/chat/conversations/:id/messages
router.get("/conversations/:id/messages", (c) =>
  handle(c, async () =>
    service.listMessages(
      viewer(c),
      asConversationId(c.req.param("id")),
      readCursor(c),
    ),
  ),
)

// GET /v2/chat/conversations/:id/runs/:parentRunId/nested  (M8)
// Ordered by startedAt: the UI matches the Nth dispatchSubagent tool_call to
// the Nth entry in nestedRuns.
router.get("/conversations/:id/runs/:parentRunId/nested", (c) =>
  handle(c, async () =>
    service.listNestedRuns(
      viewer(c),
      asConversationId(c.req.param("id")),
      asRunId(c.req.param("parentRunId")),
    ),
  ),
)

// Message feedback. PUT upserts (client sends the desired final state, so
// toggling/editing all hit it); DELETE retracts; GET reads the viewer's own.

const FEEDBACK_TAG_LIMIT = 16
const FEEDBACK_TAG_MAX_LEN = 64
const FEEDBACK_COMMENT_MAX_LEN = 4000

const parseFeedbackBody = (
  raw: unknown,
): {
  rating: MessageFeedbackRating
  tags?: string[]
  comment?: string
  shareChat?: boolean
} => {
  if (!raw || typeof raw !== "object") {
    throw new HTTPException(400, { message: "body required" })
  }
  const body = raw as Record<string, unknown>
  if (body["rating"] !== "like" && body["rating"] !== "dislike") {
    throw new HTTPException(400, {
      message: "rating must be 'like' or 'dislike'",
    })
  }
  const out: {
    rating: MessageFeedbackRating
    tags?: string[]
    comment?: string
    shareChat?: boolean
  } = { rating: body["rating"] }
  // Cap count + length so a malicious client can't bloat the row.
  if (body["tags"] !== undefined) {
    if (!Array.isArray(body["tags"])) {
      throw new HTTPException(400, { message: "tags must be an array" })
    }
    const tags = body["tags"]
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && t.length <= FEEDBACK_TAG_MAX_LEN)
      .slice(0, FEEDBACK_TAG_LIMIT)
    out.tags = tags
  }
  if (body["comment"] !== undefined) {
    if (typeof body["comment"] !== "string") {
      throw new HTTPException(400, { message: "comment must be a string" })
    }
    const c = body["comment"].trim()
    if (c.length > 0) {
      out.comment = c.slice(0, FEEDBACK_COMMENT_MAX_LEN)
    }
  }
  if (body["shareChat"] !== undefined) {
    out.shareChat = Boolean(body["shareChat"])
  }
  return out
}

// PUT /v2/chat/conversations/:id/messages/:messageId/feedback
router.put("/conversations/:id/messages/:messageId/feedback", (c) =>
  handle(c, async () => {
    const body = parseFeedbackBody(await c.req.json().catch(() => null))
    return service.setMessageFeedback(
      viewer(c),
      asConversationId(c.req.param("id")),
      asMessageId(c.req.param("messageId")),
      body,
    )
  }),
)

// GET /v2/chat/conversations/:id/messages/:messageId/feedback
router.get("/conversations/:id/messages/:messageId/feedback", (c) =>
  handle(c, async () => {
    const fb = await service.getMessageFeedback(
      viewer(c),
      asConversationId(c.req.param("id")),
      asMessageId(c.req.param("messageId")),
    )
    return fb ?? { feedback: null }
  }),
)

// DELETE /v2/chat/conversations/:id/messages/:messageId/feedback
router.delete("/conversations/:id/messages/:messageId/feedback", (c) =>
  handle(c, async () => {
    const deleted = await service.deleteMessageFeedback(
      viewer(c),
      asConversationId(c.req.param("id")),
      asMessageId(c.req.param("messageId")),
    )
    return { deleted }
  }),
)

// GET /v2/chat/conversations/:id/stream  (SSE — live turn/block events)
router.get("/conversations/:id/stream", (c) => {
  const convId = asConversationId(c.req.param("id"))

  // Resume cursor: EventSource sends the last id as `Last-Event-ID` on
  // auto-reconnect. Also accepted as a query param for manual reopens.
  const lastEventIdHeader =
    c.req.header("Last-Event-ID") ?? c.req.header("last-event-id")
  const sinceSeqQ = c.req.query("sinceSeq")
  const parsed = Number(lastEventIdHeader ?? sinceSeqQ ?? 0)
  const sinceSeq = Number.isFinite(parsed) && parsed > 0 ? parsed : 0

  return streamSSE(c, async (stream) => {
    type Pending = { event: StreamEvent; seq: number }
    const queue: Pending[] = []
    let waiter: (() => void) | null = null
    const wake = (): void => {
      const w = waiter
      waiter = null
      w?.()
    }

    let unsubscribe: (() => void) | null
    try {
      unsubscribe = await service.subscribe(
        viewer(c),
        convId,
        (event, seq) => {
          queue.push({ event, seq })
          wake()
        },
        { sinceSeq },
      )
    } catch (err) {
      if (err instanceof ConversationNotFoundError) {
        throw new HTTPException(404, { message: err.message })
      }
      if (err instanceof ForbiddenError) {
        throw new HTTPException(403, { message: err.message })
      }
      throw err
    }

    const pingTimer = setInterval(() => {
      if (!stream.closed) {
        stream
          .writeSSE({ event: "ping", data: String(Date.now()) })
          .catch(() => {})
      }
    }, 15000)

    await stream.writeSSE({ event: "ready", data: "" })

    const abort = c.req.raw.signal
    let aborted = abort.aborted
    abort.addEventListener("abort", () => {
      aborted = true
      wake()
    })

    try {
      while (!aborted && !stream.closed) {
        const next = queue.shift()
        if (next) {
          await stream.writeSSE({
            event: next.event.kind,
            data: JSON.stringify(next.event),
            // SSE `id:` — browser echoes it as Last-Event-ID on reconnect to resume.
            id: String(next.seq),
          })
          continue
        }
        await new Promise<void>((resolve) => {
          waiter = resolve
        })
      }
    } finally {
      clearInterval(pingTimer)
      unsubscribe()
    }
  })
})

// Conversation attachments. Ownership is checked via service.getConversation
// before every mutation (non-owners get 403). Attachments inherit the
// conversation's lifetime via FK cascade.

const attachmentToJson = (a: ChatAttachment): Record<string, unknown> => ({
  id: a.id,
  // null while the upload is pending; set to the user-message id on send.
  messageId: a.messageId,
  fileName: a.fileName,
  mimeType: a.mimeType,
  sizeBytes: a.sizeBytes,
  uploadedBy: a.uploadedBy,
  createdAt: a.createdAt,
})

// POST /v2/chat/conversations/:id/attachments  (multipart/form-data, field "file")
router.post("/conversations/:id/attachments", (c) =>
  handle(c, async () => {
    const v = viewer(c)
    const convId = asConversationId(c.req.param("id"))
    await service.getConversation(v, convId)
    const form = await c.req.parseBody({ all: false })
    const file = form["file"]
    if (!(file instanceof File)) {
      throw new HTTPException(400, {
        message:
          "Expected multipart/form-data with a single 'file' field carrying the upload",
      })
    }
    const buf = new Uint8Array(await file.arrayBuffer())
    try {
      const attachment = await uploadChatAttachment({
        conversationId: convId,
        uploadedBy: v.userId,
        fileName: file.name,
        ...(file.type ? { headerMime: file.type } : {}),
        bytes: buf,
      })
      return { attachment: attachmentToJson(attachment) }
    } catch (err) {
      if (err instanceof ChatAttachmentError) {
        const status =
          err.code === "too_large" ? 413
            : err.code === "too_many" ? 409
            : err.code === "unsupported_type" ? 415
            : err.code === "empty" ? 400
            : 400
        throw new HTTPException(status, { message: err.message })
      }
      throw err
    }
  }),
)

// GET /v2/chat/conversations/:id/attachments
router.get("/conversations/:id/attachments", (c) =>
  handle(c, async () => {
    const v = viewer(c)
    const convId = asConversationId(c.req.param("id"))
    await service.getConversation(v, convId)
    const items = await listChatAttachments(convId)
    return { attachments: items.map(attachmentToJson) }
  }),
)

// DELETE /v2/chat/conversations/:id/attachments/:attachmentId
router.delete("/conversations/:id/attachments/:attachmentId", (c) =>
  handle(c, async () => {
    const v = viewer(c)
    const convId = asConversationId(c.req.param("id"))
    await service.getConversation(v, convId)
    await deleteChatAttachment(convId, c.req.param("attachmentId"))
    return { deleted: true }
  }),
)

// GET /v2/chat/conversations/:id/attachments/:attachmentId/raw
// Streams the original bytes back (inline render / download).
// NOT wrapped in `handle` because that helper JSON-serialises returns; error
// mapping is done inline below.
router.get("/conversations/:id/attachments/:attachmentId/raw", async (c) => {
  const v = viewer(c)
  const convId = asConversationId(c.req.param("id"))
  try {
    await service.getConversation(v, convId)
    const { attachment, bytes } = await readChatAttachmentBytes(
      convId,
      c.req.param("attachmentId"),
    )
    // Same stored-XSS defense as KB file serving (#6): an attacker-influenced
    // mimeType (text/html, image/svg+xml) rendered inline would run script in the
    // app's authenticated origin. Force a safe Content-Type + nosniff + sandbox
    // CSP, rendering inline only the PDF/image allowlist; `?download=1` forces a
    // download regardless.
    const safe = safeFileServeHeaders(
      attachment.mimeType,
      encodeURIComponent(attachment.fileName),
    )
    if (c.req.query("download") === "1") {
      safe["Content-Disposition"] =
        `attachment; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`
    }
    return c.body(bytes as unknown as ArrayBuffer, 200, {
      ...safe,
      // Bytes are immutable per attachment id, so a long cache is safe.
      // eslint-disable-next-line @typescript-eslint/naming-convention
      "Content-Length": String(attachment.sizeBytes),
      // eslint-disable-next-line @typescript-eslint/naming-convention
      "Cache-Control": "private, max-age=3600",
    })
  } catch (err) {
    if (err instanceof ConversationNotFoundError) {
      throw new HTTPException(404, { message: err.message })
    }
    if (err instanceof ForbiddenError) {
      throw new HTTPException(403, { message: err.message })
    }
    if (err instanceof ChatAttachmentError && err.code === "not_found") {
      throw new HTTPException(404, { message: err.message })
    }
    throw err
  }
})

export default router
