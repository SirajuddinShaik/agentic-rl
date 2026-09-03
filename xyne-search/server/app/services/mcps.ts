// McpsService — CRUD over `mcps` + mcp↔agent mappings, mirroring SkillsService.
// Visibility is a single `isPrivate` flag (creator-only vs workspace) via the
// unified acl. Config is stored as encrypted stringified JSON; secret values are
// masked on the way out and preserved (when left masked) on update. Everything
// transport-specific (config shape, secret masking, connecting) lives in the
// MCP transport registry — so adding stdio/websocket later touches nothing here.

import { and, eq, inArray } from "drizzle-orm"
import { z } from "zod"

import { db } from "@/platform/db/client"
import { getUserAndWorkspaceByEmail } from "@/platform/db/user"
import { getAgentByExternalIdWithPermissionCheck } from "@/platform/db/agent"
import { checkUserAgentAccessByExternalId } from "@/platform/db/userAgentPermission"
import { mcps, mcpAgentMappings } from "@/platform/db/schema"
import { AclPrincipalType, AclRole } from "@/platform/db/schema/acl"
import { UserAgentRole } from "@/platform/shared/types"
import {
  AclResourceType,
  resolveAccess,
  can,
  accessibleResourceIds,
  workspacePublicIds,
  isWorkspacePublic,
  grant,
  revokeGrant,
  revokeAllForResource,
} from "@/platform/authz"
import {
  TRANSPORTS,
  isSupportedMcpType,
  supportedMcpTypes,
} from "@/app/agent/mcp/transports"
import { connectMcp, listMcpTools } from "@/app/agent/mcp/client"

import {
  AgentNotFoundOrForbiddenError,
  UpdateHasNoFieldsError,
  UserOrWorkspaceNotFoundError,
  type Auth,
} from "./agents"

export type McpPublic = {
  id: string
  isPrivate: boolean
  name: string
  description: string
  /** Transport kind — see McpType (e.g. "streamable_http" | "sse"). */
  type: string
  /** Connection config with secret values masked (SECRET_MASK). */
  config: unknown
  /** True when the viewer created this MCP — gates edit/delete in the UI. */
  createdByMe: boolean
  createdAt: string
  updatedAt: string
}

// `config` is validated per-type by the transport registry, so it's opaque here.
export const createMcpSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(500),
  type: z.string().min(1),
  config: z.unknown(),
  isPrivate: z.boolean().optional().default(true),
})
export type CreateMcpPayload = z.infer<typeof createMcpSchema>

export const updateMcpSchema = createMcpSchema.partial()
export type UpdateMcpPayload = z.infer<typeof updateMcpSchema>

export const testMcpSchema = z.object({
  type: z.string().min(1),
  config: z.unknown(),
})
export type TestMcpPayload = z.infer<typeof testMcpSchema>

export type TestConnectionResult = {
  ok: boolean
  tools?: { name: string; description: string }[]
  error?: string
}

// ─── Typed errors ───────────────────────────────────────────────────────────

export class McpNotFoundError extends Error {
  public override readonly name = "McpNotFoundError"
  public readonly id: string
  public constructor(id: string) {
    super(`MCP ${id} not found`)
    this.id = id
  }
}

/** Non-creator tried to mutate/delete an MCP. Route maps to 403. */
export class McpForbiddenError extends Error {
  public override readonly name = "McpForbiddenError"
  public readonly id: string
  public constructor(id: string) {
    super(`Not allowed to modify MCP ${id}`)
    this.id = id
  }
}

/** Unknown/unsupported transport type. Route maps to 400. */
export class McpUnsupportedTypeError extends Error {
  public override readonly name = "McpUnsupportedTypeError"
  public readonly type: string
  public constructor(type: string) {
    super(
      `Unsupported MCP type "${type}". Supported: ${supportedMcpTypes().join(", ")}`,
    )
    this.type = type
  }
}

export class McpAlreadyMappedError extends Error {
  public override readonly name = "McpAlreadyMappedError"
  public readonly mcpId: string
  public readonly agentExternalId: string
  public constructor(mcpId: string, agentExternalId: string) {
    super(`MCP ${mcpId} is already mapped to agent ${agentExternalId}`)
    this.mcpId = mcpId
    this.agentExternalId = agentExternalId
  }
}

export class McpMappingNotFoundError extends Error {
  public override readonly name = "McpMappingNotFoundError"
  public readonly mcpId: string
  public readonly agentExternalId: string
  public constructor(mcpId: string, agentExternalId: string) {
    super(`MCP ${mcpId} is not mapped to agent ${agentExternalId}`)
    this.mcpId = mcpId
    this.agentExternalId = agentExternalId
  }
}

// ─── Service ────────────────────────────────────────────────────────────────

type McpRow = typeof mcps.$inferSelect
type Viewer = { userId: number; workspaceId: number }

const parseStoredConfig = (raw: string | null): unknown => {
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export class McpsService {
  private async resolveAuth(auth: Auth): Promise<Viewer> {
    const uw = await getUserAndWorkspaceByEmail(
      db,
      auth.workspaceExternalId,
      auth.email,
    )
    if (!uw?.user || !uw?.workspace) {
      throw new UserOrWorkspaceNotFoundError()
    }
    return { userId: uw.user.id, workspaceId: uw.workspace.id }
  }

  private static toPublic(
    row: McpRow,
    viewerUserId: number,
    isPrivate: boolean,
  ): McpPublic {
    const stored = parseStoredConfig(row.config)
    const config = isSupportedMcpType(row.type)
      ? TRANSPORTS[row.type].maskConfig(stored)
      : stored
    return {
      id: row.id,
      isPrivate,
      name: row.name,
      description: row.description,
      type: row.type,
      config,
      createdByMe: row.createdBy === viewerUserId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }

  private async loadVisible(viewer: Viewer): Promise<McpRow[]> {
    const ids = await accessibleResourceIds(db, viewer, AclResourceType.Mcp)
    if (ids.length === 0) return []
    return db
      .select()
      .from(mcps)
      .where(inArray(mcps.id, ids))
      .orderBy(mcps.createdAt)
  }

  private async getVisibleById(
    viewer: Viewer,
    id: string,
  ): Promise<McpRow | null> {
    const role = await resolveAccess(db, viewer, {
      type: AclResourceType.Mcp,
      id,
    })
    if (role === null) return null
    const rows = await db.select().from(mcps).where(eq(mcps.id, id)).limit(1)
    return rows[0] ?? null
  }

  public async list(auth: Auth): Promise<McpPublic[]> {
    const viewer = await this.resolveAuth(auth)
    const rows = await this.loadVisible(viewer)
    const publicIds = await workspacePublicIds(
      db,
      AclResourceType.Mcp,
      viewer.workspaceId,
    )
    return rows.map((r) =>
      McpsService.toPublic(r, viewer.userId, !publicIds.has(r.id)),
    )
  }

  public async get(auth: Auth, id: string): Promise<McpPublic> {
    const viewer = await this.resolveAuth(auth)
    const row = await this.getVisibleById(viewer, id)
    if (!row) throw new McpNotFoundError(id)
    const isPrivate = !(await isWorkspacePublic(
      db,
      { type: AclResourceType.Mcp, id },
      viewer.workspaceId,
    ))
    return McpsService.toPublic(row, viewer.userId, isPrivate)
  }

  public async create(
    auth: Auth,
    payload: CreateMcpPayload,
  ): Promise<McpPublic> {
    const viewer = await this.resolveAuth(auth)
    if (!isSupportedMcpType(payload.type)) {
      throw new McpUnsupportedTypeError(payload.type)
    }
    // Deep config validation lives in the transport registry (throws ZodError).
    const config = TRANSPORTS[payload.type].parseConfig(payload.config)
    const isPrivate = payload.isPrivate ?? true
    const row = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(mcps)
        .values({
          createdBy: viewer.userId,
          name: payload.name,
          description: payload.description,
          type: payload.type,
          config: JSON.stringify(config),
        })
        .returning()
      const created = inserted[0]!
      const ref = { type: AclResourceType.Mcp, id: created.id }
      await grant(tx, {
        ref,
        principal: { type: AclPrincipalType.User, id: viewer.userId },
        role: AclRole.Owner,
        workspaceId: viewer.workspaceId,
      })
      if (!isPrivate) {
        await grant(tx, {
          ref,
          principal: {
            type: AclPrincipalType.Workspace,
            id: viewer.workspaceId,
          },
          role: AclRole.Viewer,
          workspaceId: viewer.workspaceId,
        })
      }
      return created
    })
    return McpsService.toPublic(row, viewer.userId, isPrivate)
  }

  public async update(
    auth: Auth,
    id: string,
    payload: UpdateMcpPayload,
  ): Promise<McpPublic> {
    if (Object.keys(payload).length === 0) {
      throw new UpdateHasNoFieldsError()
    }
    const viewer = await this.resolveAuth(auth)
    const existing = await db
      .select()
      .from(mcps)
      .where(eq(mcps.id, id))
      .limit(1)
    if (!existing[0]) throw new McpNotFoundError(id)
    if (!(await can(db, viewer, "write", { type: AclResourceType.Mcp, id }))) {
      throw new McpForbiddenError(id)
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() }
    if (payload.name !== undefined) updateData["name"] = payload.name
    if (payload.description !== undefined)
      updateData["description"] = payload.description

    if (payload.type !== undefined || payload.config !== undefined) {
      const type = payload.type ?? existing[0].type
      if (!isSupportedMcpType(type)) throw new McpUnsupportedTypeError(type)
      const def = TRANSPORTS[type]
      const stored = parseStoredConfig(existing[0].config)
      const incoming = payload.config ?? stored
      // Same type: preserve secrets the client left masked. Type changed: no
      // secret carry-over — validate the incoming config fresh.
      const merged =
        payload.type && payload.type !== existing[0].type
          ? def.parseConfig(incoming)
          : def.mergeConfig(incoming, stored)
      updateData["type"] = type
      updateData["config"] = JSON.stringify(merged)
    }

    const rows = await db
      .update(mcps)
      .set(updateData)
      .where(eq(mcps.id, id))
      .returning()

    if (payload.isPrivate !== undefined) {
      const ref = { type: AclResourceType.Mcp, id }
      const principal = {
        type: AclPrincipalType.Workspace,
        id: viewer.workspaceId,
      }
      if (payload.isPrivate === false) {
        await grant(db, {
          ref,
          principal,
          role: AclRole.Viewer,
          workspaceId: viewer.workspaceId,
        })
      } else {
        await revokeGrant(db, { ref, principal })
      }
    }
    const isPrivate = !(await isWorkspacePublic(
      db,
      { type: AclResourceType.Mcp, id },
      viewer.workspaceId,
    ))
    return McpsService.toPublic(rows[0]!, viewer.userId, isPrivate)
  }

  public async remove(auth: Auth, id: string): Promise<McpPublic> {
    const viewer = await this.resolveAuth(auth)
    const existing = await db
      .select()
      .from(mcps)
      .where(eq(mcps.id, id))
      .limit(1)
    if (!existing[0]) throw new McpNotFoundError(id)
    if (!(await can(db, viewer, "delete", { type: AclResourceType.Mcp, id }))) {
      throw new McpForbiddenError(id)
    }
    const wasPublic = await isWorkspacePublic(
      db,
      { type: AclResourceType.Mcp, id },
      viewer.workspaceId,
    )
    const rows = await db.delete(mcps).where(eq(mcps.id, id)).returning()
    await revokeAllForResource(db, { type: AclResourceType.Mcp, id })
    return McpsService.toPublic(rows[0]!, viewer.userId, !wasPublic)
  }

  /** Connect to a server with the given config and list its tools, without
   *  persisting anything — powers the create/edit form's "Test connection". */
  public async testConnection(
    auth: Auth,
    payload: TestMcpPayload,
  ): Promise<TestConnectionResult> {
    await this.resolveAuth(auth)
    if (!isSupportedMcpType(payload.type)) {
      return { ok: false, error: `Unsupported MCP type: ${payload.type}` }
    }
    let client: Awaited<ReturnType<typeof connectMcp>> | undefined
    try {
      client = await connectMcp(payload.type, payload.config, {
        timeoutMs: 12_000,
      })
      const tools = await listMcpTools(client)
      return {
        ok: true,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
        })),
      }
    } catch (err) {
      const error =
        err instanceof z.ZodError
          ? "Invalid configuration for this MCP type"
          : err instanceof Error
            ? err.message
            : "Connection failed"
      return { ok: false, error }
    } finally {
      if (client) {
        try {
          await client.close()
        } catch {
          // best-effort cleanup
        }
      }
    }
  }

  // ─── MCP ↔ agent mappings ─────────────────────────────────────────────

  private async resolveAgent(
    viewer: Viewer,
    agentExternalId: string,
    mode: "read" | "write",
  ): Promise<{ id: number }> {
    const agent = await getAgentByExternalIdWithPermissionCheck(
      db,
      agentExternalId,
      viewer.workspaceId,
      viewer.userId,
    )
    if (!agent) throw new AgentNotFoundOrForbiddenError(agentExternalId)
    if (mode === "write") {
      const perms = await checkUserAgentAccessByExternalId(
        db,
        viewer.userId,
        agentExternalId,
        viewer.workspaceId,
      )
      const my = perms?.find((p) => p.userId === viewer.userId)
      if (
        !my ||
        (my.role !== UserAgentRole.Owner && my.role !== UserAgentRole.Editor)
      ) {
        throw new AgentNotFoundOrForbiddenError(agentExternalId)
      }
    }
    return { id: agent.id }
  }

  public async mapToAgent(
    auth: Auth,
    mcpId: string,
    agentExternalId: string,
  ): Promise<{ mcpId: string; agentExternalId: string }> {
    const viewer = await this.resolveAuth(auth)
    const mcp = await this.getVisibleById(viewer, mcpId)
    if (!mcp) throw new McpNotFoundError(mcpId)
    const agent = await this.resolveAgent(viewer, agentExternalId, "write")
    try {
      await db.insert(mcpAgentMappings).values({ mcpId, agentId: agent.id })
      return { mcpId, agentExternalId }
    } catch (err) {
      if (err instanceof Error && /mcp_agent_unique_index/.test(err.message)) {
        throw new McpAlreadyMappedError(mcpId, agentExternalId)
      }
      throw err
    }
  }

  public async unmapFromAgent(
    auth: Auth,
    mcpId: string,
    agentExternalId: string,
  ): Promise<{ mcpId: string; agentExternalId: string }> {
    const viewer = await this.resolveAuth(auth)
    const mcp = await this.getVisibleById(viewer, mcpId)
    if (!mcp) throw new McpNotFoundError(mcpId)
    const agent = await this.resolveAgent(viewer, agentExternalId, "write")
    const rows = await db
      .delete(mcpAgentMappings)
      .where(
        and(
          eq(mcpAgentMappings.mcpId, mcpId),
          eq(mcpAgentMappings.agentId, agent.id),
        ),
      )
      .returning({ id: mcpAgentMappings.id })
    if (rows.length === 0) {
      throw new McpMappingNotFoundError(mcpId, agentExternalId)
    }
    return { mcpId, agentExternalId }
  }

  public async listForAgent(
    auth: Auth,
    agentExternalId: string,
  ): Promise<McpPublic[]> {
    const viewer = await this.resolveAuth(auth)
    const agent = await this.resolveAgent(viewer, agentExternalId, "read")
    const visible = new Set(
      await accessibleResourceIds(db, viewer, AclResourceType.Mcp),
    )
    const mapped = await db
      .select({ mcp: mcps })
      .from(mcpAgentMappings)
      .innerJoin(mcps, eq(mcpAgentMappings.mcpId, mcps.id))
      .where(eq(mcpAgentMappings.agentId, agent.id))
      .orderBy(mcps.createdAt)
    const publicIds = await workspacePublicIds(
      db,
      AclResourceType.Mcp,
      viewer.workspaceId,
    )
    return mapped
      .filter((r) => visible.has(r.mcp.id))
      .map((r) =>
        McpsService.toPublic(r.mcp, viewer.userId, !publicIds.has(r.mcp.id)),
      )
  }
}
