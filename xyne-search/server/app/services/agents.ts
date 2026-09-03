// Agent CRUD service. Roles: read = any access, update = owner|editor,
// delete = owner only. Errors are typed so routes map them to HTTP status.

import { and, eq, isNull } from "drizzle-orm"
import { z } from "zod"

import { db } from "@/platform/db/client"
import {
  insertAgent,
  getAgentByExternalIdWithPermissionCheck,
  updateAgentByExternalIdWithPermissionCheck,
  updateAgentByExternalId,
  deleteAgentByExternalIdWithPermissionCheck,
  getAgentsAccessibleToUser,
  getAgentsMadeByMe,
  getAgentsSharedToMe,
  getAgentCollectionIds,
} from "@/platform/db/agent"
import {
  propagateAgentGrants,
  repropagateAgentGrants,
  atRiskCollectionsOnOwnerRemoval,
  NoSilentLossError,
} from "@/platform/db/acl-propagation"
import { isWorkspacePublic, AclResourceType } from "@/platform/authz"
import { agents, selectAgentSchema } from "@/platform/db/schema/agents"
import { subAgents as dbSubAgents } from "@/platform/db/schema/subAgents"
import {
  syncAgentUserPermissions,
  getAgentUsers,
  checkUserAgentAccessByExternalId,
  setAgentWorkspaceGrant,
} from "@/platform/db/userAgentPermission"
import { getUserAndWorkspaceByEmail } from "@/platform/db/user"
import { users } from "@/platform/db/schema"
import { selectPublicAgentSchema } from "@/platform/db/schema"
import { fetchedDataSourceSchema } from "@/platform/db/schema/agents"
import { UserAgentRole } from "@/platform/shared/types"
import { type SelectAgent } from "@/platform/db/agent"
import { type SelectPublicAgent } from "@/platform/db/schema"

import { resolveAgentSystemPrompt } from "../agent/pi-mono/system-prompt"
import { defaultAgentToolNames } from "../agent/pi-mono/tools/registry"

// ─── Input shapes ───────────────────────────────────────────────────────────

export type Auth = {
  email: string
  workspaceExternalId: string
}

export const listAgentsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional().default(50),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
  filter: z.enum(["all", "madeByMe", "sharedToMe"]).optional().default("all"),
  // Omit → return all (back-compat with callers that don't pass it).
  isExtractor: z.preprocess((v) => {
    if (v === "true") return true
    if (v === "false") return false
    return v
  }, z.boolean().optional()),
})
export type ListAgentsQuery = z.infer<typeof listAgentsQuerySchema>

export const createAgentSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().min(1, "Model is required"),
  isPublic: z.boolean().optional().default(false),
  appIntegrations: z
    .union([
      z.array(z.string()),
      z.record(
        z.string(),
        z.object({
          itemIds: z.array(z.string()).default([]),
          selectedAll: z.boolean(),
          filters: z
            .array(
              z.object({
                id: z.number(),
                from: z.array(z.string()).optional(),
                to: z.array(z.string()).optional(),
                cc: z.array(z.string()).optional(),
                bcc: z.array(z.string()).optional(),
                senderId: z.array(z.string()).optional(),
                channelId: z.array(z.string()).optional(),
                timeRange: z
                  .object({
                    startDate: z.number(),
                    endDate: z.number(),
                  })
                  .optional(),
              }),
            )
            .optional(),
        }),
      ),
    ])
    .optional()
    .default([]),
  allowWebSearch: z.boolean().optional().default(false),
  isRagOn: z.boolean().optional().default(true),
  // false skips the in-tool LLM relevance filter on vespaSearch (raw hits flow through).
  searchFilterEnabled: z.boolean().optional().default(true),
  uploadedFileNames: z.array(z.string()).optional().default([]),
  userEmails: z.array(z.string().email()).optional().default([]),
  ownerEmails: z.array(z.string().email()).optional().default([]),
  docIds: z.array(fetchedDataSourceSchema).optional().default([]),

  // Per-section prompt overrides. Each is optional+nullable: omit → leave column
  // unchanged on update; non-empty string → use verbatim; "" or null → clear, fall
  // back to default (the assembler invents defaults at run time, not the route layer).
  systemPromptMain: z.string().nullable().optional(),
  systemPromptTools: z.string().nullable().optional(),
  systemPromptSubagents: z.string().nullable().optional(),
  tools: z.array(z.string()).optional(),

  // No `.default(…)` on the extractor fields: zod's `.partial()` keeps defaults
  // around, which would silently demote `isExtractor` to false (and reset
  // extractorMaxRetries to 2) on any update that omits them. The service fills
  // defaults at the value-write site instead, so create-without-these still works.
  isExtractor: z.boolean().optional(),
  responseSchema: z.record(z.string(), z.unknown()).nullable().optional(),
  extractorMaxRetries: z.number().int().min(0).max(10).optional(),
  // `isDefault` is intentionally NOT exposed: exposing it via PATCH would let a
  // user claim or duplicate the workspace default (maintained by getOrCreateDefault).
})
export type CreateAgentPayload = z.infer<typeof createAgentSchema>

export const updateAgentSchema = createAgentSchema.partial().extend({
  userEmails: z.array(z.string().email()).optional(),
  ownerEmails: z.array(z.string().email()).optional(),
})
export type UpdateAgentPayload = z.infer<typeof updateAgentSchema>

// ─── Typed errors ───────────────────────────────────────────────────────────

export class UserOrWorkspaceNotFoundError extends Error {
  public override readonly name = "UserOrWorkspaceNotFoundError"
}

export class AgentNotFoundOrForbiddenError extends Error {
  public override readonly name = "AgentNotFoundOrForbiddenError"
  public readonly externalId: string
  public constructor(externalId: string) {
    super(`Agent ${externalId} not found or access denied`)
    this.externalId = externalId
  }
}

/** An email may appear in `userEmails` OR `ownerEmails`, not both. Surfaces the
 *  offending emails so the UI can highlight them. */
export class OwnerUserOverlapError extends Error {
  public override readonly name = "OwnerUserOverlapError"
  public readonly conflictingEmails: string[]
  public constructor(conflictingEmails: string[]) {
    super("Users cannot be both owners and regular users")
    this.conflictingEmails = conflictingEmails
  }
}

export class UpdateHasNoFieldsError extends Error {
  public override readonly name = "UpdateHasNoFieldsError"
  public constructor() {
    super("No fields to update")
  }
}

// ─── Service ────────────────────────────────────────────────────────────────

export class AgentsService {
  /** Resolve numeric user + workspace ids from the JWT-derived email and
   *  workspace external id. Centralised so every method shares one not-found branch. */
  private async resolveAuth(
    auth: Auth,
  ): Promise<{ userId: number; workspaceId: number }> {
    try {
      const uw = await getUserAndWorkspaceByEmail(
        db,
        auth.workspaceExternalId,
        auth.email,
      )
      if (!uw?.user || !uw?.workspace) {
        throw new UserOrWorkspaceNotFoundError()
      }
      return { userId: uw.user.id, workspaceId: uw.workspace.id }
    } catch (err) {
      // `getUserAndWorkspaceByEmail` raises HTTPException(404) on miss; normalise
      // to our typed error so the route layer maps it uniformly.
      if (err instanceof UserOrWorkspaceNotFoundError) throw err
      throw new UserOrWorkspaceNotFoundError()
    }
  }

  public async list(
    auth: Auth,
    query: ListAgentsQuery,
  ): Promise<SelectPublicAgent[]> {
    const { userId, workspaceId } = await this.resolveAuth(auth)
    const { filter, limit, offset, isExtractor } = query
    switch (filter) {
      case "madeByMe":
        return getAgentsMadeByMe(
          db,
          userId,
          workspaceId,
          limit,
          offset,
          isExtractor,
        )
      case "sharedToMe":
        return getAgentsSharedToMe(
          db,
          userId,
          workspaceId,
          limit,
          offset,
          isExtractor,
        )
      case "all":
      default:
        return getAgentsAccessibleToUser(
          db,
          userId,
          workspaceId,
          limit,
          offset,
          isExtractor,
        )
    }
  }

  public async get(auth: Auth, externalId: string): Promise<SelectPublicAgent> {
    const { userId, workspaceId } = await this.resolveAuth(auth)
    const agent = await getAgentByExternalIdWithPermissionCheck(
      db,
      externalId,
      workspaceId,
      userId,
    )
    if (!agent) throw new AgentNotFoundOrForbiddenError(externalId)
    const isPublic = await isWorkspacePublic(
      db,
      { type: AclResourceType.Agent, id: String(agent.id) },
      workspaceId,
    )
    return selectPublicAgentSchema.parse({ ...agent, isPublic })
  }

  public async getPermissions(
    auth: Auth,
    externalId: string,
  ): Promise<{ userEmails: string[]; ownerEmails: string[] }> {
    const { userId, workspaceId } = await this.resolveAuth(auth)
    const agent = await getAgentByExternalIdWithPermissionCheck(
      db,
      externalId,
      workspaceId,
      userId,
    )
    if (!agent) throw new AgentNotFoundOrForbiddenError(externalId)
    const permissions = await getAgentUsers(db, agent.id)
    const userEmails: string[] = []
    const ownerEmails: string[] = []
    for (const p of permissions) {
      if (p.role === UserAgentRole.Owner) ownerEmails.push(p.user.email)
      else userEmails.push(p.user.email)
    }
    return { userEmails, ownerEmails }
  }

  public async create(
    auth: Auth,
    payload: CreateAgentPayload,
  ): Promise<SelectPublicAgent> {
    const { userId, workspaceId } = await this.resolveAuth(auth)
    assertOwnerUserDisjoint(payload.userEmails, payload.ownerEmails)

    // `uploadedFileNames` is accepted by the schema but isn't a column on the
    // agents table — silently dropped at the DB layer.
    const agentData = {
      name: payload.name,
      description: payload.description,
      prompt: payload.prompt,
      model: payload.model,
      isPublic: payload.isPublic,
      appIntegrations: payload.appIntegrations,
      allowWebSearch: payload.allowWebSearch,
      isRagOn: payload.isRagOn,
      searchFilterEnabled: payload.searchFilterEnabled,
      docIds: payload.docIds,
      userEmails: payload.userEmails,
      ownerEmails: payload.ownerEmails,
      ...(payload.systemPromptMain !== undefined
        ? { systemPromptMain: payload.systemPromptMain }
        : {}),
      ...(payload.systemPromptTools !== undefined
        ? { systemPromptTools: payload.systemPromptTools }
        : {}),
      ...(payload.systemPromptSubagents !== undefined
        ? { systemPromptSubagents: payload.systemPromptSubagents }
        : {}),
      // `tools = []` means "no tools" at run time (no "[] → all" wildcard), so
      // materialise the full registry when the payload omits tools or sends [].
      tools:
        payload.tools && payload.tools.length > 0
          ? payload.tools
          : defaultAgentToolNames(),
      // responseSchema only forwards when isExtractor, to keep plain-agent rows clean.
      isExtractor: payload.isExtractor ?? false,
      ...(payload.isExtractor && payload.responseSchema !== undefined
        ? { responseSchema: payload.responseSchema }
        : {}),
      extractorMaxRetries: payload.extractorMaxRetries ?? 2,
    }

    const created = await db.transaction(async (tx) => {
      const agent = await insertAgent(tx, agentData, userId, workspaceId)

      // Private agents propagate explicit viewer permissions; public agents skip
      // this (visibility is implicit, no viewer list).
      if (
        !payload.isPublic &&
        payload.userEmails &&
        payload.userEmails.length > 0
      ) {
        await syncAgentUserPermissions(
          tx,
          agent.id,
          payload.userEmails,
          payload.ownerEmails ?? [],
          workspaceId,
        )
      }
      // A public agent needs a workspace-viewer acl grant so the resolver-based
      // access gate admits workspace peers (create is always into the caller's
      // workspace; private is the default and needs no grant).
      if (payload.isPublic) {
        await setAgentWorkspaceGrant(tx, agent.id, workspaceId, true)
      }
      // Propagate the agent's KB read to its audience (source-tagged), now that
      // owners + shared users + any public grant are all recorded in acl.
      const collectionIds = await getAgentCollectionIds(tx, agent)
      await propagateAgentGrants(tx, {
        agentId: agent.id,
        workspaceId,
        collectionIds,
      })
      return agent
    })

    return selectPublicAgentSchema.parse({
      ...created,
      isPublic: payload.isPublic ?? false,
    })
  }

  public async update(
    auth: Auth,
    externalId: string,
    payload: UpdateAgentPayload,
  ): Promise<SelectPublicAgent> {
    if (Object.keys(payload).length === 0) {
      throw new UpdateHasNoFieldsError()
    }

    const { userId, workspaceId } = await this.resolveAuth(auth)
    assertOwnerUserDisjoint(payload.userEmails, payload.ownerEmails)

    // Two-phase access check: permission-aware get, then a direct lookup in
    // user_agent_permission. The second catches the case where the row exists for
    // someone else but the caller has *no* permission row at all. 404 for both.
    const existing = await getAgentByExternalIdWithPermissionCheck(
      db,
      externalId,
      workspaceId,
      userId,
    )
    const callerPerms = await checkUserAgentAccessByExternalId(
      db,
      userId,
      externalId,
      workspaceId,
    )
    if (!existing || !callerPerms?.find((p) => p.userId === userId)) {
      throw new AgentNotFoundOrForbiddenError(externalId)
    }

    const updated = await db.transaction(async (tx) => {
      const agent = await updateAgentByExternalIdWithPermissionCheck(
        tx,
        externalId,
        workspaceId,
        userId,
        payload,
      )
      if (!agent) {
        // Permission check above passed, but WithPermissionCheck also requires
        // owner|editor role for *writes*. Surface 404-equivalent.
        throw new AgentNotFoundOrForbiddenError(externalId)
      }

      // No-silent-loss guard: if this update removes owners, block it when a
      // removed owner is the last editor+ justification for a referenced
      // collection — the audience would silently lose it. The caller must first
      // reassign/adopt or drop those collections. Forced org-offboarding uses a
      // separate SuperAdmin path, not this interactive edit.
      if (payload.ownerEmails !== undefined) {
        const ownerEmails = payload.ownerEmails
        const removedOwners = (await getAgentUsers(tx, agent.id)).filter(
          (u) =>
            u.role === UserAgentRole.Owner && !ownerEmails.includes(u.user.email),
        )
        if (removedOwners.length > 0) {
          const collectionIds = await getAgentCollectionIds(tx, agent)
          const atRisk = await atRiskCollectionsOnOwnerRemoval(tx, {
            agentId: agent.id,
            workspaceId,
            removingUserIds: removedOwners.map((u) => u.userId),
            collectionIds,
          })
          if (atRisk.length > 0) {
            throw new NoSilentLossError(agent.externalId, atRisk)
          }
        }
      }

      // Pre-update public state derived from acl (is_public column dropped).
      const existingIsPublic = await isWorkspacePublic(
        tx,
        { type: AclResourceType.Agent, id: String(existing.id) },
        workspaceId,
      )

      // Permission re-sync, three branches:
      //   • flipping to public → clear all non-owner permissions
      //   • flipping/staying private with explicit userEmails → resync
      //   • userEmails alone (no isPublic) → only resync if currently private
      if (payload.isPublic === true) {
        await syncAgentUserPermissions(
          tx,
          agent.id,
          [],
          payload.ownerEmails ?? [],
          workspaceId,
        )
      } else if (
        payload.isPublic === false &&
        payload.userEmails !== undefined
      ) {
        await syncAgentUserPermissions(
          tx,
          agent.id,
          payload.userEmails,
          payload.ownerEmails ?? [],
          workspaceId,
        )
      } else if (payload.userEmails !== undefined && !existingIsPublic) {
        await syncAgentUserPermissions(
          tx,
          agent.id,
          payload.userEmails,
          payload.ownerEmails ?? [],
          workspaceId,
        )
      }

      // Keep the agent's workspace-public acl grant in step with isPublic so the
      // resolver-based gate flips access exactly when the toggle does.
      if (payload.isPublic !== undefined) {
        await setAgentWorkspaceGrant(tx, agent.id, workspaceId, payload.isPublic)
      }

      // Recompute the agent's derived KB grants whenever its audience (share /
      // publish) or its KB refs (appIntegrations) change: drop everything it
      // produced, then re-propagate to the current audience × current collections.
      // Dropped collections and unshared users fall out with no separate reconcile.
      if (
        payload.isPublic !== undefined ||
        payload.userEmails !== undefined ||
        payload.ownerEmails !== undefined ||
        payload.appIntegrations !== undefined
      ) {
        const collectionIds = await getAgentCollectionIds(tx, agent)
        await repropagateAgentGrants(tx, {
          agentId: agent.id,
          workspaceId,
          collectionIds,
        })
      }

      return agent
    })

    const isPublic = await isWorkspacePublic(
      db,
      { type: AclResourceType.Agent, id: String(updated.id) },
      workspaceId,
    )
    return selectPublicAgentSchema.parse({ ...updated, isPublic })
  }

  public async remove(
    auth: Auth,
    externalId: string,
  ): Promise<SelectPublicAgent> {
    const { userId, workspaceId } = await this.resolveAuth(auth)

    const existing = await getAgentByExternalIdWithPermissionCheck(
      db,
      externalId,
      workspaceId,
      userId,
    )
    const callerPerms = await checkUserAgentAccessByExternalId(
      db,
      userId,
      externalId,
      workspaceId,
    )
    if (!existing || !callerPerms?.find((p) => p.userId === userId)) {
      throw new AgentNotFoundOrForbiddenError(externalId)
    }

    const deleted = await deleteAgentByExternalIdWithPermissionCheck(
      db,
      externalId,
      workspaceId,
      userId,
    )
    if (!deleted) {
      // WithPermissionCheck delete returns null when the caller isn't an owner.
      // Surface 404-equivalent.
      throw new AgentNotFoundOrForbiddenError(externalId)
    }
    const isPublic = await isWorkspacePublic(
      db,
      { type: AclResourceType.Agent, id: String(deleted.id) },
      workspaceId,
    )
    return selectPublicAgentSchema.parse({ ...deleted, isPublic })
  }

  // ── Effective prompt (view page) ─────────────────────────────────────────
  // Returns the system prompt the LLM would actually see if a turn started now
  // under this agent, so editors see real bytes not the override fields.
  // Permission gate is the same as `get`: any access role passes.
  public async getEffectivePrompt(
    auth: Auth,
    externalId: string,
  ): Promise<{
    prompt: string
    sources: {
      main: "override" | "default"
      tools: "override" | "default"
      subagents: "override" | "default" | "suppressed"
    }
  }> {
    const { userId, workspaceId } = await this.resolveAuth(auth)
    const agent = await getAgentByExternalIdWithPermissionCheck(
      db,
      externalId,
      workspaceId,
      userId,
    )
    if (!agent) throw new AgentNotFoundOrForbiddenError(externalId)

    const subAgentRows = await db
      .select({
        name: dbSubAgents.name,
        description: dbSubAgents.description,
      })
      .from(dbSubAgents)
      .where(
        and(
          eq(dbSubAgents.parentAgentId, agent.id),
          isNull(dbSubAgents.deletedAt),
        ),
      )

    // sources reports per-section override vs default; subagents is "suppressed"
    // when there are zero sub-agents (the block isn't emitted at all).
    const has = (v: string | null | undefined): boolean =>
      typeof v === "string" && v.length > 0
    const sources = {
      main: has(agent.systemPromptMain)
        ? ("override" as const)
        : ("default" as const),
      tools: has(agent.systemPromptTools)
        ? ("override" as const)
        : ("default" as const),
      subagents:
        subAgentRows.length === 0
          ? ("suppressed" as const)
          : has(agent.systemPromptSubagents)
            ? ("override" as const)
            : ("default" as const),
    }

    const prompt = resolveAgentSystemPrompt({
      systemPromptMain: agent.systemPromptMain,
      systemPromptTools: agent.systemPromptTools,
      systemPromptSubagents: agent.systemPromptSubagents,
      subAgents: subAgentRows,
    })

    return { prompt, sources }
  }

  // ── Workspace-wide default agent ─────────────────────────────────────────
  // Used when a chat turn carries no agent scope ("General agent"). One per
  // workspace, enforced by unique partial index `agents_default_per_workspace_unique`;
  // created lazily, the index doubles as a race-safety belt on concurrent inserts.

  /** Return the default agent for the caller's workspace, creating it on the fly
   *  if absent. Idempotent. Permission-free (every workspace user shares it);
   *  only PUT is restricted (see updateDefault). */
  public async getOrCreateDefault(auth: Auth): Promise<SelectAgent> {
    const { userId, workspaceId } = await this.resolveAuth(auth)
    const existing = await db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.workspaceId, workspaceId),
          eq(agents.isDefault, true),
          isNull(agents.deletedAt),
        ),
      )
      .limit(1)
    if (existing[0]) return selectAgentSchema.parse(existing[0])

    // `userId` is the caller's id only because user_id is NOT NULL — purely
    // audit, not ownership. The default agent isn't owned in the editorial
    // sense; updateDefault gates on admin role, not owner-of-row.
    try {
      const inserted = await db
        .insert(agents)
        .values({
          workspaceId,
          userId,
          externalId: `agent-default-${createDefaultAgentExternalIdSuffix(workspaceId)}`,
          name: "General agent",
          description:
            "Workspace default — used when a chat turn doesn't pick a specific agent.",
          model: "Auto",
          isDefault: true,
          // Full registry: [] would mean "no tools" and silently disable retrieval
          // on un-scoped chats — wrong for the workspace fallback.
          tools: defaultAgentToolNames(),
        })
        .returning()
      if (!inserted[0]) {
        throw new Error("ensure default agent: insert returned no row")
      }
      // Public workspace fallback: grant workspace-viewer so the resolver gate
      // admits every workspace user (mirrors the backfill for existing defaults).
      await setAgentWorkspaceGrant(db, inserted[0].id, workspaceId, true)
      return selectAgentSchema.parse(inserted[0])
    } catch (err) {
      // Lost the unique-index race against a parallel insert — re-read.
      if (
        err instanceof Error &&
        /agents_default_per_workspace_unique/.test(err.message)
      ) {
        const retry = await db
          .select()
          .from(agents)
          .where(
            and(
              eq(agents.workspaceId, workspaceId),
              eq(agents.isDefault, true),
              isNull(agents.deletedAt),
            ),
          )
          .limit(1)
        if (retry[0]) return selectAgentSchema.parse(retry[0])
      }
      throw err
    }
  }

  /** Patch the workspace default agent. Bypasses the owner/editor permission
   *  check because the default row has no owner; write access is instead gated
   *  to SuperAdmin at the route layer (requireSuperAdmin in routes/agents.ts). */
  public async updateDefault(
    auth: Auth,
    payload: UpdateAgentPayload,
  ): Promise<SelectAgent> {
    if (Object.keys(payload).length === 0) {
      throw new UpdateHasNoFieldsError()
    }
    const { workspaceId } = await this.resolveAuth(auth)
    const current = await this.getOrCreateDefault(auth)

    // Never let the default row's `isDefault` flag get flipped via PATCH.
    const { isDefault: _drop, ...rest } = payload as UpdateAgentPayload & {
      isDefault?: boolean
    }

    const updated = await updateAgentByExternalId(
      db,
      current.externalId,
      workspaceId,
      rest,
    )
    if (!updated) {
      throw new AgentNotFoundOrForbiddenError(current.externalId)
    }
    // The default agent is workspace-public; recompute its derived KB grants when
    // a SuperAdmin changes its KB refs so referenced collections track the default.
    if (rest.appIntegrations !== undefined) {
      const collectionIds = await getAgentCollectionIds(db, updated)
      await repropagateAgentGrants(db, {
        agentId: updated.id,
        workspaceId,
        collectionIds,
      })
    }
    return selectAgentSchema.parse(updated)
  }
}

// Workspace id in the suffix makes the default row grep-able in logs/DB.
const createDefaultAgentExternalIdSuffix = (workspaceId: number): string =>
  `w${String(workspaceId)}-${Math.random().toString(36).slice(2, 10)}`

// ─── Helpers ────────────────────────────────────────────────────────────────

const assertOwnerUserDisjoint = (
  userEmails: string[] | undefined,
  ownerEmails: string[] | undefined,
): void => {
  if (!userEmails || !ownerEmails) return
  const ownerSet = new Set(ownerEmails)
  const overlap = userEmails.filter((e) => ownerSet.has(e))
  if (overlap.length > 0) throw new OwnerUserOverlapError(overlap)
}

// ─── Workspace user search ──────────────────────────────────────────────────
// `id` is the user's externalId (the UI uses externalIds, never numeric).
export type WorkspaceUserResult = {
  id: string
  name: string
  email: string
  photoLink: string | null
}

export const searchWorkspaceUsers = async (
  auth: Auth,
  q: string,
  limit: number,
): Promise<WorkspaceUserResult[]> => {
  if (!q.trim()) return []
  const uw = await getUserAndWorkspaceByEmail(
    db,
    auth.workspaceExternalId,
    auth.email,
  )
  if (!uw?.user || !uw?.workspace) {
    throw new UserOrWorkspaceNotFoundError()
  }
  // TODO: push the LIKE into SQL. In-memory is fine for current workspace sizes.
  const rows = await db
    .select({
      id: users.externalId,
      name: users.name,
      email: users.email,
      photoLink: users.photoLink,
    })
    .from(users)
    .where(
      and(eq(users.workspaceId, uw.workspace.id), isNull(users.deletedAt)),
    )
  const needle = q.toLowerCase()
  return rows
    .filter(
      (u) =>
        u.name.toLowerCase().includes(needle) ||
        u.email.toLowerCase().includes(needle),
    )
    .slice(0, limit)
    .map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      photoLink: u.photoLink ?? null,
    }))
}
