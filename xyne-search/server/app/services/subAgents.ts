// SubAgentsService — CRUD over sub_agents, scoped by parent agent + caller's
// workspace. Permission mirrors AgentsService: read (list/get) needs any access
// to the parent (matches AgentsService.get); write (create/update/remove) needs
// owner|editor (matches AgentsService.update).
//
// Sub-agents inherit the parent's workspace_id at insert — never under a parent
// in another workspace. Unique (parent_agent_id, name) index → surfaced as a
// typed error for 409. parent_agent_id is intentionally not on the wire; the
// parent is identified by external_id in the URL.

import { and, eq, isNull } from "drizzle-orm"
import { z } from "zod"

import { db } from "@/platform/db/client"
import {
  getAgentByExternalIdWithPermissionCheck,
} from "@/platform/db/agent"
import {
  checkUserAgentAccessByExternalId,
} from "@/platform/db/userAgentPermission"
import { getUserAndWorkspaceByEmail } from "@/platform/db/user"
import { subAgents } from "@/platform/db/schema"
import {
  subAgentThinkingLevelSchema,
  type SubAgentThinkingLevel,
} from "@/platform/db/schema/subAgents"
import { UserAgentRole } from "@/platform/shared/types"

import { createId } from "@paralleldrive/cuid2"

import {
  AgentNotFoundOrForbiddenError,
  UpdateHasNoFieldsError,
  UserOrWorkspaceNotFoundError,
  type Auth,
} from "./agents"

/** Wire-facing subset of a sub_agents row; numeric ids/FKs stay server-side. */
export type SubAgentPublic = {
  externalId: string
  name: string
  description: string
  systemPrompt: string
  tools: string[]
  // Reasoning effort for the nested pi-mono session; per-sub-agent, not
  // inherited from the parent at dispatch time.
  thinkingLevel: SubAgentThinkingLevel
  createdAt: string
  updatedAt: string
}

// Name slug constrained so the parent LLM can reference it unambiguously in
// dispatchSubagent's `name` arg; matches the column constraint in db/schema/subAgents.ts.
const subAgentNameSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(
    /^[a-z][a-z0-9-]*$/,
    "name must be a lowercase slug ([a-z][a-z0-9-]*)",
  )

export const createSubAgentSchema = z.object({
  name: subAgentNameSchema,
  description: z.string().min(1).max(500),
  systemPrompt: z.string().min(1),
  tools: z.array(z.string()).optional().default([]),
  thinkingLevel: subAgentThinkingLevelSchema.optional().default("medium"),
})
export type CreateSubAgentPayload = z.infer<typeof createSubAgentSchema>

export const updateSubAgentSchema = createSubAgentSchema.partial()
export type UpdateSubAgentPayload = z.infer<typeof updateSubAgentSchema>

export class SubAgentNotFoundError extends Error {
  public override readonly name = "SubAgentNotFoundError"
  public readonly externalId: string
  public constructor(externalId: string) {
    super(`Sub-agent ${externalId} not found`)
    this.externalId = externalId
  }
}

/** Unique (parent_agent_id, name) violation on insert/update. Route → 409. */
export class SubAgentNameTakenError extends Error {
  public override readonly name = "SubAgentNameTakenError"
  public readonly parentExternalId: string
  public readonly takenName: string
  public constructor(parentExternalId: string, takenName: string) {
    super(
      `A sub-agent named "${takenName}" already exists under parent ${parentExternalId}`,
    )
    this.parentExternalId = parentExternalId
    this.takenName = takenName
  }
}

export class SubAgentsService {
  /** Resolve numeric (userId, workspaceId) from the JWT auth bundle, sharing
   *  the "User or workspace not found" branch across methods. */
  private async resolveAuth(
    auth: Auth,
  ): Promise<{ userId: number; workspaceId: number }> {
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

  /** Confirm parent-agent access and return its numeric id + workspace_id.
   *  mode "read" → any access role (matches AgentsService.get); mode "write" →
   *  owner|editor only (matches AgentsService.update). */
  private async loadParent(
    auth: Auth,
    parentExternalId: string,
    mode: "read" | "write",
  ): Promise<{ id: number; workspaceId: number }> {
    const { userId, workspaceId } = await this.resolveAuth(auth)
    const parent = await getAgentByExternalIdWithPermissionCheck(
      db,
      parentExternalId,
      workspaceId,
      userId,
    )
    if (!parent) {
      throw new AgentNotFoundOrForbiddenError(parentExternalId)
    }
    if (mode === "write") {
      const perms = await checkUserAgentAccessByExternalId(
        db,
        userId,
        parentExternalId,
        workspaceId,
      )
      const my = perms?.find((p) => p.userId === userId)
      if (
        !my ||
        (my.role !== UserAgentRole.Owner && my.role !== UserAgentRole.Editor)
      ) {
        throw new AgentNotFoundOrForbiddenError(parentExternalId)
      }
    }
    return { id: parent.id, workspaceId: parent.workspaceId }
  }

  // `tools` is JSONB; fence at the boundary so callers always get a clean
  // string[] regardless of how the row was written (legacy null, object, etc.).
  private static normaliseTools(raw: unknown): string[] {
    if (!Array.isArray(raw)) return []
    return raw.filter((t): t is string => typeof t === "string")
  }

  // Coerce raw column value into the closed SubAgentThinkingLevel set, falling
  // back to "medium" on anything unexpected (legacy/pre-column rows) vs crashing.
  private static normaliseThinkingLevel(raw: unknown): SubAgentThinkingLevel {
    const parsed = subAgentThinkingLevelSchema.safeParse(raw)
    return parsed.success ? parsed.data : "medium"
  }

  private static toPublic(row: {
    externalId: string
    name: string
    description: string
    systemPrompt: string
    tools: unknown
    thinkingLevel: unknown
    createdAt: Date
    updatedAt: Date
  }): SubAgentPublic {
    return {
      externalId: row.externalId,
      name: row.name,
      description: row.description,
      systemPrompt: row.systemPrompt,
      tools: SubAgentsService.normaliseTools(row.tools),
      thinkingLevel: SubAgentsService.normaliseThinkingLevel(row.thinkingLevel),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }

  public async list(
    auth: Auth,
    parentExternalId: string,
  ): Promise<SubAgentPublic[]> {
    const parent = await this.loadParent(auth, parentExternalId, "read")
    const rows = await db
      .select()
      .from(subAgents)
      .where(
        and(
          eq(subAgents.parentAgentId, parent.id),
          isNull(subAgents.deletedAt),
        ),
      )
      .orderBy(subAgents.createdAt)
    return rows.map(SubAgentsService.toPublic)
  }

  public async get(
    auth: Auth,
    parentExternalId: string,
    subExternalId: string,
  ): Promise<SubAgentPublic> {
    const parent = await this.loadParent(auth, parentExternalId, "read")
    const rows = await db
      .select()
      .from(subAgents)
      .where(
        and(
          eq(subAgents.parentAgentId, parent.id),
          eq(subAgents.externalId, subExternalId),
          isNull(subAgents.deletedAt),
        ),
      )
      .limit(1)
    if (!rows[0]) throw new SubAgentNotFoundError(subExternalId)
    return SubAgentsService.toPublic(rows[0])
  }

  public async create(
    auth: Auth,
    parentExternalId: string,
    payload: CreateSubAgentPayload,
  ): Promise<SubAgentPublic> {
    const parent = await this.loadParent(auth, parentExternalId, "write")
    const row = {
      externalId: `sub-${createId()}`,
      parentAgentId: parent.id,
      workspaceId: parent.workspaceId,
      name: payload.name,
      description: payload.description,
      systemPrompt: payload.systemPrompt,
      tools: payload.tools ?? [],
      thinkingLevel: payload.thinkingLevel ?? "medium",
    }
    try {
      const inserted = await db.insert(subAgents).values(row).returning()
      return SubAgentsService.toPublic(inserted[0]!)
    } catch (err) {
      // Match on the unique index name to detect the name-collision violation;
      // anything else propagates to the route's 500 mapper.
      if (
        err instanceof Error &&
        /sub_agents_name_per_parent_unique/.test(err.message)
      ) {
        throw new SubAgentNameTakenError(parentExternalId, payload.name)
      }
      throw err
    }
  }

  public async update(
    auth: Auth,
    parentExternalId: string,
    subExternalId: string,
    payload: UpdateSubAgentPayload,
  ): Promise<SubAgentPublic> {
    if (Object.keys(payload).length === 0) {
      throw new UpdateHasNoFieldsError()
    }
    const parent = await this.loadParent(auth, parentExternalId, "write")

    // Build the SET clause without spreading `undefined`s — drizzle would
    // overwrite the column with NULL otherwise.
    const updateData: Record<string, unknown> = { updatedAt: new Date() }
    if (payload.name !== undefined) updateData["name"] = payload.name
    if (payload.description !== undefined)
      updateData["description"] = payload.description
    if (payload.systemPrompt !== undefined)
      updateData["systemPrompt"] = payload.systemPrompt
    if (payload.tools !== undefined) updateData["tools"] = payload.tools
    if (payload.thinkingLevel !== undefined)
      updateData["thinkingLevel"] = payload.thinkingLevel

    try {
      const rows = await db
        .update(subAgents)
        .set(updateData)
        .where(
          and(
            eq(subAgents.parentAgentId, parent.id),
            eq(subAgents.externalId, subExternalId),
            isNull(subAgents.deletedAt),
          ),
        )
        .returning()
      if (!rows[0]) throw new SubAgentNotFoundError(subExternalId)
      return SubAgentsService.toPublic(rows[0])
    } catch (err) {
      if (
        err instanceof Error &&
        /sub_agents_name_per_parent_unique/.test(err.message)
      ) {
        throw new SubAgentNameTakenError(parentExternalId, payload.name ?? "")
      }
      throw err
    }
  }

  public async remove(
    auth: Auth,
    parentExternalId: string,
    subExternalId: string,
  ): Promise<SubAgentPublic> {
    const parent = await this.loadParent(auth, parentExternalId, "write")
    const rows = await db
      .update(subAgents)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(subAgents.parentAgentId, parent.id),
          eq(subAgents.externalId, subExternalId),
          isNull(subAgents.deletedAt),
        ),
      )
      .returning()
    if (!rows[0]) throw new SubAgentNotFoundError(subExternalId)
    return SubAgentsService.toPublic(rows[0])
  }
}
