import {
  agents,
  users,
  acl,
  insertUserAgentPermissionSchema,
  selectUserAgentPermissionSchema,
  userAgentPermissionWithDetailsSchema,
  type InsertUserAgentPermission,
  type SelectUserAgentPermission,
  type UserAgentPermissionWithDetails,
  type SelectPublicAgent,
  selectPublicAgentSchema,
  AgentCreationSource,
} from "@/platform/db/schema"
import { AclPrincipalType, AclRole } from "@/platform/db/schema/acl"
import { UserAgentRole } from "@/platform/shared/types"
import type { TxnOrClient } from "@/types"
import { z } from "zod"
import { and, eq, isNull, desc, or, inArray, sql } from "drizzle-orm"
import {
  AclResourceType,
  resolveAccess,
  workspacePublicIds,
  grant,
  revokeGrant,
  type Role,
} from "@/platform/authz"

// UserAgentRole → unified acl role. The legacy "shared" tier (and any unset
// role) collapses to viewer.
const toAclRole = (role: string | undefined): Role =>
  role === UserAgentRole.Owner
    ? AclRole.Owner
    : role === UserAgentRole.Editor
      ? AclRole.Editor
      : AclRole.Viewer

// Shared projection for the agent-listing endpoints. Must include the M3-era
// system-prompt columns or selectPublicAgentSchema.parse() trips on undefined.
const publicAgentColumns = {
  externalId: agents.externalId,
  name: agents.name,
  description: agents.description,
  prompt: agents.prompt,
  model: agents.model,
  // id is used to derive isPublic (workspace acl grant); parse() strips it.
  id: agents.id,
  appIntegrations: agents.appIntegrations,
  allowWebSearch: agents.allowWebSearch,
  isRagOn: agents.isRagOn,
  searchFilterEnabled: agents.searchFilterEnabled,
  docIds: agents.docIds,
  createdAt: agents.createdAt,
  updatedAt: agents.updatedAt,
  systemPromptMain: agents.systemPromptMain,
  systemPromptTools: agents.systemPromptTools,
  systemPromptSubagents: agents.systemPromptSubagents,
  tools: agents.tools,
  isDefault: agents.isDefault,
  isExtractor: agents.isExtractor,
  responseSchema: agents.responseSchema,
  extractorMaxRetries: agents.extractorMaxRetries,
}

// Agent ids the viewer can reach in acl, by scope:
//   owned      = user-principal owner grant
//   shared     = user-principal editor/viewer grant (explicit share, not public)
//   accessible = any user grant OR the workspace-public grant
type AgentAclScope = "owned" | "shared" | "accessible"

const agentIdsForViewer = async (
  trx: TxnOrClient,
  userId: number,
  workspaceId: number,
  scope: AgentAclScope,
): Promise<number[]> => {
  const asUser = and(
    eq(acl.principalType, AclPrincipalType.User),
    eq(acl.principalId, userId),
  )
  const predicate =
    scope === "owned"
      ? and(asUser, eq(acl.role, AclRole.Owner))
      : scope === "shared"
        ? and(asUser, inArray(acl.role, [AclRole.Editor, AclRole.Viewer]))
        : or(
            asUser,
            and(
              eq(acl.principalType, AclPrincipalType.Workspace),
              eq(acl.principalId, workspaceId),
            ),
          )
  const rows = await trx
    .selectDistinct({ resourceId: acl.resourceId })
    .from(acl)
    .where(and(eq(acl.resourceType, AclResourceType.Agent), predicate))
  return rows
    .map((r) => Number(r.resourceId))
    .filter((n) => Number.isFinite(n))
}

// checkUserAgentAccess (numeric, dead) removed — the live gate is
// checkUserAgentAccessByExternalId, resolved through acl.

// Effective agent access via the unified resolver: direct user grant ∪ the
// workspace-public grant → MAX role. Returns a synthesized permission-row array
// (the shape callers expect) or null. Reads acl, not the frozen join table.
export const checkUserAgentAccessByExternalId = async (
  trx: TxnOrClient,
  userId: number,
  agentExternalId: string,
  workspaceId: number,
): Promise<SelectUserAgentPermission[] | null> => {
  const [ag] = await trx
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.externalId, agentExternalId),
        eq(agents.workspaceId, workspaceId),
        isNull(agents.deletedAt),
      ),
    )
    .limit(1)
  if (!ag) return null

  const role = await resolveAccess(
    trx,
    { userId, workspaceId },
    { type: AclResourceType.Agent, id: String(ag.id) },
  )
  if (role === null) return null

  return [
    {
      id: 0,
      userId,
      agentId: ag.id,
      role: role as UserAgentRole,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]
}

// Agents accessible to a user: owned + shared + public.
// Derive isPublic for agent rows from acl (workspace grant) — the column was
// dropped. The rows carry `id` for the lookup; selectPublicAgentSchema strips it.
const withIsPublic = async <T extends { id: number }>(
  trx: TxnOrClient,
  rows: T[],
  workspaceId: number,
): Promise<(T & { isPublic: boolean })[]> => {
  const publicSet = await workspacePublicIds(
    trx,
    AclResourceType.Agent,
    workspaceId,
  )
  return rows.map((r) => ({ ...r, isPublic: publicSet.has(String(r.id)) }))
}

export const getUserAccessibleAgents = async (
  trx: TxnOrClient,
  userId: number,
  workspaceId: number,
  limit: number = 50,
  offset: number = 0,
  isExtractor?: boolean,
): Promise<SelectPublicAgent[]> => {
  const ids = await agentIdsForViewer(trx, userId, workspaceId, "accessible")
  if (ids.length === 0) return []
  const agentsArr = await trx
    .selectDistinct(publicAgentColumns)
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        eq(agents.creation_source, AgentCreationSource.DIRECT),
        eq(agents.isDefault, false),
        isNull(agents.deletedAt),
        inArray(agents.id, ids),
        ...(isExtractor !== undefined
          ? [eq(agents.isExtractor, isExtractor)]
          : []),
      ),
    )
    .orderBy(desc(agents.updatedAt))
    .limit(limit)
    .offset(offset)

  return z
    .array(selectPublicAgentSchema)
    .parse(await withIsPublic(trx, agentsArr, workspaceId))
}

// Agents where the user holds the Owner role.
export const getAgentsMadeByMe = async (
  trx: TxnOrClient,
  userId: number,
  workspaceId: number,
  limit: number = 50,
  offset: number = 0,
  isExtractor?: boolean,
): Promise<SelectPublicAgent[]> => {
  const ids = await agentIdsForViewer(trx, userId, workspaceId, "owned")
  if (ids.length === 0) return []
  const agentsArr = await trx
    .selectDistinct(publicAgentColumns)
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        eq(agents.creation_source, AgentCreationSource.DIRECT),
        eq(agents.isDefault, false),
        isNull(agents.deletedAt),
        inArray(agents.id, ids),
        ...(isExtractor !== undefined
          ? [eq(agents.isExtractor, isExtractor)]
          : []),
      ),
    )
    .orderBy(desc(agents.updatedAt))
    .limit(limit)
    .offset(offset)

  return z
    .array(selectPublicAgentSchema)
    .parse(await withIsPublic(trx, agentsArr, workspaceId))
}

// Agents where the user holds the Shared role (not Owner).
export const getAgentsSharedToMe = async (
  trx: TxnOrClient,
  userId: number,
  workspaceId: number,
  limit: number = 50,
  offset: number = 0,
  isExtractor?: boolean,
): Promise<SelectPublicAgent[]> => {
  const ids = await agentIdsForViewer(trx, userId, workspaceId, "shared")
  if (ids.length === 0) return []
  const agentsArr = await trx
    .selectDistinct(publicAgentColumns)
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        isNull(agents.deletedAt),
        eq(agents.creation_source, AgentCreationSource.DIRECT),
        eq(agents.isDefault, false),
        inArray(agents.id, ids),
        ...(isExtractor !== undefined
          ? [eq(agents.isExtractor, isExtractor)]
          : []),
      ),
    )
    .orderBy(desc(agents.updatedAt))
    .limit(limit)
    .offset(offset)

  return z
    .array(selectPublicAgentSchema)
    .parse(await withIsPublic(trx, agentsArr, workspaceId))
}

export const getUserAgentsWithPermissions = async (
  trx: TxnOrClient,
  userId: number,
  workspaceId: number,
  limit: number = 50,
  offset: number = 0,
): Promise<UserAgentPermissionWithDetails[]> => {
  // A user's agent grants, read from acl (the user_agent_permissions table is
  // dropped) and joined to agent + the user's own detail.
  const [me] = await trx
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      photoLink: users.photoLink,
      externalId: users.externalId,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (!me) return []
  const rows = await trx
    .select({
      agentId: agents.id,
      role: acl.role,
      createdAt: acl.createdAt,
      updatedAt: acl.updatedAt,
      agent: {
        id: agents.id,
        externalId: agents.externalId,
        name: agents.name,
        description: agents.description,
        model: agents.model,
      },
    })
    .from(acl)
    .innerJoin(agents, sql`${agents.id}::text = ${acl.resourceId}`)
    .where(
      and(
        eq(acl.resourceType, AclResourceType.Agent),
        eq(acl.principalType, AclPrincipalType.User),
        eq(acl.principalId, userId),
        eq(agents.workspaceId, workspaceId),
        isNull(agents.deletedAt),
      ),
    )
    .orderBy(desc(agents.updatedAt))
    .limit(limit)
    .offset(offset)

  return z.array(userAgentPermissionWithDetailsSchema).parse(
    rows.map((r) => ({
      id: 0,
      userId,
      agentId: r.agentId,
      role: r.role,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      user: me,
      agent: r.agent,
    })),
  )
}

// Agent access lives in acl (direct user grant). grant() upserts idempotently
// on (resource, principal, source); the return is synthesized in the legacy
// permission-row shape callers expect.
export const grantUserAgentPermission = async (
  trx: TxnOrClient,
  permissionData: InsertUserAgentPermission,
): Promise<SelectUserAgentPermission> => {
  const validatedData = insertUserAgentPermissionSchema.parse(permissionData)
  await grant(trx, {
    ref: { type: AclResourceType.Agent, id: String(validatedData.agentId) },
    principal: { type: AclPrincipalType.User, id: validatedData.userId },
    role: toAclRole(validatedData.role),
  })
  return selectUserAgentPermissionSchema.parse({
    id: 0,
    userId: validatedData.userId,
    agentId: validatedData.agentId,
    role: validatedData.role ?? UserAgentRole.Shared,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
}

export const updateUserAgentPermission = async (
  trx: TxnOrClient,
  userId: number,
  agentId: number,
  role: UserAgentRole,
): Promise<SelectUserAgentPermission | null> => {
  await grant(trx, {
    ref: { type: AclResourceType.Agent, id: String(agentId) },
    principal: { type: AclPrincipalType.User, id: userId },
    role: toAclRole(role),
  })
  return selectUserAgentPermissionSchema.parse({
    id: 0,
    userId,
    agentId,
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
}

export const revokeUserAgentPermission = async (
  trx: TxnOrClient,
  userId: number,
  agentId: number,
): Promise<boolean> => {
  await revokeGrant(trx, {
    ref: { type: AclResourceType.Agent, id: String(agentId) },
    principal: { type: AclPrincipalType.User, id: userId },
  })
  return true
}

// Sync an agent's workspace-public grant in acl: public = a workspace viewer
// grant, private = none. Called wherever agents.isPublic is written so the
// resolver-based gate stays correct for newly public/private agents.
export const setAgentWorkspaceGrant = async (
  trx: TxnOrClient,
  agentId: number,
  workspaceId: number,
  isPublic: boolean,
): Promise<void> => {
  const ref = { type: AclResourceType.Agent, id: String(agentId) }
  const principal = { type: AclPrincipalType.Workspace, id: workspaceId }
  if (isPublic) {
    await grant(trx, { ref, principal, role: AclRole.Viewer, workspaceId })
  } else {
    await revokeGrant(trx, { ref, principal })
  }
}

export const getAgentUsers = async (
  trx: TxnOrClient,
  agentId: number,
): Promise<UserAgentPermissionWithDetails[]> => {
  // Who has access to this agent, from acl (user_agent_permissions dropped).
  const results = await trx
    .select({
      userId: acl.principalId,
      role: acl.role,
      createdAt: acl.createdAt,
      updatedAt: acl.updatedAt,
      user: {
        id: users.id,
        email: users.email,
        name: users.name,
        photoLink: users.photoLink,
        externalId: users.externalId,
      },
      agent: {
        id: agents.id,
        externalId: agents.externalId,
        name: agents.name,
        description: agents.description,
        model: agents.model,
      },
    })
    .from(acl)
    .innerJoin(users, eq(users.id, acl.principalId))
    .innerJoin(agents, sql`${agents.id}::text = ${acl.resourceId}`)
    .where(
      and(
        eq(acl.resourceType, AclResourceType.Agent),
        eq(acl.resourceId, String(agentId)),
        eq(acl.principalType, AclPrincipalType.User),
      ),
    )
    .orderBy(desc(acl.createdAt))

  return z.array(userAgentPermissionWithDetailsSchema).parse(
    results.map((r) => ({
      id: 0,
      userId: r.userId,
      agentId,
      role: r.role,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      user: r.user,
      agent: r.agent,
    })),
  )
}

// Reconcile an agent's permissions to the given email lists: add missing users
// as Shared, drop Shared users no longer listed, and sync the Owner set.
// Owners are never removed by the Shared pass.
export const syncAgentUserPermissions = async (
  trx: TxnOrClient,
  agentId: number,
  userEmails: string[],
  ownerEmails: string[],
  workspaceId: number,
): Promise<void> => {
  // Current grants from acl (user_agent_permissions dropped).
  const currentPermissions = await trx
    .select({
      userId: acl.principalId,
      userEmail: users.email,
      role: acl.role,
    })
    .from(acl)
    .innerJoin(users, eq(users.id, acl.principalId))
    .where(
      and(
        eq(acl.resourceType, AclResourceType.Agent),
        eq(acl.resourceId, String(agentId)),
        eq(acl.principalType, AclPrincipalType.User),
      ),
    )

  const usersInWorkspace = await trx
    .select({
      id: users.id,
      email: users.email,
    })
    .from(users)
    .where(
      and(eq(users.workspaceId, workspaceId), inArray(users.email, userEmails)),
    )

  const currentUserEmails = currentPermissions
    .filter((p) => p.role == UserAgentRole.Shared)
    .map((p) => p.userEmail)
  const newUserEmails = userEmails.filter(
    (email) => !currentUserEmails.includes(email),
  )
  const removedUserEmails = currentUserEmails.filter(
    (email) =>
      !userEmails.includes(email) &&
      currentPermissions.find((p) => p.userEmail === email)?.role !==
        UserAgentRole.Owner,
  )

  for (const email of newUserEmails) {
    const user = usersInWorkspace.find((u) => u.email === email)
    if (user) {
      await grantUserAgentPermission(trx, {
        userId: user.id,
        agentId,
        role: UserAgentRole.Shared,
      })
    }
  }

  if (removedUserEmails.length > 0) {
    const usersToRemove = await trx
      .select({
        userId: users.id,
      })
      .from(users)
      .where(
        and(
          eq(users.workspaceId, workspaceId),
          inArray(users.email, removedUserEmails),
        ),
      )

    for (const user of usersToRemove) {
      await revokeUserAgentPermission(trx, user.userId, agentId)
    }
  }

  const ownersInWorkspace = await trx
    .select({
      id: users.id,
      email: users.email,
    })
    .from(users)
    .where(
      and(
        eq(users.workspaceId, workspaceId),
        inArray(users.email, ownerEmails),
      ),
    )

  const currentOwnerEmails = currentPermissions
    .filter((p) => p.role == UserAgentRole.Owner)
    .map((p) => p.userEmail)
  const newOwnerEmails = ownerEmails.filter(
    (email) => !currentOwnerEmails.includes(email),
  )
  const removedOwnerEmails = currentOwnerEmails.filter(
    (email) => !ownerEmails.includes(email),
  )

  for (const email of newOwnerEmails) {
    const user = ownersInWorkspace.find((u) => u.email === email)
    if (user) {
      await grantUserAgentPermission(trx, {
        userId: user.id,
        agentId,
        role: UserAgentRole.Owner,
      })
    }
  }

  if (removedOwnerEmails.length > 0) {
    const usersToRemove = await trx
      .select({
        userId: users.id,
      })
      .from(users)
      .where(
        and(
          eq(users.workspaceId, workspaceId),
          inArray(users.email, removedOwnerEmails),
        ),
      )

    for (const user of usersToRemove) {
      await revokeUserAgentPermission(trx, user.userId, agentId)
    }
  }
}
