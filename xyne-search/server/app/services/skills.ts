// SkillsService — CRUD over `skills` + skill↔agent mappings. Visibility is a
// single `isPrivate` flag (creator-only vs everyone); update/delete are
// creator-only.

import { and, eq, inArray } from "drizzle-orm"
import { z } from "zod"

import { db } from "@/platform/db/client"
import { getUserAndWorkspaceByEmail } from "@/platform/db/user"
import { getAgentByExternalIdWithPermissionCheck } from "@/platform/db/agent"
import { checkUserAgentAccessByExternalId } from "@/platform/db/userAgentPermission"
import { skills, skillAgentMappings } from "@/platform/db/schema"
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
  AgentNotFoundOrForbiddenError,
  UpdateHasNoFieldsError,
  UserOrWorkspaceNotFoundError,
  type Auth,
} from "./agents"

export type SkillPublic = {
  id: string
  isPrivate: boolean
  /** Short globally-unique handle (search/tag + the LLM-facing identifier). */
  alias: string
  name: string
  description: string
  content: string
  /** True when the viewer created this skill — gates edit/delete in the UI. */
  createdByMe: boolean
  createdAt: string
  updatedAt: string
}

export const createSkillSchema = z.object({
  alias: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(
      /^[a-z0-9][a-z0-9_-]*$/,
      "Alias must be lowercase letters, numbers, hyphens or underscores, and start with a letter or number",
    ),
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(100),
  content: z.string().min(1).max(5_000),
  isPrivate: z.boolean().optional().default(true),
})
export type CreateSkillPayload = z.infer<typeof createSkillSchema>

export const updateSkillSchema = createSkillSchema.partial()
export type UpdateSkillPayload = z.infer<typeof updateSkillSchema>

// ─── Typed errors ───────────────────────────────────────────────────────────

export class SkillNotFoundError extends Error {
  public override readonly name = "SkillNotFoundError"
  public readonly id: string
  public constructor(id: string) {
    super(`Skill ${id} not found`)
    this.id = id
  }
}

/** Non-creator tried to mutate/delete a skill. Route maps to 403. */
export class SkillForbiddenError extends Error {
  public override readonly name = "SkillForbiddenError"
  public readonly id: string
  public constructor(id: string) {
    super(`Not allowed to modify skill ${id}`)
    this.id = id
  }
}

/** Alias already used by another skill (DB unique violation). Route → 409. */
export class SkillAliasTakenError extends Error {
  public override readonly name = "SkillAliasTakenError"
  public readonly alias: string
  public constructor(alias: string) {
    super(`Skill alias "${alias}" is already taken`)
    this.alias = alias
  }
}

/** Skill↔agent pair already exists. Route maps to 409. */
export class SkillAlreadyMappedError extends Error {
  public override readonly name = "SkillAlreadyMappedError"
  public readonly skillId: string
  public readonly agentExternalId: string
  public constructor(skillId: string, agentExternalId: string) {
    super(`Skill ${skillId} is already mapped to agent ${agentExternalId}`)
    this.skillId = skillId
    this.agentExternalId = agentExternalId
  }
}

export class SkillMappingNotFoundError extends Error {
  public override readonly name = "SkillMappingNotFoundError"
  public readonly skillId: string
  public readonly agentExternalId: string
  public constructor(skillId: string, agentExternalId: string) {
    super(`Skill ${skillId} is not mapped to agent ${agentExternalId}`)
    this.skillId = skillId
    this.agentExternalId = agentExternalId
  }
}

// ─── Service ────────────────────────────────────────────────────────────────

type SkillRow = typeof skills.$inferSelect
type Viewer = { userId: number; workspaceId: number }

export class SkillsService {
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
    row: SkillRow,
    viewerUserId: number,
    isPrivate: boolean,
  ): SkillPublic {
    return {
      id: row.id,
      isPrivate,
      alias: row.alias,
      name: row.name,
      description: row.description,
      content: row.content,
      createdByMe: row.createdBy === viewerUserId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }

  /** Skills the viewer can see, via the unified resolver: their own (owner grant)
   *  plus workspace-public skills in *their* workspace (workspace-viewer grant) —
   *  the acl workspace scoping closes the old cross-workspace `isPrivate` leak. */
  private async loadVisible(viewer: Viewer): Promise<SkillRow[]> {
    const ids = await accessibleResourceIds(db, viewer, AclResourceType.Skill)
    if (ids.length === 0) return []
    return db
      .select()
      .from(skills)
      .where(inArray(skills.id, ids))
      .orderBy(skills.createdAt)
  }

  /** One skill if the viewer can see it, else null. */
  private async getVisibleById(
    viewer: Viewer,
    id: string,
  ): Promise<SkillRow | null> {
    const role = await resolveAccess(db, viewer, {
      type: AclResourceType.Skill,
      id,
    })
    if (role === null) return null
    const rows = await db
      .select()
      .from(skills)
      .where(eq(skills.id, id))
      .limit(1)
    return rows[0] ?? null
  }

  public async list(auth: Auth): Promise<SkillPublic[]> {
    const viewer = await this.resolveAuth(auth)
    const rows = await this.loadVisible(viewer)
    // Derive is_private from acl (private = no workspace-public grant).
    const publicIds = await workspacePublicIds(
      db,
      AclResourceType.Skill,
      viewer.workspaceId,
    )
    return rows.map((r) =>
      SkillsService.toPublic(r, viewer.userId, !publicIds.has(r.id)),
    )
  }

  public async get(auth: Auth, id: string): Promise<SkillPublic> {
    const viewer = await this.resolveAuth(auth)
    const row = await this.getVisibleById(viewer, id)
    if (!row) throw new SkillNotFoundError(id)
    const isPrivate = !(await isWorkspacePublic(
      db,
      { type: AclResourceType.Skill, id },
      viewer.workspaceId,
    ))
    return SkillsService.toPublic(row, viewer.userId, isPrivate)
  }

  public async create(
    auth: Auth,
    payload: CreateSkillPayload,
  ): Promise<SkillPublic> {
    const viewer = await this.resolveAuth(auth)
    const isPrivate = payload.isPrivate ?? true
    try {
      const row = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(skills)
          .values({
            createdBy: viewer.userId,
            alias: payload.alias,
            name: payload.name,
            description: payload.description,
            content: payload.content,
          })
          .returning()
        const created = inserted[0]!
        const ref = { type: AclResourceType.Skill, id: created.id }
        // Creator = owner; public = a workspace-viewer grant (scoped to the
        // creator's workspace, so it never leaks cross-workspace).
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
      return SkillsService.toPublic(row, viewer.userId, isPrivate)
    } catch (err) {
      if (
        err instanceof Error &&
        /skill_alias_unique_index/.test(err.message)
      ) {
        throw new SkillAliasTakenError(payload.alias)
      }
      throw err
    }
  }

  /** Update — creator only. Loads by id (no visibility filter) so a
   *  non-creator gets a 403 rather than a misleading 404. */
  public async update(
    auth: Auth,
    id: string,
    payload: UpdateSkillPayload,
  ): Promise<SkillPublic> {
    if (Object.keys(payload).length === 0) {
      throw new UpdateHasNoFieldsError()
    }
    const viewer = await this.resolveAuth(auth)
    const existing = await db
      .select()
      .from(skills)
      .where(eq(skills.id, id))
      .limit(1)
    if (!existing[0]) throw new SkillNotFoundError(id)
    if (
      !(await can(db, viewer, "write", { type: AclResourceType.Skill, id }))
    ) {
      throw new SkillForbiddenError(id)
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() }
    if (payload.alias !== undefined) updateData["alias"] = payload.alias
    if (payload.name !== undefined) updateData["name"] = payload.name
    if (payload.description !== undefined)
      updateData["description"] = payload.description
    if (payload.content !== undefined) updateData["content"] = payload.content

    try {
      const rows = await db
        .update(skills)
        .set(updateData)
        .where(eq(skills.id, id))
        .returning()
      // Keep the workspace-public grant in step with the isPrivate toggle.
      if (payload.isPrivate !== undefined) {
        const ref = { type: AclResourceType.Skill, id }
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
        { type: AclResourceType.Skill, id },
        viewer.workspaceId,
      ))
      return SkillsService.toPublic(rows[0]!, viewer.userId, isPrivate)
    } catch (err) {
      if (
        err instanceof Error &&
        /skill_alias_unique_index/.test(err.message) &&
        payload.alias !== undefined
      ) {
        throw new SkillAliasTakenError(payload.alias)
      }
      throw err
    }
  }

  /** Delete — creator only. Hard delete; mapping rows cascade. */
  public async remove(auth: Auth, id: string): Promise<SkillPublic> {
    const viewer = await this.resolveAuth(auth)
    const existing = await db
      .select()
      .from(skills)
      .where(eq(skills.id, id))
      .limit(1)
    if (!existing[0]) throw new SkillNotFoundError(id)
    if (
      !(await can(db, viewer, "delete", { type: AclResourceType.Skill, id }))
    ) {
      throw new SkillForbiddenError(id)
    }
    const wasPublic = await isWorkspacePublic(
      db,
      { type: AclResourceType.Skill, id },
      viewer.workspaceId,
    )
    const rows = await db.delete(skills).where(eq(skills.id, id)).returning()
    // The skill is gone — drop every acl grant on it.
    await revokeAllForResource(db, { type: AclResourceType.Skill, id })
    return SkillsService.toPublic(rows[0]!, viewer.userId, !wasPublic)
  }

  // ─── Skill ↔ agent mappings ───────────────────────────────────────────

  /** Resolve agent by external id → numeric id. mode "read" → any access role
   *  (matches AgentsService.get); mode "write" → owner|editor only, because
   *  map/unmap mutate the agent's skill set — mirrors the sub-agent write path
   *  (subAgents loadParent mode:"write"). */
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
    skillId: string,
    agentExternalId: string,
  ): Promise<{ skillId: string; agentExternalId: string }> {
    const viewer = await this.resolveAuth(auth)
    const skill = await this.getVisibleById(viewer, skillId)
    if (!skill) throw new SkillNotFoundError(skillId)
    const agent = await this.resolveAgent(viewer, agentExternalId, "write")
    try {
      await db
        .insert(skillAgentMappings)
        .values({ skillId, agentId: agent.id })
      return { skillId, agentExternalId }
    } catch (err) {
      if (
        err instanceof Error &&
        /skill_agent_unique_index/.test(err.message)
      ) {
        throw new SkillAlreadyMappedError(skillId, agentExternalId)
      }
      throw err
    }
  }

  public async unmapFromAgent(
    auth: Auth,
    skillId: string,
    agentExternalId: string,
  ): Promise<{ skillId: string; agentExternalId: string }> {
    const viewer = await this.resolveAuth(auth)
    const skill = await this.getVisibleById(viewer, skillId)
    if (!skill) throw new SkillNotFoundError(skillId)
    const agent = await this.resolveAgent(viewer, agentExternalId, "write")
    const rows = await db
      .delete(skillAgentMappings)
      .where(
        and(
          eq(skillAgentMappings.skillId, skillId),
          eq(skillAgentMappings.agentId, agent.id),
        ),
      )
      .returning({ id: skillAgentMappings.id })
    if (rows.length === 0) {
      throw new SkillMappingNotFoundError(skillId, agentExternalId)
    }
    return { skillId, agentExternalId }
  }

  /** Skills mapped to an agent, filtered to what the viewer can see. */
  public async listForAgent(
    auth: Auth,
    agentExternalId: string,
  ): Promise<SkillPublic[]> {
    const viewer = await this.resolveAuth(auth)
    const agent = await this.resolveAgent(viewer, agentExternalId, "read")
    const visible = new Set(
      await accessibleResourceIds(db, viewer, AclResourceType.Skill),
    )
    const mapped = await db
      .select({ skill: skills })
      .from(skillAgentMappings)
      .innerJoin(skills, eq(skillAgentMappings.skillId, skills.id))
      .where(eq(skillAgentMappings.agentId, agent.id))
      .orderBy(skills.createdAt)
    const publicIds = await workspacePublicIds(
      db,
      AclResourceType.Skill,
      viewer.workspaceId,
    )
    return mapped
      .filter((r) => visible.has(r.skill.id))
      .map((r) =>
        SkillsService.toPublic(r.skill, viewer.userId, !publicIds.has(r.skill.id)),
      )
  }
}
