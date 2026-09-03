import { createReadStream } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { type Context, Hono, type Next } from "hono"
import { HTTPException } from "hono/http-exception"
import { stream } from "hono/streaming"
import { db } from "@/platform/db/client"
import { safeFileServeHeaders } from "@/app/lib/fileServe"
import { users, chats, messages, agents, selectPublicAgentSchema, userPersonalization, workspaces } from "@/platform/db/schema"
import { collections, collectionItems } from "@/platform/db/schema/knowledgeBase"
import { subAgents as dbSubAgents } from "@/platform/db/schema/subAgents"
import {
  getCollectionById,
  getCollectionItemsByParent,
  getCollectionItemById,
  getCollectionFileByItemId,
} from "@/platform/db/knowledgeBase"
import { getAgentByExternalId } from "@/platform/db/agent"
import { getAgentUsers } from "@/platform/db/userAgentPermission"
import { getUserAndWorkspaceByEmail } from "@/platform/db/user"
import { UserAgentRole } from "@/platform/shared/types"
import { resolveAgentSystemPrompt } from "@/app/agent/pi-mono/system-prompt"
import {
  v2ChatConversations,
  v2ChatMessages,
  v2ChatRuns,
  v2ChatToolCalls,
} from "@/platform/db/schema/v2Chat"
import { readPersistedEvents } from "@/app/agent/pi-mono/debug/persist"
import {
  eq,
  sql,
  and,
  isNull,
  count,
  sum,
  desc,
  asc,
  gte,
  lte,
  ilike,
  or,
} from "drizzle-orm"
import { abbreviations } from "@/platform/db/schema/abbreviation"
import { getLogger } from "@/platform/logger"
import { Subsystem } from "@/types"
import config from "@/config"
import { getAvailableModels } from "@/platform/ai/fetchModels"
import { runUnifiedSearch, yqlString } from "@/app/agent/pi-mono/tools/vespa/searchCore"
import { snippetForLeanChunk } from "@/app/agent/pi-mono/tools/vespa/util"

const Logger = getLogger(Subsystem.Api).child({ module: "backendv2/admin" })

type Vars = {
  jwtPayload: { sub: string; workspaceId: string; role: string }
}

const AdminMiddleware = async (
  c: Context<{ Variables: Vars }>,
  next: Next,
): Promise<void> => {
  const role = c.get("jwtPayload").role
  if (role !== "SuperAdmin") {
    throw new HTTPException(403, { message: "SuperAdmin access required" })
  }
  await next()
}

const router = new Hono<{ Variables: Vars }>()

// ── Users ──────────────────────────────────────────────────────────────────

router.get("/users", AdminMiddleware, async (c) => {
  try {
    const query = c.req.query()
    const page = Math.max(1, Number(query["page"]) || 1)
    const limit = Math.max(1, Math.min(100, Number(query["limit"]) || 20))
    const search = query["search"]?.trim()
    const offset = (page - 1) * limit
    const workspaceExternalId = c.get("jwtPayload").workspaceId

    // Scope to the caller's workspace — SuperAdmin is per-workspace (#5).
    const whereClause = and(
      eq(users.workspaceExternalId, workspaceExternalId),
      search
        ? or(ilike(users.email, `%${search}%`), ilike(users.name, `%${search}%`))
        : undefined,
    )

    const [countResult, result] = await Promise.all([
      db.select({ count: count() }).from(users).where(whereClause),
      db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
          createdAt: users.createdAt,
          lastLogin: users.lastLogin,
          isActive: isNull(users.deletedAt),
          totalChats: sql<number>`(
            SELECT COUNT(*)::int
            FROM v2_chat_conversations
            WHERE owner_id = ${users.email}
          )`,
          totalMessages: sql<number>`(
            SELECT COUNT(m.id)::int
            FROM v2_chat_messages m
            INNER JOIN v2_chat_conversations c ON c.id = m.conversation_id
            WHERE c.owner_id = ${users.email}
          )`,
          totalTokens: sql<number>`(
            SELECT COALESCE(
              SUM(
                COALESCE((m.stats->'tokenUsage'->>'input')::int, 0) +
                COALESCE((m.stats->'tokenUsage'->>'output')::int, 0) +
                COALESCE((m.stats->'tokenUsage'->>'cacheRead')::int, 0)
              ),
              0
            )::bigint
            FROM v2_chat_messages m
            INNER JOIN v2_chat_conversations c ON c.id = m.conversation_id
            WHERE c.owner_id = ${users.email}
            AND m.stats IS NOT NULL
          )`,
        })
        .from(users)
        .where(whereClause)
        .orderBy(asc(users.email))
        .limit(limit)
        .offset(offset),
    ])

    const totalCount = countResult[0]?.count ?? 0
    const processed = result.map((user) => ({
      ...user,
      totalTokens: Number(user.totalTokens) || 0,
    }))

    return c.json({
      users: processed,
      pagination: {
        totalCount,
        page,
        limit,
        hasMore: offset + result.length < totalCount,
      },
    })
  } catch (error) {
    Logger.error(error, "Error fetching admin users")
    throw new HTTPException(500, { message: "Failed to fetch users" })
  }
})

// ── Chats ──────────────────────────────────────────────────────────────────

router.get("/chats", AdminMiddleware, async (c) => {
  try {
    const query = c.req.query()

    const page = Math.max(1, Number(query["page"]) || 1)
    const pageSize = Math.max(1, Math.min(100, Number(query["offset"]) || 20))

    const sortBy =
      query["sortBy"] === "messages" ||
      query["sortBy"] === "cost" ||
      query["sortBy"] === "tokens"
        ? query["sortBy"]
        : "created"

    const fromDate = query["from"] ? new Date(query["from"]) : undefined
    const toDate = query["to"] ? new Date(query["to"]) : undefined
    const search = query["search"]?.trim()
    const workspaceExternalId = c.get("jwtPayload").workspaceId

    const conditions = [
      // Scope to the caller's workspace — SuperAdmin is per-workspace (#5).
      eq(users.workspaceExternalId, workspaceExternalId),
      isNull(messages.deletedAt),
      isNull(chats.deletedAt),
    ]

    if (fromDate && !isNaN(fromDate.getTime())) {
      conditions.push(gte(chats.createdAt, fromDate))
    }
    if (toDate && !isNaN(toDate.getTime())) {
      conditions.push(lte(chats.createdAt, toDate))
    }
    if (search) {
      const pattern = `%${search}%`
      const searchCond = or(
        ilike(chats.title, pattern),
        ilike(users.email, pattern),
        ilike(users.name, pattern),
      )
      if (searchCond) conditions.push(searchCond)
    }

    const countResult = await db
      .select({ count: count() })
      .from(chats)
      .leftJoin(users, eq(chats.userId, users.id))
      .leftJoin(messages, eq(chats.id, messages.chatId))
      .where(and(...conditions))
      .groupBy(chats.id, users.email, users.name, users.role)

    const totalCount = countResult.length

    let orderBy
    switch (sortBy) {
      case "messages":
        orderBy = desc(
          count(
            sql`CASE WHEN ${messages.deletedAt} IS NULL THEN ${messages.id} END`,
          ),
        )
        break
      case "cost":
        orderBy = desc(
          sql`COALESCE(SUM(CASE WHEN ${messages.deletedAt} IS NULL THEN ${messages.cost} ELSE 0 END), 0)`,
        )
        break
      case "tokens":
        orderBy = desc(
          sum(
            sql`CASE WHEN ${messages.deletedAt} IS NULL THEN ${messages.tokensUsed} ELSE 0 END`,
          ),
        )
        break
      case "created":
      default:
        orderBy = desc(chats.createdAt)
        break
    }

    const result = await db
      .select({
        id: chats.id,
        externalId: chats.externalId,
        title: chats.title,
        createdAt: chats.createdAt,
        agentId: chats.agentId,
        userId: chats.userId,
        userEmail: users.email,
        userName: users.name,
        userRole: users.role,
        messageCount: count(
          sql`CASE WHEN ${messages.deletedAt} IS NULL THEN ${messages.id} END`,
        ),
        likes: count(
          sql`CASE WHEN ${messages.feedback}->>'type' = 'like' AND ${messages.deletedAt} IS NULL THEN 1 END`,
        ),
        dislikes: count(
          sql`CASE WHEN ${messages.feedback}->>'type' = 'dislike' AND ${messages.deletedAt} IS NULL THEN 1 END`,
        ),
        totalCost: sum(
          sql`CASE WHEN ${messages.deletedAt} IS NULL THEN ${messages.cost} ELSE 0 END`,
        ),
        totalTokens: sum(
          sql`CASE WHEN ${messages.deletedAt} IS NULL THEN ${messages.tokensUsed} ELSE 0 END`,
        ),
      })
      .from(chats)
      .leftJoin(users, eq(chats.userId, users.id))
      .leftJoin(messages, eq(chats.id, messages.chatId))
      .where(and(...conditions))
      .groupBy(chats.id, users.email, users.name, users.role)
      .orderBy(orderBy)
      .limit(pageSize)
      .offset((page - 1) * pageSize)

    const processed = result.map((chat) => ({
      ...chat,
      totalCost: Number(chat.totalCost) || 0,
      totalTokens: Number(chat.totalTokens) || 0,
    }))

    return c.json({
      data: processed,
      pagination: {
        totalCount,
        currentPage: page,
        pageSize,
        hasNextPage: page * pageSize < totalCount,
        hasPreviousPage: page > 1,
      },
    })
  } catch (error) {
    Logger.error(error, "Error fetching admin chats")
    throw new HTTPException(500, { message: "Failed to fetch chats" })
  }
})

// ── Chat messages (viewer) ─────────────────────────────────────────────────

router.get("/chats/:chatId/messages", AdminMiddleware, async (c) => {
  try {
    const chatExternalId = c.req.param("chatId")

    const chatResult = await db
      .select({
        id: chats.id,
        externalId: chats.externalId,
        title: chats.title,
        userId: chats.userId,
        createdAt: chats.createdAt,
        userEmail: users.email,
        userName: users.name,
      })
      .from(chats)
      .leftJoin(users, eq(chats.userId, users.id))
      // Scope to the caller's workspace (#5): a chat outside it 404s below, so
      // the messages query is only reached for in-workspace chats.
      .where(
        and(
          eq(chats.externalId, chatExternalId),
          eq(users.workspaceExternalId, c.get("jwtPayload").workspaceId),
        ),
      )
      .limit(1)

    if (chatResult.length === 0) {
      throw new HTTPException(404, { message: "Chat not found" })
    }

    const chat = chatResult[0]!

    const msgs = await db
      .select({
        id: messages.id,
        message: messages.message,
        messageRole: messages.messageRole,
        thinking: messages.thinking,
        createdAt: messages.createdAt,
        email: messages.email,
        cost: messages.cost,
        tokensUsed: messages.tokensUsed,
        feedback: messages.feedback,
      })
      .from(messages)
      .where(eq(messages.chatExternalId, chatExternalId))
      .orderBy(asc(messages.createdAt))

    return c.json({
      chat: {
        id: chat.id,
        externalId: chat.externalId,
        title: chat.title,
        userName: chat.userName,
        userEmail: chat.userEmail,
        createdAt: chat.createdAt,
      },
      messages: msgs.map((m) => ({
        id: m.id,
        text: m.message,
        role: m.messageRole,
        thinking: m.thinking,
        createdAt: m.createdAt,
        email: m.email,
        cost: Number(m.cost) || 0,
        tokensUsed: m.tokensUsed || 0,
        feedback: m.feedback,
      })),
    })
  } catch (error) {
    if (error instanceof HTTPException) throw error
    Logger.error(error, "Error fetching chat messages")
    throw new HTTPException(500, {
      message: "Failed to fetch chat messages",
    })
  }
})

// ── V2 Conversations ──────────────────────────────────────────────────────────

router.get("/conversations", AdminMiddleware, async (c) => {
  try {
    const query = c.req.query()
    const page = Math.max(1, Number(query["page"]) || 1)
    const pageSize = Math.max(1, Math.min(100, Number(query["offset"]) || 20))
    const search = query["search"]?.trim()
    const from = query["from"]
    const to = query["to"]

    // Scope to the caller's workspace — SuperAdmin is per-workspace (#5).
    const conditions = [
      eq(v2ChatConversations.workspaceId, c.get("jwtPayload").workspaceId),
    ]
    if (search) {
      const pattern = `%${search}%`
      const searchCond = or(
        ilike(v2ChatConversations.title, pattern),
        ilike(users.email, pattern),
        ilike(users.name, pattern),
      )
      if (searchCond) conditions.push(searchCond)
    }
    if (from && !isNaN(new Date(from).getTime())) {
      conditions.push(gte(v2ChatConversations.createdAt, new Date(from).getTime()))
    }
    if (to && !isNaN(new Date(to).getTime())) {
      conditions.push(lte(v2ChatConversations.createdAt, new Date(to).getTime() + 86_400_000 - 1))
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined

    const [totalResult, rows] = await Promise.all([
      db
        .select({ count: count() })
        .from(v2ChatConversations)
        .leftJoin(users, eq(v2ChatConversations.ownerId, users.email))
        .where(whereClause)
        .then((r) => r[0]?.count ?? 0),
      db
        .select({
          id: v2ChatConversations.id,
          title: v2ChatConversations.title,
          createdAt: v2ChatConversations.createdAt,
          agentId: v2ChatConversations.agentId,
          userEmail: users.email,
          userName: users.name,
          messageCount: count(v2ChatMessages.id),
        })
        .from(v2ChatConversations)
        .leftJoin(users, eq(v2ChatConversations.ownerId, users.email))
        .leftJoin(
          v2ChatMessages,
          eq(v2ChatConversations.id, v2ChatMessages.conversationId),
        )
        .where(whereClause)
        .groupBy(v2ChatConversations.id, users.email, users.name)
        .orderBy(desc(v2ChatConversations.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
    ])

    const totalCount = Number(totalResult)
    return c.json({
      data: rows,
      pagination: {
        totalCount,
        currentPage: page,
        pageSize,
        hasNextPage: page * pageSize < totalCount,
        hasPreviousPage: page > 1,
      },
    })
  } catch (error) {
    Logger.error(error, "Error fetching admin conversations")
    throw new HTTPException(500, { message: "Failed to fetch conversations" })
  }
})

// ── V2 Conversation messages ──────────────────────────────────────────────────

router.get("/conversations/:id/messages", AdminMiddleware, async (c) => {
  try {
    const conversationId = c.req.param("id")

    const convResult = await db
      .select({
        id: v2ChatConversations.id,
        title: v2ChatConversations.title,
        createdAt: v2ChatConversations.createdAt,
        userEmail: users.email,
        userName: users.name,
      })
      .from(v2ChatConversations)
      .leftJoin(users, eq(v2ChatConversations.ownerId, users.email))
      // Scope to the caller's workspace (#5): out-of-workspace 404s, so the
      // messages query below is only reached for in-workspace conversations.
      .where(
        and(
          eq(v2ChatConversations.id, conversationId),
          eq(
            v2ChatConversations.workspaceId,
            c.get("jwtPayload").workspaceId,
          ),
        ),
      )
      .limit(1)

    if (convResult.length === 0) {
      throw new HTTPException(404, { message: "Conversation not found" })
    }

    const conv = convResult[0]!

    const msgs = await db
      .select({
        id: v2ChatMessages.id,
        role: v2ChatMessages.role,
        blocks: v2ChatMessages.blocks,
        stats: v2ChatMessages.stats,
        createdAt: v2ChatMessages.createdAt,
        runId: v2ChatMessages.runId,
        turnId: v2ChatMessages.turnId,
      })
      .from(v2ChatMessages)
      .where(eq(v2ChatMessages.conversationId, conversationId))
      .orderBy(asc(v2ChatMessages.ordinal))

    return c.json({
      conversation: {
        id: conv.id,
        title: conv.title,
        createdAt: conv.createdAt,
        userEmail: conv.userEmail,
        userName: conv.userName,
      },
      messages: msgs.map((m) => {
        const rawBlocks =
          (m.blocks as Array<{ kind: string; text?: string }>) || []
        const text = rawBlocks
          .filter((b) => b.kind === "text")
          .map((b) => b.text ?? "")
          .join("\n")
        const thinking =
          rawBlocks.find((b) => b.kind === "thinking")?.text ?? null
        return {
          id: m.id,
          role: m.role,
          text,
          thinking,
          blocks: rawBlocks,
          createdAt: m.createdAt,
          runId: m.runId ?? null,
          turnId: m.turnId ?? null,
          stats: m.stats ?? null,
        }
      }),
    })
  } catch (error) {
    if (error instanceof HTTPException) throw error
    Logger.error(error, "Error fetching admin conversation messages")
    throw new HTTPException(500, {
      message: "Failed to fetch conversation messages",
    })
  }
})

// ── V2 Conversation debug events ──────────────────────────────────────────────

router.get("/conversations/:id/debug-events", AdminMiddleware, async (c) => {
  try {
    const conversationId = c.req.param("id")
    const runId = c.req.query("runId")
    if (!runId) {
      throw new HTTPException(400, { message: "runId query param is required" })
    }

    // Scope the conversation to the caller's workspace (#5) and bind the
    // attacker-controlled runId to it (same IDOR class as #4) before reading.
    const [conv] = await db
      .select({ id: v2ChatConversations.id })
      .from(v2ChatConversations)
      .where(
        and(
          eq(v2ChatConversations.id, conversationId),
          eq(
            v2ChatConversations.workspaceId,
            c.get("jwtPayload").workspaceId,
          ),
        ),
      )
      .limit(1)
    if (!conv) {
      throw new HTTPException(404, { message: "Conversation not found" })
    }
    const [run] = await db
      .select({ id: v2ChatRuns.id })
      .from(v2ChatRuns)
      .where(
        and(
          eq(v2ChatRuns.id, runId),
          eq(v2ChatRuns.conversationId, conversationId),
        ),
      )
      .limit(1)
    if (!run) {
      throw new HTTPException(404, { message: "Run not found" })
    }

    const events = await readPersistedEvents(runId)
    return c.json({ runId, events })
  } catch (error) {
    if (error instanceof HTTPException) throw error
    Logger.error(error, "Error fetching admin debug events")
    throw new HTTPException(500, { message: "Failed to fetch debug events" })
  }
})

// ── Agent usage ───────────────────────────────────────────────────────────────

router.get("/agent-usage", AdminMiddleware, async (c) => {
  try {
    const rows = await db
      .select({
        agentId: v2ChatRuns.agentId,
        agentName: agents.name,
        runCount: count(v2ChatRuns.id),
        userCount: sql<number>`COUNT(DISTINCT ${v2ChatConversations.ownerId})::int`,
        topLevelRuns: sql<number>`COUNT(CASE WHEN ${v2ChatRuns.parentRunId} IS NULL THEN 1 END)::int`,
        subAgentDispatches: sql<number>`COUNT(CASE WHEN ${v2ChatRuns.parentRunId} IS NOT NULL THEN 1 END)::int`,
      })
      .from(v2ChatRuns)
      .innerJoin(
        v2ChatConversations,
        eq(v2ChatRuns.conversationId, v2ChatConversations.id),
      )
      .leftJoin(agents, eq(v2ChatRuns.agentId, agents.externalId))
      // Scope to the caller's workspace — SuperAdmin is per-workspace (#5).
      .where(eq(v2ChatConversations.workspaceId, c.get("jwtPayload").workspaceId))
      .groupBy(v2ChatRuns.agentId, agents.name)
      .orderBy(desc(sql`COUNT(${v2ChatRuns.id})`))

    return c.json({
      agents: rows.map((r) => ({
        agentId: r.agentId,
        agentName: r.agentName ?? r.agentId,
        runCount: r.runCount,
        userCount: r.userCount,
        topLevelRuns: r.topLevelRuns,
        subAgentDispatches: r.subAgentDispatches,
      })),
    })
  } catch (error) {
    Logger.error(error, "Error fetching agent usage")
    throw new HTTPException(500, { message: "Failed to fetch agent usage" })
  }
})

// ── Knowledge base ────────────────────────────────────────────────────────────

router.get("/knowledge-base", AdminMiddleware, async (c) => {
  try {
    const rows = await db
      .select({
        id: collections.id,
        name: collections.name,
        uploadStatus: collections.uploadStatus,
        statusMessage: collections.statusMessage,
        retryCount: collections.retryCount,
        totalItems: collections.totalItems,
        createdAt: collections.createdAt,
        ownerEmail: users.email,
        ownerName: users.name,
      })
      .from(collections)
      .leftJoin(users, eq(collections.ownerId, users.id))
      // Scope to the caller's workspace via the owner (#5).
      .where(
        and(
          isNull(collections.deletedAt),
          eq(users.workspaceExternalId, c.get("jwtPayload").workspaceId),
        ),
      )
      .orderBy(desc(collections.createdAt))

    return c.json({ collections: rows })
  } catch (error) {
    Logger.error(error, "Error fetching knowledge base collections")
    throw new HTTPException(500, { message: "Failed to fetch knowledge base" })
  }
})

router.get("/knowledge-base/:id/items", AdminMiddleware, async (c) => {
  try {
    const collectionId = c.req.param("id")

    const rows = await db
      .select({
        id: collectionItems.id,
        name: collectionItems.name,
        type: collectionItems.type,
        originalName: collectionItems.originalName,
        mimeType: collectionItems.mimeType,
        fileSize: collectionItems.fileSize,
        uploadStatus: collectionItems.uploadStatus,
        statusMessage: collectionItems.statusMessage,
        retryCount: collectionItems.retryCount,
        createdAt: collectionItems.createdAt,
        ownerEmail: collectionItems.uploadedByEmail,
      })
      .from(collectionItems)
      .leftJoin(workspaces, eq(collectionItems.workspaceId, workspaces.id))
      .where(
        and(
          eq(collectionItems.collectionId, collectionId),
          isNull(collectionItems.deletedAt),
          // Scope to the caller's workspace via the item's workspace (#5).
          eq(workspaces.externalId, c.get("jwtPayload").workspaceId),
        ),
      )
      .orderBy(asc(collectionItems.createdAt))

    return c.json({ items: rows })
  } catch (error) {
    Logger.error(error, "Error fetching collection items")
    throw new HTTPException(500, { message: "Failed to fetch collection items" })
  }
})

router.get(
  "/knowledge-base/:collectionId/items/:itemId/content",
  AdminMiddleware,
  async (c) => {
    try {
      const collectionId = c.req.param("collectionId")
      const itemId = c.req.param("itemId")

      const [item] = await db
        .select({
          id: collectionItems.id,
          type: collectionItems.type,
          storagePath: collectionItems.storagePath,
          originalName: collectionItems.originalName,
          mimeType: collectionItems.mimeType,
        })
        .from(collectionItems)
        .leftJoin(workspaces, eq(collectionItems.workspaceId, workspaces.id))
        .where(
          and(
            eq(collectionItems.id, itemId),
            // Bind to the :collectionId path param + scope to the caller's
            // workspace via the item's workspace (#5); previously read any itemId.
            eq(collectionItems.collectionId, collectionId),
            eq(collectionItems.type, "file"),
            isNull(collectionItems.deletedAt),
            eq(workspaces.externalId, c.get("jwtPayload").workspaceId),
          ),
        )
        .limit(1)

      if (!item?.storagePath) {
        throw new HTTPException(404, { message: "File not found" })
      }

      let fileStats: Awaited<ReturnType<typeof stat>>
      try {
        fileStats = await stat(item.storagePath)
      } catch {
        throw new HTTPException(404, { message: "File not found on disk" })
      }

      const fileSize = fileStats.size
      const mimeType = item.mimeType ?? "application/octet-stream"
      const dispositionName = encodeURIComponent(item.originalName ?? "file")
      const baseHeaders: Record<string, string> = {
        // Same XSS hardening as the KB route — mimeType is attacker-influenced.
        ...safeFileServeHeaders(mimeType, dispositionName),
        "Cache-Control": "private, max-age=3600",
        "Accept-Ranges": "bytes",
      }

      const range = c.req.header("range")
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range)
        if (!m) throw new HTTPException(416, { message: "Invalid range" })
        const start = m[1] ? parseInt(m[1], 10) : 0
        const end = m[2] ? parseInt(m[2], 10) : fileSize - 1
        if (
          Number.isNaN(start) ||
          Number.isNaN(end) ||
          start > end ||
          end >= fileSize
        ) {
          return new Response("Range Not Satisfiable", {
            status: 416,
            headers: { "Content-Range": `bytes */${String(fileSize)}` },
          })
        }
        const chunkSize = end - start + 1
        const sp = item.storagePath
        return stream(c, async (w) => {
          c.header(
            "Content-Range",
            `bytes ${String(start)}-${String(end)}/${String(fileSize)}`,
          )
          c.header("Content-Length", String(chunkSize))
          for (const [k, v] of Object.entries(baseHeaders)) c.header(k, v)
          c.status(206)
          const rs = createReadStream(sp, {
            start,
            end,
            highWaterMark: 64 * 1024,
          })
          for await (const chunk of rs) {
            await w.write(chunk as Uint8Array)
          }
        })
      }

      const sp = item.storagePath
      return stream(c, async (w) => {
        c.header("Content-Length", String(fileSize))
        for (const [k, v] of Object.entries(baseHeaders)) c.header(k, v)
        const rs = createReadStream(sp, { highWaterMark: 64 * 1024 })
        for await (const chunk of rs) {
          await w.write(chunk as Uint8Array)
        }
      })
    } catch (error) {
      if (error instanceof HTTPException) throw error
      Logger.error(error, "Error serving admin KB file")
      throw new HTTPException(500, { message: "Failed to serve file" })
    }
  },
)

// ── Model usage ───────────────────────────────────────────────────────────────

router.get("/models", AdminMiddleware, async (c) => {
  try {
    const rows = await db
      .select({
        model: v2ChatRuns.model,
        runCount: count(v2ChatRuns.id),
        errorCount: sql<number>`COUNT(CASE WHEN ${v2ChatRuns.status} = 'errored' THEN 1 END)::int`,
        avgLatencyMs: sql<number>`ROUND(AVG(CASE WHEN ${v2ChatRuns.endedAt} IS NOT NULL THEN ${v2ChatRuns.endedAt} - ${v2ChatRuns.startedAt} END))::int`,
        totalTokens: sql<number>`COALESCE(SUM(
          COALESCE((m.stats->'tokenUsage'->>'input')::int, 0) +
          COALESCE((m.stats->'tokenUsage'->>'output')::int, 0) +
          COALESCE((m.stats->'tokenUsage'->>'cacheRead')::int, 0)
        ), 0)::bigint`,
      })
      .from(v2ChatRuns)
      .leftJoin(
        sql`v2_chat_messages m`,
        sql`m.run_id = ${v2ChatRuns.id} AND m.stats IS NOT NULL AND m.role = 'assistant'`,
      )
      .groupBy(v2ChatRuns.model)
      .orderBy(desc(count(v2ChatRuns.id)))

    return c.json({
      models: rows.map((r) => ({
        model: r.model,
        runCount: r.runCount,
        errorCount: r.errorCount,
        errorPct:
          r.runCount > 0
            ? Math.round((r.errorCount / r.runCount) * 100)
            : 0,
        avgLatencyMs: r.avgLatencyMs ?? 0,
        totalTokens: Number(r.totalTokens) || 0,
      })),
    })
  } catch (error) {
    Logger.error(error, "Error fetching model usage")
    throw new HTTPException(500, { message: "Failed to fetch model usage" })
  }
})

// ── Tool usage ────────────────────────────────────────────────────────────────

router.get("/tools", AdminMiddleware, async (c) => {
  try {
    const rows = await db
      .select({
        toolName: v2ChatToolCalls.toolName,
        calls: count(v2ChatToolCalls.id),
        errors: sql<number>`COUNT(CASE WHEN ${v2ChatToolCalls.isError} = true THEN 1 END)::int`,
        avgDurationMs: sql<number>`ROUND(AVG(CASE WHEN ${v2ChatToolCalls.completedAt} IS NOT NULL THEN ${v2ChatToolCalls.completedAt} - ${v2ChatToolCalls.startedAt} END))::int`,
      })
      .from(v2ChatToolCalls)
      .groupBy(v2ChatToolCalls.toolName)
      .orderBy(desc(count(v2ChatToolCalls.id)))

    return c.json({
      tools: rows.map((r) => ({
        toolName: r.toolName,
        calls: r.calls,
        errors: r.errors,
        errorPct: r.calls > 0 ? Math.round((r.errors / r.calls) * 100) : 0,
        avgDurationMs: r.avgDurationMs ?? 0,
      })),
    })
  } catch (error) {
    Logger.error(error, "Error fetching tool usage")
    throw new HTTPException(500, { message: "Failed to fetch tool usage" })
  }
})

// ── Tool error drill-down ─────────────────────────────────────────────────────

router.get("/tools/:toolName/errors", AdminMiddleware, async (c) => {
  try {
    const toolName = decodeURIComponent(c.req.param("toolName"))

    const [errorRows, topErrors] = await Promise.all([
      db
        .select({
          id: v2ChatToolCalls.id,
          runId: v2ChatToolCalls.runId,
          conversationId: v2ChatToolCalls.conversationId,
          conversationTitle: v2ChatConversations.title,
          ownerEmail: v2ChatConversations.ownerId,
          startedAt: v2ChatToolCalls.startedAt,
          completedAt: v2ChatToolCalls.completedAt,
          args: v2ChatToolCalls.args,
          result: v2ChatToolCalls.result,
        })
        .from(v2ChatToolCalls)
        .innerJoin(
          v2ChatConversations,
          eq(v2ChatToolCalls.conversationId, v2ChatConversations.id),
        )
        .where(
          and(
            eq(v2ChatToolCalls.toolName, toolName),
            eq(v2ChatToolCalls.isError, true),
            // Scope to the caller's workspace (#5).
            eq(v2ChatConversations.workspaceId, c.get("jwtPayload").workspaceId),
          ),
        )
        .orderBy(desc(v2ChatToolCalls.startedAt))
        .limit(30),

      db
        .select({
          ownerEmail: v2ChatConversations.ownerId,
          errorCount: count(),
        })
        .from(v2ChatToolCalls)
        .innerJoin(
          v2ChatConversations,
          eq(v2ChatToolCalls.conversationId, v2ChatConversations.id),
        )
        .where(
          and(
            eq(v2ChatToolCalls.toolName, toolName),
            eq(v2ChatToolCalls.isError, true),
            // Scope to the caller's workspace (#5).
            eq(v2ChatConversations.workspaceId, c.get("jwtPayload").workspaceId),
          ),
        )
        .groupBy(v2ChatConversations.ownerId)
        .orderBy(desc(count()))
        .limit(10),
    ])

    return c.json({ toolName, errors: errorRows, topAffectedUsers: topErrors })
  } catch (error) {
    if (error instanceof HTTPException) throw error
    Logger.error(error, "Error fetching tool error details")
    throw new HTTPException(500, { message: "Failed to fetch tool errors" })
  }
})

// ── Deep Debug ────────────────────────────────────────────────────────────────
// Aggregates run errors, tool failures, and debug events for a user to diagnose
// "I didn't get a response" / "tool X is broken".

router.get("/deep-debug", AdminMiddleware, async (c) => {
  try {
    const userEmail = c.req.query("userEmail")
    if (!userEmail) {
      throw new HTTPException(400, { message: "userEmail query param is required" })
    }
    // Verify the target user is in the caller's workspace (#5) before
    // aggregating their runs/tool-calls — otherwise a workspace-A admin could
    // deep-debug any user by email.
    const [targetUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.email, userEmail),
          eq(users.workspaceExternalId, c.get("jwtPayload").workspaceId),
        ),
      )
      .limit(1)
    if (!targetUser) {
      throw new HTTPException(404, { message: "User not found" })
    }

    const [erroredRuns, failedToolCalls, statsRows, abortedRows] =
      await Promise.all([
        db
          .select({
            id: v2ChatRuns.id,
            conversationId: v2ChatRuns.conversationId,
            conversationTitle: v2ChatConversations.title,
            status: v2ChatRuns.status,
            model: v2ChatRuns.model,
            agentId: v2ChatRuns.agentId,
            agentName: agents.name,
            startedAt: v2ChatRuns.startedAt,
            endedAt: v2ChatRuns.endedAt,
            error: v2ChatRuns.error,
            tokensIn: v2ChatRuns.tokensIn,
            tokensOut: v2ChatRuns.tokensOut,
          })
          .from(v2ChatRuns)
          .innerJoin(
            v2ChatConversations,
            eq(v2ChatRuns.conversationId, v2ChatConversations.id),
          )
          .leftJoin(agents, eq(v2ChatRuns.agentId, agents.externalId))
          .where(
            and(
              eq(v2ChatConversations.ownerId, userEmail),
              sql`${v2ChatRuns.status} IN ('errored', 'aborted')`,
            ),
          )
          .orderBy(desc(v2ChatRuns.startedAt))
          .limit(30),

        db
          .select({
            id: v2ChatToolCalls.id,
            toolName: v2ChatToolCalls.toolName,
            conversationId: v2ChatToolCalls.conversationId,
            conversationTitle: v2ChatConversations.title,
            runId: v2ChatToolCalls.runId,
            startedAt: v2ChatToolCalls.startedAt,
            completedAt: v2ChatToolCalls.completedAt,
            result: v2ChatToolCalls.result,
          })
          .from(v2ChatToolCalls)
          .innerJoin(
            v2ChatConversations,
            eq(v2ChatToolCalls.conversationId, v2ChatConversations.id),
          )
          .where(
            and(
              eq(v2ChatConversations.ownerId, userEmail),
              eq(v2ChatToolCalls.isError, true),
            ),
          )
          .orderBy(desc(v2ChatToolCalls.startedAt))
          .limit(30),

        db
          .select({
            total: count(),
            errored: sql<number>`COUNT(CASE WHEN ${v2ChatRuns.status} = 'errored' THEN 1 END)::int`,
            avgDurationMs: sql<number>`ROUND(AVG(CASE WHEN ${v2ChatRuns.endedAt} IS NOT NULL THEN ${v2ChatRuns.endedAt} - ${v2ChatRuns.startedAt} END))::int`,
          })
          .from(v2ChatRuns)
          .innerJoin(
            v2ChatConversations,
            eq(v2ChatRuns.conversationId, v2ChatConversations.id),
          )
          .where(eq(v2ChatConversations.ownerId, userEmail)),

        db
          .select({ aborted: count() })
          .from(v2ChatRuns)
          .innerJoin(
            v2ChatConversations,
            eq(v2ChatRuns.conversationId, v2ChatConversations.id),
          )
          .where(
            and(
              eq(v2ChatConversations.ownerId, userEmail),
              sql`${v2ChatRuns.status} = 'aborted'`,
            ),
          ),
      ])

    // Silent failures: run "succeeded" but the assistant message has no visible text.
    const silentFailures = await db
      .select({
        runId: v2ChatMessages.runId,
        conversationId: v2ChatMessages.conversationId,
        conversationTitle: v2ChatConversations.title,
        createdAt: v2ChatMessages.createdAt,
        blocks: v2ChatMessages.blocks,
        stats: v2ChatMessages.stats,
      })
      .from(v2ChatMessages)
      .innerJoin(
        v2ChatConversations,
        eq(v2ChatMessages.conversationId, v2ChatConversations.id),
      )
      .where(
        and(
          eq(v2ChatConversations.ownerId, userEmail),
          eq(v2ChatMessages.role, "assistant"),
          sql`NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(${v2ChatMessages.blocks}) AS b
            WHERE b->>'kind' = 'text' AND length(b->>'text') > 10
          )`,
        ),
      )
      .orderBy(desc(v2ChatMessages.createdAt))
      .limit(20)

    const highRetryMessages = await db
      .select({
        runId: v2ChatMessages.runId,
        conversationId: v2ChatMessages.conversationId,
        conversationTitle: v2ChatConversations.title,
        createdAt: v2ChatMessages.createdAt,
        stats: v2ChatMessages.stats,
      })
      .from(v2ChatMessages)
      .innerJoin(
        v2ChatConversations,
        eq(v2ChatMessages.conversationId, v2ChatConversations.id),
      )
      .where(
        and(
          eq(v2ChatConversations.ownerId, userEmail),
          eq(v2ChatMessages.role, "assistant"),
          sql`(${v2ChatMessages.stats}->'retryAttempts')::int > 0`,
        ),
      )
      .orderBy(desc(v2ChatMessages.createdAt))
      .limit(20)

    const compactionIssues = await db
      .select({
        runId: v2ChatMessages.runId,
        conversationId: v2ChatMessages.conversationId,
        conversationTitle: v2ChatConversations.title,
        createdAt: v2ChatMessages.createdAt,
        stats: v2ChatMessages.stats,
      })
      .from(v2ChatMessages)
      .innerJoin(
        v2ChatConversations,
        eq(v2ChatMessages.conversationId, v2ChatConversations.id),
      )
      .where(
        and(
          eq(v2ChatConversations.ownerId, userEmail),
          eq(v2ChatMessages.role, "assistant"),
          sql`(${v2ChatMessages.stats}->'compactionRounds')::int > 1`,
        ),
      )
      .orderBy(desc(v2ChatMessages.createdAt))
      .limit(20)

    // Same run error hitting multiple users.
    const crossUserErrors = await db
      .select({
        error: v2ChatRuns.error,
        affectedUsers: sql<number>`COUNT(DISTINCT ${v2ChatConversations.ownerId})::int`,
        occurrences: count(),
        lastSeen: sql<number>`MAX(${v2ChatRuns.startedAt})`,
      })
      .from(v2ChatRuns)
      .innerJoin(
        v2ChatConversations,
        eq(v2ChatRuns.conversationId, v2ChatConversations.id),
      )
      .where(
        and(
          sql`${v2ChatRuns.status} = 'errored'`,
          sql`${v2ChatRuns.error} IS NOT NULL`,
        ),
      )
      .groupBy(v2ChatRuns.error)
      .having(sql`COUNT(DISTINCT ${v2ChatConversations.ownerId}) > 1`)
      .orderBy(desc(sql`COUNT(DISTINCT ${v2ChatConversations.ownerId})`))
      .limit(10)

    const stats = statsRows[0]
    const totalRuns = Number(stats?.total ?? 0)
    const erroredCount = Number(stats?.errored ?? 0)
    const abortedCount = Number(abortedRows[0]?.aborted ?? 0)

    return c.json({
      stats: {
        totalRuns,
        erroredRuns: erroredCount,
        abortedRuns: abortedCount,
        errorRate:
          totalRuns > 0
            ? Math.round(((erroredCount + abortedCount) / totalRuns) * 100)
            : 0,
        failedToolCalls: failedToolCalls.length,
        silentFailures: silentFailures.length,
        highRetries: highRetryMessages.length,
        avgDurationMs: stats?.avgDurationMs ?? 0,
      },
      erroredRuns: erroredRuns.map((r) => ({
        ...r,
        durationMs: r.endedAt && r.startedAt ? r.endedAt - r.startedAt : null,
      })),
      failedToolCalls,
      silentFailures: silentFailures.map((m) => ({
        ...m,
        stats: m.stats as Record<string, unknown> | null,
      })),
      highRetryMessages: highRetryMessages.map((m) => ({
        ...m,
        stats: m.stats as Record<string, unknown> | null,
      })),
      compactionIssues: compactionIssues.map((m) => ({
        ...m,
        stats: m.stats as Record<string, unknown> | null,
      })),
      crossUserErrors,
    })
  } catch (error) {
    if (error instanceof HTTPException) throw error
    Logger.error(error, "Error fetching deep debug data")
    throw new HTTPException(500, { message: "Failed to fetch debug data" })
  }
})

// ── Vespa Search (Admin Debug) ────────────────────────────────────────────────
// Direct Vespa query — bypasses user-scoped pipeline so admins see raw match
// features, scores, and chunks.

type VespaSearchAdminRequest = {
  query: string
  schema?: string
  rankProfile?: string
  limit?: number
  offset?: number
  useLLM?: boolean
  alpha?: number   // 0 = pure BM25, 1 = pure vector, default 0.5
  agentId?: string
  model?: string
  summaryChunks?: number
}

function projectVespaHit(
  hit: Record<string, unknown>,
): Record<string, unknown> {
  const fields = (hit['fields'] ?? {}) as Record<string, unknown>
  const mf = (fields['matchfeatures'] ?? {}) as Record<string, unknown>
  const cellsRaw = (mf?.['chunk_scores'] as Record<string, unknown> | undefined)
    ?.['cells']
  const cells =
    cellsRaw && typeof cellsRaw === "object"
      ? (cellsRaw as Record<string, number>)
      : {}

  const matched = Object.entries(cells)
    .map(([k, v]) => ({ index: Number(k), score: Number(v) }))
    .sort((a, b) => b.score - a.score)
    .map(({ index, score }) => {
      // chunk_scores cell labels are ORIGINAL chunk indices. snippetForLeanChunk
      // maps the pruned `top_chunks_summary` back to those indices (falling back
      // to legacy `chunks_summary`); chunks outside the pruned top-N are null —
      // raise input.query(summary_chunks) for more.
      const text = snippetForLeanChunk(fields, index) || null
      return { index, score, text }
    })

  return {
    docId: fields['docId'],
    fileName: fields['fileName'],
    pageTitle: fields['pageTitle'],
    mimeType: fields['mimeType'],
    updatedAt: fields['updatedAt'],
    description: fields['description'],
    relevance: hit['relevance'],
    matchFeatures: mf,
    matchedChunks: matched,
    chunksSummary: fields['chunks_summary'] ?? fields['top_chunks_summary'],
    client: fields['client'] ?? fields['dataSourceId'] ?? fields['workspaceId'] ?? null,
    source: fields['source'] ?? null,
    namespace: hit["id"],
  }
}

router.post("/vespa-search", AdminMiddleware, async (c) => {
  const { queryEndpoint } = config.vespaEndpoint
  const searchUrl = `${queryEndpoint}/search/`

  try {
    const body = (await c.req.json()) as VespaSearchAdminRequest
    if (!body?.query?.trim()) {
      throw new HTTPException(400, { message: "query is required" })
    }

    const schema = "kb_items"
    const limit = Math.min(Math.max(1, body.limit ?? 20), 200)
    const offset = Math.max(0, body.offset ?? 0)
    const alpha = typeof body.alpha === "number" ? Math.max(0, Math.min(1, body.alpha)) : 0.5
    const rankProfile = body.rankProfile ??  "default_native"
    const targetHits = Math.max(limit, 200)
    const summaryChunks =
      typeof body.summaryChunks === "number" && body.summaryChunks >= 1
        ? Math.floor(body.summaryChunks)
        : 5

    // Optional agent scoping.
    let agentDocFilter = ""
    if (body.agentId) {
      try {
        const email = c.get("jwtPayload").sub
        const workspaceExternalId = c.get("jwtPayload").workspaceId
        const uw = await getUserAndWorkspaceByEmail(db, workspaceExternalId, email)
        if (uw?.workspace) {
          const agent = await getAgentByExternalId(db, body.agentId, uw.workspace.id)
          const docIds = (agent?.docIds as Array<{ docId: string }> | null) ?? []
          if (docIds.length > 0) {
            const ids = docIds.map((d) => yqlString(d.docId)).join(", ")
            agentDocFilter = ` and docId in (${ids})`
          }
        }
      } catch {
        // agent lookup failure is non-fatal — proceed without filter
      }
    }

    let vespaBody: Record<string, unknown>

    const yql =
        `select * from ${schema} where ` +
        `(({targetHits:${String(targetHits)}}nearestNeighbor(chunk_embeddings, e)) or userInput(@query))` +
        agentDocFilter
      vespaBody = {
        yql,
        query: body.query,
        "input.query(e)": "embed(@query)",
        "input.query(alpha)": alpha,
        "input.query(recency_decay_rate)": 0.02,
        "ranking.profile": rankProfile ,
        "presentation.summary": "lean",
        "input.query(summary_chunks)": summaryChunks,
        hits: limit,
        offset,
        timeout: "30s",
      }

    const t0 = Date.now()
    const resp = await fetch(searchUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(vespaBody),
    })
    const vespaQueryMs = Date.now() - t0

    if (!resp.ok) {
      const text = await resp.text().catch(() => "")
      throw new HTTPException(502, {
        message: `Vespa ${String(resp.status)}: ${text.slice(0, 400)}`,
      })
    }

    const parsed = (await resp.json()) as Record<string, unknown>
    const root = (parsed?.['root'] ?? {}) as Record<string, unknown>
    const warnings = ((root['errors'] ?? []) as Array<Record<string, string>>).map(
      (e) => `${e['summary'] ?? "warn"}: ${e['message'] ?? ""}`,
    )

    const children = (root['children'] ?? []) as Array<Record<string, unknown>>
    const results = children.map((hit) => projectVespaHit(hit))

    return c.json({
      results,
      totalCount: (root['fields'] as Record<string, unknown>)?.['totalCount'] ?? results.length,
      profile: rankProfile,
      schema,
      vespaQueryMs,
      vespaQuery: vespaBody,
      warnings,
      vespaUrl: searchUrl,
    })
  } catch (error) {
    if (error instanceof HTTPException) throw error
    const msg = error instanceof Error ? error.message : String(error)
    Logger.error(error, "Error in admin vespa search")
    throw new HTTPException(500, { message: `Vespa search failed (${searchUrl}): ${msg}` })
  }
})

// ── Vespa + LLM streaming (Admin Debug) ──────────────────────────────────────

// Run a raw YQL string against Vespa.
async function runYql(
  yql: string, query: string, rankProfile: string, limit: number, alpha: number,
  searchUrl: string,
): Promise<{ hits: Record<string, unknown>[]; totalCount: number; ms: number }> {
  const vespaBody: Record<string, unknown> = {
    yql, query,
    "input.query(e)": "embed(@query)",
    "input.query(alpha)": alpha,
    "input.query(recency_decay_rate)": 0.02,
    "ranking.profile": rankProfile,
    hits: limit, offset: 0, timeout: "30s",
  }
  const t0 = Date.now()
  const resp = await fetch(searchUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(vespaBody),
  })
  const ms = Date.now() - t0
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "")
    throw new Error(`Vespa ${String(resp.status)}: ${txt.slice(0, 300)}`)
  }
  const parsed = (await resp.json()) as Record<string, unknown>
  const root = (parsed?.["root"] ?? {}) as Record<string, unknown>
  const children = (root?.["children"] ?? []) as Array<Record<string, unknown>>
  const totalCount = Number((root?.["fields"] as Record<string, unknown>)?.["totalCount"] ?? children.length)
  const hits = children.map((h) => projectVespaHit(h))
  return { hits, totalCount, ms }
}

// Stream LLM tokens.
async function streamLlmTokens(
  llmUrl: string, apiKey: string, model: string, messages: unknown[],
  w: { writeln: (s: string) => Promise<void> },
): Promise<void> {
  let llmResp: Response
  try {
    llmResp = await fetch(llmUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, stream: true }),
    })
  } catch (e) {
    await w.writeln(JSON.stringify({ type: "error", message: `LLM unreachable: ${String(e)}` }))
    return
  }
  if (!llmResp.ok) {
    const txt = await llmResp.text().catch(() => "")
    await w.writeln(JSON.stringify({ type: "error", message: `LLM ${String(llmResp.status)}: ${txt.slice(0, 300)}` }))
    return
  }
  const reader = llmResp.body?.getReader()
  if (!reader) { await w.writeln(JSON.stringify({ type: "error", message: "No response body from LLM" })); return }
  const dec = new TextDecoder()
  let buf = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("data:")) continue
      const data = trimmed.slice(5).trim()
      if (data === "[DONE]") { await w.writeln(JSON.stringify({ type: "done" })); return }
      try {
        const ev = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }> }
        const token = ev.choices?.[0]?.delta?.content ?? ev.choices?.[0]?.delta?.reasoning_content ?? ""
        if (token) await w.writeln(JSON.stringify({ type: "token", text: token }))
      } catch { /* skip */ }
    }
  }
  await w.writeln(JSON.stringify({ type: "done" }))
}

// /vespa-llm lets the model emit free-form YQL; a crafted question can steer it
// toward another source/schema. Accept only a single SELECT whose FROM target is
// exactly the intended schema.
const yqlTargetsSchema = (yql: string, schema: string): boolean => {
  const norm = yql.trim().replace(/\s+/g, " ")
  if (!/^select\b/i.test(norm) || norm.includes(";")) return false
  const m = norm.match(/\bfrom\s+(?:sources\s+)?(\S+)\s+where\b/i)
  return m !== null && m[1]!.toLowerCase() === schema.toLowerCase()
}

// Every bareword the model's YQL may reference: query keywords, the kb_items
// schema, the advertised filterable/display fields, and the hybrid-search
// constructs + bound params. Anything else (another schema, an invented field,
// or an unlisted function) makes the query fail closed to the safe default —
// so the model is constrained to an allowlisted surface, not free-form YQL.
const YQL_ALLOWED_IDENTIFIERS = new Set([
  "select", "from", "sources", "where", "and", "or", "not", "in", "contains",
  "matches", "true", "false",
  "kb_items",
  "fileName", "app", "entity", "docId", "clFd", "chunk_embeddings", "pageTitle",
  "title",
  "nearestNeighbor", "userInput", "targetHits", "e", "query",
])
const yqlIdentifiersAllowlisted = (yql: string): boolean => {
  // Drop quoted string literals first so filter VALUES can't smuggle identifiers.
  const noStrings = yql.replace(/"(?:[^"\\]|\\.)*"/g, '""')
  const idents = noStrings.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []
  return idents.every(
    (id) =>
      YQL_ALLOWED_IDENTIFIERS.has(id) ||
      YQL_ALLOWED_IDENTIFIERS.has(id.toLowerCase()),
  )
}

router.post("/vespa-llm", AdminMiddleware, async (c) => {
  const { queryEndpoint } = config.vespaEndpoint

  try {
    const body = (await c.req.json()) as VespaSearchAdminRequest & { systemPrompt?: string; agentId?: string }
    if (!body?.query?.trim()) throw new HTTPException(400, { message: "query is required" })
    if (!config.LiteLLMBaseUrl || !config.LiteLLMApiKey) {
      throw new HTTPException(503, { message: "LLM not configured (LITELLM_BASE_URL / LITELLM_API_KEY missing)" })
    }

    const schema      = "kb_items"
    const rankProfile = body.rankProfile ?? "default_native"
    const limit       = Math.min(Math.max(1, body.limit ?? 20), 200)
    const alpha       = typeof body.alpha === "number" ? Math.max(0, Math.min(1, body.alpha)) : 0.5
    const searchUrl   = `${queryEndpoint}/search/`
    const llmUrl      = `${config.LiteLLMBaseUrl.replace(/\/+$/, "")}/v1/chat/completions`
    const model       = body.model?.trim() || config.defaultBestModel
    const targetHits  = Math.max(limit, 200)

    // Only the editable textarea prompt is sent; selecting an agent pre-fills it
    // but agents are never modified.
    const systemContent =
      body.systemPrompt?.trim() ||
      "You are a precise search assistant. Answer the user's question based strictly on the retrieved document context."

    const tools = [
      {
        type: "function",
        function: {
          name: "run_vespa_query",
          description:
            "Execute a Vespa YQL query against the kb_items document index and retrieve relevant text chunks. " +
            "Use this to find information needed to answer the user's question. " +
            "Always include userInput(@query) for full-text matching. " +
            "You may add field filters: fileName contains \"report\", app = \"google\", entity = \"user@example.com\". " +
            `Filterable fields: fileName, app, entity, docId, clFd. Schema: ${schema}.`,
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  "Optimized search query string for Vespa text matching (replaces @query in userInput). " +
                  "Rewrite the raw user question into a dense keyword query: " +
                  "expand abbreviations (e.g. an acronym → the acronym OR its expanded form), " +
                  "add synonyms with OR, remove filler words. Keep domain terms exact.",
              },
              yql: {
                type: "string",
                description:
                  `Vespa YQL query. Must select from ${schema}. ` +
                  `Example: select * from ${schema} where ({targetHits:${String(targetHits)}}nearestNeighbor(chunk_embeddings, e)) or userInput(@query)`,
              },
              reasoning: {
                type: "string",
                description: "One sentence explaining why this query will retrieve relevant results.",
              },
            },
            required: ["query", "yql"],
          },
        },
      },
    ]

    // LLM rewrites query + generates YQL (non-streaming tool call).
    const step1Resp = await fetch(llmUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.LiteLLMApiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemContent },
          {
            role: "user",
            content:
              `User question: "${body.query}"\n\n` +
              `Call run_vespa_query with:\n` +
              `1. query: an optimized keyword search query (expand abbreviations, add synonyms with OR, remove filler words)\n` +
              `2. yql: a Vespa YQL using nearestNeighbor + userInput(@query) for hybrid search\n` +
              `Add field filters only when the question clearly requires them.`,
          },
        ],
        tools,
        tool_choice: { type: "function", function: { name: "run_vespa_query" } },
      }),
    })

    if (!step1Resp.ok) {
      const txt = await step1Resp.text().catch(() => "")
      throw new HTTPException(502, { message: `LLM tool-call step failed: ${txt.slice(0, 300)}` })
    }

    const step1Json = (await step1Resp.json()) as {
      choices?: Array<{
        message?: {
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
        }
      }>
    }

    const toolCall = step1Json.choices?.[0]?.message?.tool_calls?.[0]

    // Fall back to defaults if the LLM didn't call the tool.
    let toolCallQuery: string
    let toolCallYql: string
    let toolCallReasoning: string | undefined

    if (toolCall) {
      try {
        const args = JSON.parse(toolCall.function.arguments) as { query?: string; yql?: string; reasoning?: string }
        toolCallQuery    = args.query?.trim() || body.query
        toolCallYql      = args.yql?.trim()   || `select * from ${schema} where ({targetHits:${String(targetHits)}}nearestNeighbor(chunk_embeddings, e)) or userInput(@query)`
        toolCallReasoning = args.reasoning
      } catch {
        toolCallQuery = body.query
        toolCallYql   = `select * from ${schema} where ({targetHits:${String(targetHits)}}nearestNeighbor(chunk_embeddings, e)) or userInput(@query)`
      }
    } else {
      toolCallQuery = body.query
      toolCallYql   = `select * from ${schema} where ({targetHits:${String(targetHits)}}nearestNeighbor(chunk_embeddings, e)) or userInput(@query)`
    }

    // Guardrail: the model's YQL must target kb_items AND reference only
    // allowlisted fields/constructs; anything else falls back to the safe
    // hybrid-search default. Constrains the model to a fixed field surface rather
    // than executing free-form model YQL (report #16).
    if (
      !yqlTargetsSchema(toolCallYql, schema) ||
      !yqlIdentifiersAllowlisted(toolCallYql)
    ) {
      Logger.warn({ yql: toolCallYql }, "vespa-llm: model YQL rejected (target or fields not allowlisted) — using safe default")
      toolCallYql = `select * from ${schema} where ({targetHits:${String(targetHits)}}nearestNeighbor(chunk_embeddings, e)) or userInput(@query)`
    }

    const { hits, totalCount, ms: vespaMs } = await runYql(
      toolCallYql, toolCallQuery, rankProfile, limit, alpha, searchUrl,
    )

    const contextChunks: string[] = []
    for (const hit of hits) {
      const name = (hit["fileName"] ?? hit["pageTitle"] ?? hit["docId"] ?? "Unknown") as string
      const chunks = (hit["matchedChunks"] as Array<{ text: string | null; score: number; index: number }>)
        .slice(0, 3).filter((ch) => ch.text)
        .map((ch) => `[${name} #${String(ch.index)} score=${ch.score.toFixed(3)}]\n${ch.text!}`)
      contextChunks.push(...chunks)
      if (contextChunks.length >= 20) break
    }

    const step2Messages: unknown[] = [
      { role: "system", content: systemContent },
      { role: "user", content: `Question: ${body.query}` },
      ...(toolCall
        ? [{ role: "assistant", content: null, tool_calls: [toolCall] }]
        : []),
      ...(toolCall
        ? [{
            role: "tool",
            tool_call_id: toolCall.id,
            content: contextChunks.length > 0
              ? contextChunks.join("\n\n---\n\n")
              : "(no matching documents found)",
          }]
        : []),
      // No tool call: inject context directly.
      ...(!toolCall
        ? [{
            role: "user",
            content: `Document context:\n${contextChunks.join("\n\n---\n\n") || "(none)"}`,
          }]
        : []),
      {
        role: "user",
        content: "Answer the original question based on the search results. Be concise. Cite document names.",
      },
    ]

    return stream(c, async (w) => {
      await w.writeln(JSON.stringify({
        type: "system_prompt",
        content: systemContent,
        agentId: body.agentId ?? null,
        model,
      }))
      await w.writeln(JSON.stringify({
        type: "tool_call",
        query: toolCallQuery,
        yql: toolCallYql,
        reasoning: toolCallReasoning ?? null,
      }))
      await w.writeln(JSON.stringify({
        type: "tool_result",
        count: hits.length,
        total: totalCount,
        ms: vespaMs,
        chunks: contextChunks.length,
        profile: rankProfile,
        results: hits,
        vespaQuery: {
          yql: toolCallYql,
          query: toolCallQuery,
          "ranking.profile": rankProfile,
          "input.query(alpha)": alpha,
          hits: limit,
          offset: 0,
          timeout: "30s",
          "input.query(recency_decay_rate)": 0.02,
        },
      }))
      // Wrap `w` so writeln matches the helper's Promise<void> contract
      // (StreamingApi.writeln returns Promise<this>).
      await streamLlmTokens(llmUrl, config.LiteLLMApiKey, model, step2Messages, {
        writeln: async (s: string) => {
          await w.writeln(s)
        },
      })
    })

  } catch (error) {
    if (error instanceof HTTPException) throw error
    const msg = error instanceof Error ? error.message : String(error)
    Logger.error(error, "Error in admin vespa-llm")
    throw new HTTPException(500, { message: `LLM search failed: ${msg}` })
  }
})

// ── Vespa rank-profile discovery (parsed live from kb_items.sd) ──────────────

type RankProfileInfo = { name: string; body: string }

function parseRankProfiles(sdl: string): RankProfileInfo[] {
  const results: RankProfileInfo[] = []
  const lineRe = /^[ \t]*rank-profile\s+(\w+)/gm
  let m: RegExpExecArray | null

  while ((m = lineRe.exec(sdl)) !== null) {
    const name = m[1]!
    if (name === "initial") continue   // base template — skip

    let pos = m.index + m[0].length
    while (pos < sdl.length && sdl[pos] !== "{") pos++
    if (pos >= sdl.length) continue

    let depth = 0
    const start = pos
    let end = pos
    while (end < sdl.length) {
      if (sdl[end] === "{") depth++
      else if (sdl[end] === "}") {
        depth--
        if (depth === 0) break
      }
      end++
    }

    const body = sdl.slice(start + 1, end).trimEnd()

    results.push({ name, body })
  }

  return results
}

const KB_ITEMS_SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../vespa/schemas/kb_items.sd",
)

// ── Vespa debug system prompt (per-user persistence) ─────────────────────────

router.get("/vespa-system-prompt", AdminMiddleware, async (c) => {
  try {
    const email = c.get("jwtPayload").sub
    const workspaceExternalId = c.get("jwtPayload").workspaceId
    const uw = await getUserAndWorkspaceByEmail(db, workspaceExternalId, email)
    if (!uw?.user) throw new HTTPException(404, { message: "User not found" })

    const row = await db.query.userPersonalization.findFirst({
      where: eq(userPersonalization.userId, uw.user.id),
      columns: { vespaSystemPrompt: true },
    })

    return c.json({ prompt: row?.vespaSystemPrompt ?? null })
  } catch (error) {
    if (error instanceof HTTPException) throw error
    Logger.error(error, "Error fetching vespa system prompt")
    throw new HTTPException(500, { message: "Failed to fetch system prompt" })
  }
})

router.put("/vespa-system-prompt", AdminMiddleware, async (c) => {
  try {
    const email = c.get("jwtPayload").sub
    const workspaceExternalId = c.get("jwtPayload").workspaceId
    const uw = await getUserAndWorkspaceByEmail(db, workspaceExternalId, email)
    if (!uw?.user || !uw?.workspace) throw new HTTPException(404, { message: "User not found" })

    const body = (await c.req.json()) as { prompt?: string }
    const prompt = typeof body.prompt === "string" ? body.prompt : ""

    await db
      .insert(userPersonalization)
      .values({
        userId: uw.user.id,
        workspaceId: uw.workspace.id,
        email: uw.user.email,
        vespaSystemPrompt: prompt,
      })
      .onConflictDoUpdate({
        target: userPersonalization.userId,
        set: {
          vespaSystemPrompt: prompt,
          updatedAt: sql`NOW()`,
        },
      })

    return c.json({ ok: true })
  } catch (error) {
    if (error instanceof HTTPException) throw error
    Logger.error(error, "Error saving vespa system prompt")
    throw new HTTPException(500, { message: "Failed to save system prompt" })
  }
})

router.get("/vespa-rank-profiles", AdminMiddleware, async (c) => {
  try {
    const sdl = await readFile(KB_ITEMS_SCHEMA_PATH, "utf-8")
    const profiles = parseRankProfiles(sdl)
    return c.json({ profiles })
  } catch (error) {
    Logger.error(error, "Error reading kb_items.sd rank profiles")
    throw new HTTPException(500, { message: "Failed to parse rank profiles from schema" })
  }
})

// ── Abbreviation lookup ───────────────────────────────────────────────────────

router.get("/abbreviations", AdminMiddleware, async (c) => {
  try {
    const q = (c.req.query("q") ?? "").trim()
    if (!q) return c.json({ abbreviations: [] })

    const tokens = q
      .split(/[\s,./\\()\[\]{}<>:;!?@#$%^&*+=|~`'"]+/)
      .map((t) => t.trim().toUpperCase())
      .filter((t) => t.length >= 2)

    if (tokens.length === 0) return c.json({ abbreviations: [] })

    const conditions = tokens.map((token) => ilike(abbreviations.word, token))
    const rows = await db
      .select()
      .from(abbreviations)
      .where(or(...conditions))
      .orderBy(desc(abbreviations.votes))
      .limit(50)

    // Keep highest-voted entry per word.
    const seen = new Map<string, typeof rows[number]>()
    for (const row of rows) {
      const key = row.word.toUpperCase()
      const existing = seen.get(key)
      if (!existing || row.votes > existing.votes) seen.set(key, row)
    }

    return c.json({ abbreviations: Array.from(seen.values()) })
  } catch (error) {
    Logger.error(error, "Error fetching abbreviations")
    throw new HTTPException(500, { message: "Failed to fetch abbreviations" })
  }
})

router.get("/abbreviations/search", AdminMiddleware, async (c) => {
  try {
    const word = (c.req.query("word") ?? "").trim().toUpperCase()
    if (!word) return c.json({ abbreviations: [] })

    const rows = await db
      .select()
      .from(abbreviations)
      .where(ilike(abbreviations.word, word))
      .orderBy(desc(abbreviations.votes))
      .limit(20)

    return c.json({ abbreviations: rows })
  } catch (error) {
    Logger.error(error, "Error searching abbreviations")
    throw new HTTPException(500, { message: "Failed to search abbreviations" })
  }
})

// ── Admin Agent detail (bypasses per-user permission check) ──────────────────

router.get("/agents/:agentId", AdminMiddleware, async (c) => {
  try {
    const externalId = c.req.param("agentId")
    const email = c.get("jwtPayload").sub
    const workspaceExternalId = c.get("jwtPayload").workspaceId
    const uw = await getUserAndWorkspaceByEmail(db, workspaceExternalId, email)
    if (!uw?.workspace) throw new HTTPException(404, { message: "User not found" })

    const agent = await getAgentByExternalId(db, externalId, uw.workspace.id)
    if (!agent) throw new HTTPException(404, { message: "Agent not found" })

    const parsed = selectPublicAgentSchema.parse(agent)

    const permissions = await getAgentUsers(db, agent.id)
    const userEmails: string[] = []
    const ownerEmails: string[] = []
    for (const p of permissions) {
      if (p.role === UserAgentRole.Owner) ownerEmails.push(p.user.email)
      else userEmails.push(p.user.email)
    }

    return c.json({ ...parsed, userEmails, ownerEmails })
  } catch (error) {
    if (error instanceof HTTPException) throw error
    Logger.error(error, "Error fetching admin agent")
    throw new HTTPException(500, { message: "Failed to fetch agent" })
  }
})

router.get("/agents/:agentId/effective-prompt", AdminMiddleware, async (c) => {
  try {
    const externalId = c.req.param("agentId")
    const email = c.get("jwtPayload").sub
    const workspaceExternalId = c.get("jwtPayload").workspaceId
    const uw = await getUserAndWorkspaceByEmail(db, workspaceExternalId, email)
    if (!uw?.workspace) throw new HTTPException(404, { message: "User not found" })

    const agent = await getAgentByExternalId(db, externalId, uw.workspace.id)
    if (!agent) throw new HTTPException(404, { message: "Agent not found" })

    const subAgentRows = await db
      .select({ name: dbSubAgents.name, description: dbSubAgents.description })
      .from(dbSubAgents)
      .where(and(eq(dbSubAgents.parentAgentId, agent.id), isNull(dbSubAgents.deletedAt)))

    const has = (v: string | null | undefined): boolean =>
      typeof v === "string" && v.length > 0

    const sources = {
      main: has(agent.systemPromptMain) ? ("override" as const) : ("default" as const),
      tools: has(agent.systemPromptTools) ? ("override" as const) : ("default" as const),
      subagents: subAgentRows.length === 0
        ? ("suppressed" as const)
        : has(agent.systemPromptSubagents) ? ("override" as const) : ("default" as const),
    }

    const prompt = resolveAgentSystemPrompt({
      systemPromptMain: agent.systemPromptMain,
      systemPromptTools: agent.systemPromptTools,
      systemPromptSubagents: agent.systemPromptSubagents,
      subAgents: subAgentRows,
    })

    return c.json({ prompt, sources })
  } catch (error) {
    if (error instanceof HTTPException) throw error
    Logger.error(error, "Error fetching admin agent effective prompt")
    throw new HTTPException(500, { message: "Failed to fetch effective prompt" })
  }
})

router.get("/agents/:agentId/sub-agents", AdminMiddleware, async (c) => {
  try {
    const externalId = c.req.param("agentId")
    const email = c.get("jwtPayload").sub
    const workspaceExternalId = c.get("jwtPayload").workspaceId
    const uw = await getUserAndWorkspaceByEmail(db, workspaceExternalId, email)
    if (!uw?.workspace) throw new HTTPException(404, { message: "User not found" })

    const agent = await getAgentByExternalId(db, externalId, uw.workspace.id)
    if (!agent) throw new HTTPException(404, { message: "Agent not found" })

    const rows = await db
      .select()
      .from(dbSubAgents)
      .where(and(eq(dbSubAgents.parentAgentId, agent.id), isNull(dbSubAgents.deletedAt)))
      .orderBy(asc(dbSubAgents.createdAt))

    return c.json({
      subAgents: rows.map((r) => ({
        externalId: r.externalId,
        name: r.name,
        description: r.description,
        systemPrompt: r.systemPrompt,
        tools: Array.isArray(r.tools) ? r.tools : [],
        thinkingLevel: r.thinkingLevel ?? "medium",
        createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
        updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : String(r.updatedAt),
      })),
    })
  } catch (error) {
    if (error instanceof HTTPException) throw error
    Logger.error(error, "Error fetching admin agent sub-agents")
    throw new HTTPException(500, { message: "Failed to fetch sub-agents" })
  }
})

// ── Admin KB endpoints (bypass owner-only permission check) ──────────────────

router.get("/kb/collections/:clId/items", AdminMiddleware, async (c) => {
  try {
    const clId = c.req.param("clId")

    const uw = await getUserAndWorkspaceByEmail(
      db,
      c.get("jwtPayload").workspaceId,
      c.get("jwtPayload").sub,
    )
    const collection = await getCollectionById(db, clId)
    // Scope to the caller's workspace (#5) — getCollectionById has no filter.
    if (!collection || collection.workspaceId !== uw.workspace.id) {
      throw new HTTPException(404, { message: "Collection not found" })
    }

    const parentRaw = c.req.query("parentId")
    const parentId = parentRaw && parentRaw !== "" ? parentRaw : null

    const items = await getCollectionItemsByParent(db, clId, parentId)
    let folderCount = 0
    let fileCount = 0
    for (const it of items) {
      if (it.type === "folder") folderCount++
      else fileCount++
    }

    return c.json({
      items: items.map((item) => ({
        id: item.id,
        name: item.name,
        type: item.type,
        parentId: item.parentId,
        path: item.path,
        mimeType: item.mimeType,
        fileSize: item.fileSize,
        uploadStatus: item.uploadStatus,
        updatedAt: item.updatedAt,
        createdAt: item.createdAt,
      })),
      total: items.length,
      folderCount,
      fileCount,
      hasMore: false,
      canWrite: false,
    })
  } catch (error) {
    if (error instanceof HTTPException) throw error
    Logger.error(error, "Error fetching admin KB items")
    throw new HTTPException(500, { message: "Failed to fetch KB items" })
  }
})

router.get("/kb/collections/:clId/items/:itemId/breadcrumb", AdminMiddleware, async (c) => {
  try {
    const clId = c.req.param("clId")
    const itemId = c.req.param("itemId")

    const uw = await getUserAndWorkspaceByEmail(
      db,
      c.get("jwtPayload").workspaceId,
      c.get("jwtPayload").sub,
    )
    const collection = await getCollectionById(db, clId)
    // Scope to the caller's workspace (#5) — getCollectionById has no filter.
    if (!collection || collection.workspaceId !== uw.workspace.id) {
      throw new HTTPException(404, { message: "Collection not found" })
    }

    const chain: { id: string; name: string }[] = []
    let cur = await getCollectionItemById(db, itemId)
    const leafVespaDocId = cur && cur.collectionId === clId ? (cur.vespaDocId ?? null) : null
    const leafMimeType = cur && cur.collectionId === clId ? (cur.mimeType ?? null) : null
    while (cur && cur.collectionId === clId) {
      chain.unshift({ id: cur.id, name: cur.name })
      if (!cur.parentId) break
      cur = await getCollectionItemById(db, cur.parentId)
    }

    return c.json({ chain, vespaDocId: leafVespaDocId, mimeType: leafMimeType })
  } catch (error) {
    if (error instanceof HTTPException) throw error
    Logger.error(error, "Error fetching admin KB breadcrumb")
    throw new HTTPException(500, { message: "Failed to fetch breadcrumb" })
  }
})

router.get("/kb/collections/:clId/files/:itemId/content", AdminMiddleware, async (c) => {
  try {
    const clId = c.req.param("clId")
    const itemId = c.req.param("itemId")

    const uw = await getUserAndWorkspaceByEmail(
      db,
      c.get("jwtPayload").workspaceId,
      c.get("jwtPayload").sub,
    )
    const collection = await getCollectionById(db, clId)
    // Scope to the caller's workspace (#5) — getCollectionById has no filter.
    if (!collection || collection.workspaceId !== uw.workspace.id) {
      throw new HTTPException(404, { message: "Collection not found" })
    }

    // Proxy to KB_CONTENT_PROXY_URL if set (same logic as the user-facing route)
    const proxyBase = process.env["KB_CONTENT_PROXY_URL"]
    if (proxyBase) {
      const target = `${proxyBase.replace(/\/$/, "")}${c.req.path}`
      const forwardHeaders: Record<string, string> = {}
      const cookie = c.req.header("cookie")
      if (cookie) forwardHeaders["cookie"] = cookie
      const range = c.req.header("range")
      if (range) forwardHeaders["range"] = range
      const upstream = await fetch(target, { method: "GET", headers: forwardHeaders, redirect: "follow" })
      const passthrough = new Headers()
      upstream.headers.forEach((v, k) => {
        const lk = k.toLowerCase()
        if (lk === "set-cookie" || lk === "transfer-encoding" || lk === "connection") return
        passthrough.set(k, v)
      })
      return new Response(upstream.body, { status: upstream.status, headers: passthrough })
    }

    const item = await getCollectionItemById(db, itemId)
    if (!item || item.collectionId !== clId || item.type !== "file") {
      throw new HTTPException(404, { message: "File not found" })
    }
    const file = await getCollectionFileByItemId(db, itemId)
    if (!file || !(file as { storagePath?: string }).storagePath) {
      throw new HTTPException(404, { message: "File data not found" })
    }
    const storagePath = (file as { storagePath: string }).storagePath

    let fileStats: Awaited<ReturnType<typeof stat>>
    try {
      fileStats = await stat(storagePath)
    } catch {
      throw new HTTPException(404, { message: "File content not found on disk" })
    }

    const fileSize = fileStats.size
    const mimeType = (file as { mimeType?: string }).mimeType || "application/octet-stream"
    const dispositionName = encodeURIComponent((file as { originalName?: string }).originalName ?? "file")
    const baseHeaders: Record<string, string> = {
      "Content-Type": mimeType,
      "Content-Disposition": `inline; filename*=UTF-8''${dispositionName}`,
      "Cache-Control": "private, max-age=3600",
      "Accept-Ranges": "bytes",
    }

    const range = c.req.header("range")
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      if (!m) throw new HTTPException(416, { message: "Invalid range" })
      const start = m[1] ? parseInt(m[1], 10) : 0
      const end = m[2] ? parseInt(m[2], 10) : fileSize - 1
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= fileSize) {
        return new Response("Range Not Satisfiable", {
          status: 416,
          headers: { "Content-Range": `bytes */${String(fileSize)}` },
        })
      }
      const chunkSize = end - start + 1
      return stream(c, async (w) => {
        c.header("Content-Range", `bytes ${String(start)}-${String(end)}/${String(fileSize)}`)
        c.header("Content-Length", String(chunkSize))
        for (const [k, v] of Object.entries(baseHeaders)) c.header(k, v)
        c.status(206)
        const rs = createReadStream(storagePath, { start, end, highWaterMark: 64 * 1024 })
        for await (const chunk of rs) await w.write(chunk as Uint8Array)
      })
    }

    return stream(c, async (w) => {
      c.header("Content-Length", String(fileSize))
      for (const [k, v] of Object.entries(baseHeaders)) c.header(k, v)
      const rs = createReadStream(storagePath, { highWaterMark: 64 * 1024 })
      for await (const chunk of rs) await w.write(chunk as Uint8Array)
    })
  } catch (error) {
    if (error instanceof HTTPException) throw error
    Logger.error(error, "Error serving admin KB file content")
    throw new HTTPException(500, { message: "Failed to serve file content" })
  }
})

import analyticsRouter from "./analytics"
router.route("/", analyticsRouter)

// ── Vespa Eval helpers ────────────────────────────────────────────────────────

function computeEvalSummary(
  results: Array<{ rank: number | null; found: boolean; topKHit: boolean }>,
  _topK: number,
): {
  totalQuestions: number
  topKHits: number
  hitRate: number
  mrr: number
  avgRank: number | null
} {
  const totalQuestions = results.length
  const topKHits = results.filter((r) => r.topKHit).length
  const hitRate = totalQuestions > 0 ? topKHits / totalQuestions : 0
  const foundRanks = results
    .filter((r) => r.found && r.rank !== null)
    .map((r) => r.rank as number)
  const mrr =
    foundRanks.length > 0
      ? foundRanks.reduce((sum, rank) => sum + 1 / rank, 0) / totalQuestions
      : 0
  const avgRank =
    foundRanks.length > 0
      ? foundRanks.reduce((a, b) => a + b, 0) / foundRanks.length
      : null
  return { totalQuestions, topKHits, hitRate, mrr, avgRank }
}

// ── GET /vespa-eval/models ───────────────────────────────────────────────────

router.get("/vespa-eval/models", AdminMiddleware, async (c) => {
  try {
    const models = await getAvailableModels({
      AwsAccessKey: config.AwsAccessKey,
      AwsSecretKey: config.AwsSecretKey,
      OpenAIKey: config.OpenAIKey,
      OllamaModel: config.OllamaModel,
      TogetherAIModel: config.TogetherAIModel,
      TogetherApiKey: config.TogetherApiKey,
      FireworksAIModel: config.FireworksAIModel,
      FireworksApiKey: config.FireworksApiKey,
      GeminiAIModel: config.GeminiAIModel,
      GeminiApiKey: config.GeminiApiKey,
      VertexAIModel: config.VertexAIModel,
      VertexProjectId: config.VertexProjectId,
      VertexRegion: config.VertexRegion,
      LiteLLMApiKey: config.LiteLLMApiKey,
      LiteLLMBaseUrl: config.LiteLLMBaseUrl,
    })
    return c.json({
      models: models.map((m) => ({
        id: m.actualName.includes("/") ? m.actualName.split("/").pop()! : m.actualName,
        label: m.labelName,
      })),
    })
  } catch (err) {
    Logger.warn({ err }, "vespa-eval/models: getAvailableModels failed, returning empty list")
    return c.json({ models: [] })
  }
})

// ── GET /vespa-eval/breadcrumb ───────────────────────────────────────────────
// Resolves vespaDocId with no ACL check — SuperAdmins read any KB item.

router.get("/vespa-eval/breadcrumb", AdminMiddleware, async (c) => {
  const clId   = c.req.query("clId")
  const itemId = c.req.query("itemId")
  if (!clId || !itemId) return c.json({ error: "clId and itemId required" }, 400)

  const [row] = await db
    .select({ vespaDocId: collectionItems.vespaDocId })
    .from(collectionItems)
    .where(and(eq(collectionItems.id, itemId), eq(collectionItems.collectionId, clId)))
    .limit(1)

  if (!row) return c.json({ error: "item not found" }, 404)
  return c.json({ vespaDocId: row.vespaDocId ?? null })
})

// ── GET /vespa-eval/resolve ──────────────────────────────────────────────────
// Doc + chunk resolution with no ACL check — admins view any KB document
// (mirrors /v2/kb/files/resolve/:docId but skips the loadCollection gate).

router.get("/vespa-eval/resolve", AdminMiddleware, async (c) => {
  const docId = c.req.query("docId")
  const chunkRaw = c.req.query("chunk")
  const chunkIndex = chunkRaw !== undefined && /^\d+$/.test(chunkRaw) ? Number(chunkRaw) : null
  if (!docId) return c.json({ error: "docId required" }, 400)

  // Resolve via Vespa's itemId (= collectionItems.id UUID): more reliable than
  // collectionItems.vespaDocId, which can drift from Vespa's docId on re-index.
  let vespaItemId: string | null = null
  let pageNumber: number | null = null

  try {
    const searchRes = await fetch(`${config.vespaEndpoint.queryEndpoint}/search/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        yql: `select itemId, chunks_map from kb_items where docId in (${yqlString(docId)})`,
        hits: 1,
        ranking: "unranked",
      }),
      signal: AbortSignal.timeout(8_000),
    })
    if (searchRes.ok) {
      const data = (await searchRes.json()) as {
        root?: { children?: Array<{ fields?: { itemId?: string; chunks_map?: Array<{ page_numbers?: number[] }> } }> }
      }
      const fields = data.root?.children?.[0]?.fields
      vespaItemId = typeof fields?.itemId === "string" ? fields.itemId : null
      if (chunkIndex !== null) {
        const pages = fields?.chunks_map?.[chunkIndex]?.page_numbers
        pageNumber = Array.isArray(pages) && pages.length > 0 ? (pages[0] ?? null) : null
      }
    }
  } catch { /* best-effort */ }

  if (!vespaItemId) return c.json({ error: "document not found in Vespa" }, 404)

  const [row] = await db
    .select({
      itemId: collectionItems.id,
      collectionId: collectionItems.collectionId,
      name: collectionItems.name,
    })
    .from(collectionItems)
    .where(eq(collectionItems.id, vespaItemId))
    .limit(1)

  if (!row) return c.json({ error: "item not found in DB" }, 404)

  let chunkText: string | null = null
  if (chunkIndex !== null) {
    try {
      const csRes = await fetch(`${config.vespaEndpoint.queryEndpoint}/search/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          yql: `select chunks_summary from kb_items where docId in (${yqlString(docId)})`,
          hits: 1,
          ranking: "unranked",
        }),
        signal: AbortSignal.timeout(8_000),
      })
      if (csRes.ok) {
        const csData = (await csRes.json()) as {
          root?: { children?: Array<{ fields?: { chunks_summary?: string[] } }> }
        }
        const raw = csData.root?.children?.[0]?.fields?.chunks_summary?.[chunkIndex] ?? null
        if (raw) {
          const cleaned = raw
            .replace(/\[Page \d+\]\s*/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
          const words = cleaned.split(" ").filter((w) => w.length > 1).slice(0, 30)
          chunkText = words.length >= 3 ? words.join(" ") : null
        }
      }
    } catch { /* best-effort */ }
  }

  return c.json({
    itemId: row.itemId,
    collectionId: row.collectionId,
    name: row.name,
    pageNumber,
    chunkText,
  })
})

// ── GET /vespa-eval/chunk ────────────────────────────────────────────────────

router.get("/vespa-eval/chunk", AdminMiddleware, async (c) => {
  const docId = c.req.query("docId")
  const chunkIndex = Number(c.req.query("index") ?? "0")
  if (!docId) return c.json({ error: "docId required" }, 400)
  try {
    const res = await fetch(`${config.vespaEndpoint.queryEndpoint}/search/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        yql: `select docId, chunks_summary from kb_items where docId in (${yqlString(docId)})`,
        hits: 1,
        ranking: "unranked",
      }),
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return c.json({ error: "vespa error" }, 502)
    const data = (await res.json()) as {
      root?: { children?: Array<{ fields?: { chunks_summary?: string[] } }> }
    }
    const chunks = data.root?.children?.[0]?.fields?.chunks_summary ?? []
    const text = chunks[chunkIndex] ?? null
    return c.json({ docId, chunkIndex, text, totalChunks: chunks.length })
  } catch {
    return c.json({ error: "failed" }, 500)
  }
})

// ── POST /vespa-eval/generate-questions ──────────────────────────────────────

router.post("/vespa-eval/generate-questions", AdminMiddleware, async (c) => {
  const body = await c.req.json<{
    docs: Array<{ vespaDocId: string; itemId: string; fileName: string }>
    questionsPerDoc: number
    systemPrompt?: string
    model?: string
  }>()

  const { docs, questionsPerDoc = 3, systemPrompt: customSystemPrompt, model: customModel } = body

  if (!config.LiteLLMBaseUrl || !config.LiteLLMApiKey) {
    return c.json({ error: "LLM not configured" }, 503)
  }

  const llmUrl = `${config.LiteLLMBaseUrl.replace(/\/+$/, "")}/v1/chat/completions`

  const llmModel = customModel?.trim() || "claude-sonnet-4-6"
  const QUESTIONS_PER_BATCH = parseInt(process.env["EVAL_QUESTIONS_PER_BATCH"] ?? "5", 10)

  const sysPrompt = `You generate keyword-rich search queries for evaluating document retrieval.

OUTPUT: Reply with valid JSON only — no preamble, no reasoning, no commentary, no markdown fences. Start your response with { and end with }.

RULES (all mandatory):
1. Each question must be specific to the EXACT chunk assigned — pull real names, numbers, dates, ticker symbols, regulatory codes, amounts, section headings, or other concrete details directly from that chunk.
2. Mix styles: some short keyword-heavy queries (3-6 words), some longer natural-language questions (8-15 words). Both must be search-engine compatible.
3. STRICTLY FORBIDDEN:
   - URLs, website addresses, or anything starting with http/www
   - Generic phrases: "according to the document", "as mentioned", "what does X represent", "what is the purpose of"
   - Questions that are just copy-pasted chunk text or consist only of numbers/symbols
4. GOOD short examples: "TRUSTMF Large Mid Cap Fund NAV face value", "risk-o-meter Very High mutual fund category"
5. GOOD long examples: "What is the exit load percentage for HDFC Flexi Cap Fund redemption within 1 year?", "tracking error calculation frequency AMFI disclosure requirement listed funds"
6. If the chunk contains a specific figure, entity, regulation, or event — include it verbatim in the question.
7. Format: {"questions": [{"question": "...", "chunkIndex": <assigned index>}, ...]}${
    customSystemPrompt?.trim() ? `\n\nAdditional style guidance: ${customSystemPrompt.trim()}` : ""
  }`

  type QuestionSlot = {
    vespaDocId: string
    fileName: string
    chunkIndex: number
    chunkText: string
  }

  const isMeaningful = (text: string): boolean => {
    const s = text.replace(/\s+/g, " ").trim()
    if (s.length < 120) return false
    if (s.replace(/https?:\/\/\S+/g, "").trim().length < 80) return false
    return s.replace(/[^a-zA-Z]/g, "").length / s.length > 0.4
  }

  const fetchSlotsForDoc = async (doc: { vespaDocId: string; itemId: string; fileName: string }): Promise<QuestionSlot[] | { error: string }> => {
    let summaries: string[] = []
    let totalCount = 0
    try {
      const res = await fetch(`${config.vespaEndpoint.queryEndpoint}/search/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          yql: `select docId, chunks_summary, chunks_map from kb_items where docId in (${yqlString(doc.vespaDocId)})`,
          hits: 1,
          ranking: "unranked",
        }),
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) {
        const data = (await res.json()) as { root?: { children?: Array<{ fields?: { chunks_summary?: string[]; chunks_map?: unknown[] } }> } }
        const fields = data.root?.children?.[0]?.fields
        summaries = Array.isArray(fields?.chunks_summary) ? fields.chunks_summary : []
        totalCount = Array.isArray(fields?.chunks_map) ? fields.chunks_map.length : summaries.length
      }
    } catch (err) {
      Logger.warn({ vespaDocId: doc.vespaDocId, err }, "eval/generate-questions: chunk fetch failed")
    }
    Logger.info({ vespaDocId: doc.vespaDocId, totalCount, summaryLength: summaries.length }, "eval/generate-questions: fetched chunks")

    const totalAvailable = totalCount || summaries.length
    if (totalAvailable === 0) return { error: "not_indexed" }

    // Fisher-Yates shuffle.
    const indices = Array.from({ length: totalAvailable }, (_, i) => i)
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const tmp = indices[i]!; indices[i] = indices[j]!; indices[j] = tmp
    }

    // Prefer meaningful chunks; fall back to any non-empty.
    const sampled: Array<{ index: number; text: string }> = []
    const limit = Math.min(questionsPerDoc, totalAvailable)
    for (const ci of indices) {
      if (sampled.length >= limit) break
      const text = summaries[ci] ?? ""
      if (isMeaningful(text)) sampled.push({ index: ci, text })
    }
    if (sampled.length === 0) {
      for (const ci of indices) {
        if (sampled.length >= limit) break
        const text = summaries[ci] ?? ""
        if (text.trim()) sampled.push({ index: ci, text })
      }
    }
    if (sampled.length === 0) return { error: "not_indexed" }

    // One chunk per slot, cycling when there are fewer chunks than questions.
    const slots: QuestionSlot[] = []
    while (slots.length < questionsPerDoc) {
      for (const c of sampled) {
        if (slots.length >= questionsPerDoc) break
        slots.push({ vespaDocId: doc.vespaDocId, fileName: doc.fileName, chunkIndex: c.index, chunkText: c.text })
      }
    }
    return slots
  }

  const callBatch = async (batch: QuestionSlot[]): Promise<Array<{ question: string; chunkIndex: number }>> => {
    const numberedChunks = batch
      .map((s, i) => `[Q${String(i + 1)} → Chunk ${String(s.chunkIndex)}]\n${s.chunkText.slice(0, 1500)}`)
      .join("\n\n")
    const assignments = batch
      .map((s, i) => `Question ${String(i + 1)}: use ONLY Chunk ${String(s.chunkIndex)} (doc: ${s.fileName})`)
      .join("\n")
    const userContent = `Chunk assignments:\n${assignments}\n\nChunks:\n${numberedChunks}`

    const MAX_RETRIES = 3
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      Logger.info({ attempt, batchSize: batch.length, chunkIndices: batch.map((s) => s.chunkIndex) }, "eval/generate-questions: sending batch to LLM")
      try {
        const res = await fetch(llmUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.LiteLLMApiKey}` },
          body: JSON.stringify({
            model: llmModel,
            messages: [
              { role: "system", content: sysPrompt },
              { role: "user", content: userContent },
            ],
            temperature: 0.7,
            max_tokens: Math.max(1024, batch.length * 300),
            stream: true,
          }),
        })
        if (!res.ok) {
          const errBody = await res.text().catch(() => "")
          Logger.warn({ status: res.status, attempt, errBody }, "eval/generate-questions: LLM HTTP error — will retry")
          if (attempt < MAX_RETRIES) { await new Promise((r) => setTimeout(r, 2000 * attempt)); continue }
          return []
        }
        // Consume SSE stream. Reasoning models (e.g. nemotron) stream their
        // chain-of-thought in delta.reasoning_content and the final answer in
        // delta.content. We only want delta.content — the actual JSON output.
        const reader = res.body?.getReader()
        if (!reader) { Logger.warn({ attempt }, "eval/generate-questions: no response body"); continue }
        const decoder = new TextDecoder()
        let buf = "", raw = "", streamDone = false
        while (!streamDone) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split("\n"); buf = lines.pop() ?? ""
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith("data:")) continue
            const data = trimmed.slice(5).trim()
            if (data === "[DONE]") { streamDone = true; break }
            try {
              const chunk = JSON.parse(data) as {
                choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null } }>
                error?: { message?: string }
              }
              if (chunk.error) { Logger.warn({ attempt, error: chunk.error }, "eval/generate-questions: LLM stream error"); break }
              const token = chunk.choices?.[0]?.delta?.content
              if (token) raw += token
            } catch { /* skip malformed SSE line */ }
          }
        }
        Logger.info({ attempt, contentLength: raw.length }, "eval/generate-questions: received from LLM")

        const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim()
        let items: Array<{ question: string; chunkIndex: number }> = []
        try {
          const parsed = JSON.parse(stripped) as { questions?: unknown }
          if (Array.isArray(parsed.questions)) {
            for (const item of parsed.questions) {
              if (item && typeof item === "object") {
                const q = (item as { question?: unknown; chunkIndex?: unknown }).question
                const ci = (item as { question?: unknown; chunkIndex?: unknown }).chunkIndex
                if (typeof q === "string" && q.trim().length >= 8) {
                  items.push({ question: q.trim(), chunkIndex: typeof ci === "number" ? ci : batch[items.length]?.chunkIndex ?? -1 })
                }
              }
            }
          }
        } catch {
          // Truncated JSON — recover via regex
          const matches = raw.match(/"question":\s*"((?:[^"\\]|\\.)*)"/g) ?? []
          items = matches
            .map((m) => { try { return JSON.parse(`{${m}}`).question as string } catch { return null } })
            .filter((q): q is string => typeof q === "string" && q.length >= 8)
            .map((q, i) => ({ question: q, chunkIndex: batch[i]?.chunkIndex ?? -1 }))
          Logger.warn({ recovered: items.length }, "eval/generate-questions: truncated JSON — recovered via regex")
        }

        if (items.length === 0 && attempt < MAX_RETRIES) {
          Logger.warn({ attempt }, "eval/generate-questions: no valid questions parsed — will retry")
          continue
        }
        return items
      } catch (err) {
        Logger.warn({ err, attempt }, "eval/generate-questions: LLM fetch threw — will retry")
        if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, 1000 * attempt))
      }
    }
    return []
  }

  return stream(c, async (w) => {
    type DocMeta = { vespaDocId: string; fileName: string; error?: string }
    const docMetas: DocMeta[] = []
    const allSlots: QuestionSlot[] = []

    for (const doc of docs) {
      const result = await fetchSlotsForDoc(doc)
      if ("error" in result) {
        docMetas.push({ vespaDocId: doc.vespaDocId, fileName: doc.fileName, error: result.error })
        await w.writeln(JSON.stringify({ type: "doc", vespaDocId: doc.vespaDocId, fileName: doc.fileName, questions: [], sourceChunkIndices: [], error: result.error }))
      } else {
        docMetas.push({ vespaDocId: doc.vespaDocId, fileName: doc.fileName })
        allSlots.push(...result)
      }
    }

    const totalSlots = allSlots.length
    const totalBatches = Math.ceil(totalSlots / QUESTIONS_PER_BATCH)
    Logger.info({ totalDocs: docs.length, totalSlots, totalBatches, questionsPerDoc }, "eval/generate-questions: starting sequential batches")

    const accumulated: Array<{ vespaDocId: string; question: string; chunkIndex: number }> = []

    for (let i = 0; i < totalSlots; i += QUESTIONS_PER_BATCH) {
      const batchNum = Math.floor(i / QUESTIONS_PER_BATCH) + 1
      const batch = allSlots.slice(i, i + QUESTIONS_PER_BATCH)
      Logger.info({ batchNum, totalBatches, batchSize: batch.length }, "eval/generate-questions: running batch")

      const results = await callBatch(batch)
      for (let j = 0; j < batch.length; j++) {
        const slot = batch[j]!
        const r = results[j]
        if (r) accumulated.push({ vespaDocId: slot.vespaDocId, question: r.question, chunkIndex: r.chunkIndex })
      }

      await w.writeln(JSON.stringify({
        type: "progress",
        batchNum,
        totalBatches,
        completed: Math.min(i + QUESTIONS_PER_BATCH, totalSlots),
        total: totalSlots,
        questionsGenerated: accumulated.length,
      }))
    }

    for (const meta of docMetas) {
      if (meta.error) continue // already streamed above
      const docResults = accumulated.filter((r) => r.vespaDocId === meta.vespaDocId)
      await w.writeln(JSON.stringify({
        type: "doc",
        vespaDocId: meta.vespaDocId,
        fileName: meta.fileName,
        questions: docResults.map((r) => r.question),
        sourceChunkIndices: docResults.map((r) => r.chunkIndex),
      }))
    }

    await w.writeln(JSON.stringify({ type: "done" }))
  })
})

// ── POST /vespa-eval/run ─────────────────────────────────────────────────────

router.post("/vespa-eval/run", AdminMiddleware, async (c) => {
  const body = await c.req.json<{
    pairs: Array<{ vespaDocId: string; question: string; fileName?: string }>
    scope: "global" | "scoped"
    selectedDocIds?: string[]
    rankProfile?: string
    topK?: number
    alpha?: number
  }>()

  const {
    pairs,
    scope,
    selectedDocIds = [],
    rankProfile = "default_native",
    topK = 10,
    alpha = 0.5,
  } = body

  const clampedTopK = Math.min(Math.max(topK, 1), 20)

  // Scoped eval filters by itemId (collectionItems.id UUID), not docId/vespaDocId
  // which can drift from Vespa. Built manually — not via agentScope/visibilityGate.
  const itemIdScopeClause =
    scope === "scoped" && selectedDocIds.length > 0
      ? ` and itemId in (${selectedDocIds.map(yqlString).join(", ")})`
      : ""

  type RetrievedDoc = {
    docId: string
    fileName?: string
    rank: number
    score: number
    matchFeatures: Record<string, number>
    chunkScores: Record<string, number>
  }

  // YQL built the same way runUnifiedSearch does.
  const targetHits = Math.max(clampedTopK + 50, 200)
  const yqlTemplate =
    `select * from kb_items where (userInput(@query) or ({targetHits:${String(targetHits)}}nearestNeighbor(chunk_embeddings, e)))${itemIdScopeClause}`

  type SearchResult = {
    vespaDocId: string
    question: string
    fileName?: string
    sourceChunkIndex?: number
    rank: number | null
    found: boolean
    topKHit: boolean
    chunkMatched: boolean
    retrievedDocs: RetrievedDoc[]
    vespaQuery: { query: string; yql: string; rankProfile: string; alpha: number }
  }

  const runSearch = async (pair: {
    vespaDocId: string
    question: string
    fileName?: string
    sourceChunkIndex?: number
  }): Promise<SearchResult> => {
    try {
      // Scoped mode fetches directly: runUnifiedSearch can't inject the itemId AND clause.
      let resp: import("@/app/agent/pi-mono/tools/vespa/searchCore").VespaSearchResponse
      if (itemIdScopeClause) {
        const yql = yqlTemplate
        const rawRes = await fetch(`${config.vespaEndpoint.queryEndpoint}/search/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            yql,
            query: pair.question,
            hits: clampedTopK,
            "ranking.profile": rankProfile,
            "input.query(alpha)": alpha,
            "input.query(e)": "embed(@query)",
          }),
          signal: AbortSignal.timeout(30_000),
        })
        if (!rawRes.ok) {
          Logger.error({ status: rawRes.status, question: pair.question.slice(0, 80) }, "vespa-eval/run: vespa returned error")
          throw new Error(`vespa ${String(rawRes.status)}`)
        }
        resp = (await rawRes.json()) as typeof resp
      } else {
        resp = await runUnifiedSearch(
          { query: pair.question, alpha, rankProfile, limit: clampedTopK, offset: 0 },
          { logger: Logger },
        )
      }

      const children = resp.root?.children ?? []
      const retrievedDocs: RetrievedDoc[] = children.map((hit, i) => {
        const fields = (hit.fields ?? {}) as Record<string, unknown>
        const mf = (fields["matchfeatures"] ?? {}) as Record<string, unknown>
        const matchFeatures: Record<string, number> = {}
        for (const [k, v] of Object.entries(mf)) {
          if (typeof v === "number") matchFeatures[k] = v
        }
        // Extract chunk_scores: { cells: { "0": 0.8, "3": 0.6, ... } }
        const chunkScoresCells = (mf["chunk_scores"] as { cells?: Record<string, number> } | undefined)?.cells ?? {}
        const chunkScores: Record<string, number> = typeof chunkScoresCells === "object"
          ? Object.fromEntries(Object.entries(chunkScoresCells).map(([k, v]) => [k, Number(v)]))
          : {}
        const docFileName = typeof fields["fileName"] === "string" ? fields["fileName"] : undefined
        return {
          docId: typeof fields["docId"] === "string" ? fields["docId"] : "",
          ...(docFileName !== undefined ? { fileName: docFileName } : {}),
          rank: i + 1,
          score: typeof hit.relevance === "number" ? hit.relevance : 0,
          matchFeatures,
          chunkScores,
        }
      })

      const expectedIdx = retrievedDocs.findIndex((d) => d.docId === pair.vespaDocId)
      const rank = expectedIdx === -1 ? null : expectedIdx + 1
      const expectedDoc = expectedIdx !== -1 ? retrievedDocs[expectedIdx] : null

      // When a source chunk is specified, require it among the expected doc's scored chunks.
      const srcChunk = pair.sourceChunkIndex
      const chunkMatched =
        srcChunk === undefined || srcChunk < 0
          ? true
          : expectedDoc !== null && String(srcChunk) in (expectedDoc?.chunkScores ?? {})

      const vespaQuery = { query: pair.question, yql: yqlTemplate, rankProfile, alpha }
      return {
        vespaDocId: pair.vespaDocId,
        question: pair.question,
        ...(pair.fileName !== undefined ? { fileName: pair.fileName } : {}),
        ...(pair.sourceChunkIndex !== undefined ? { sourceChunkIndex: pair.sourceChunkIndex } : {}),
        rank,
        found: rank !== null,
        topKHit: rank !== null && rank <= clampedTopK && chunkMatched,
        chunkMatched,
        retrievedDocs,
        vespaQuery,
      }
    } catch (err) {
      Logger.error({ question: pair.question.slice(0, 80), err: err instanceof Error ? err.message : String(err) }, "vespa-eval/run: vespa call failed")
      // fail-open: return not-found result on any error
      const vespaQuery = { query: pair.question, yql: yqlTemplate, rankProfile, alpha }
      return {
        vespaDocId: pair.vespaDocId,
        question: pair.question,
        ...(pair.fileName !== undefined ? { fileName: pair.fileName } : {}),
        ...(pair.sourceChunkIndex !== undefined ? { sourceChunkIndex: pair.sourceChunkIndex } : {}),
        rank: null,
        found: false,
        topKHit: false,
        chunkMatched: false,
        retrievedDocs: [],
        vespaQuery,
      }
    }
  }

  const CONCURRENCY = parseInt(process.env["EVAL_VESPA_CONCURRENCY"] ?? "5", 10)
  const totalBatches = Math.ceil(pairs.length / CONCURRENCY)
  Logger.info({ totalPairs: pairs.length, scope, rankProfile, alpha, topK: clampedTopK, concurrency: CONCURRENCY, totalBatches }, "vespa-eval/run: starting batched queries")

  return stream(c, async (w) => {
    const results: SearchResult[] = []
    for (let i = 0; i < pairs.length; i += CONCURRENCY) {
      const batch = pairs.slice(i, i + CONCURRENCY)
      const batchNum = Math.floor(i / CONCURRENCY) + 1
      Logger.info({ batchNum, totalBatches, batchSize: batch.length, completedSoFar: i }, "vespa-eval/run: running batch")
      const settled = await Promise.allSettled(batch.map(runSearch))
      for (let j = 0; j < settled.length; j++) {
        const r = settled[j]!
        if (r.status === "fulfilled") {
          results.push(r.value)
        } else {
          const pair = pairs[i + j]!
          results.push({
            vespaDocId: pair.vespaDocId,
            question: pair.question ?? "",
            ...(pair.fileName !== undefined ? { fileName: pair.fileName } : {}),
            rank: null,
            found: false,
            topKHit: false,
            chunkMatched: false,
            retrievedDocs: [],
            vespaQuery: { query: pair.question ?? "", yql: yqlTemplate, rankProfile, alpha },
          })
        }
      }
      await w.writeln(JSON.stringify({ type: "progress", batchNum, totalBatches, completed: results.length, total: pairs.length }))
    }

    const summary = computeEvalSummary(results, clampedTopK)
    Logger.info({ totalPairs: pairs.length, topKHits: summary.topKHits, hitRate: summary.hitRate.toFixed(3) }, "vespa-eval/run: done")
    await w.writeln(JSON.stringify({ type: "done", results, summary }))
  })
})

export default router
