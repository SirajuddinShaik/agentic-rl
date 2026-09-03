// Row-level access queries for workflow-sdk resources (workflows + folders),
// mirroring userAgentPermission.ts. This is the DB half of the ACL: the SDK's
// authorizer/adapter call into here. Ownership is a permission row with
// role='owner'; public is a boolean column on the resource. The accessible-*
// queries are the single LEFT JOIN the SDK's visibleFilter is pushed into.

import {
  sdkResourcePermissions,
  sdkWorkflows,
  sdkFolders,
  users,
} from "@/platform/db/schema"
import { SdkResourceRole } from "@/platform/shared/types"
import type { TxnOrClient } from "@/types"
import { and, eq, desc, or, isNotNull } from "drizzle-orm"

export type SdkResourceType = "workflow" | "folder"

// All columns of each table, so the mapper in the adapter has everything and
// SELECT DISTINCT can ORDER BY updatedAt (Postgres requires it in the list).
const workflowCols = {
  id: sdkWorkflows.id,
  workspaceId: sdkWorkflows.workspaceId,
  status: sdkWorkflows.status,
  config: sdkWorkflows.config,
  metadata: sdkWorkflows.metadata,
  eventType: sdkWorkflows.eventType,
  summary: sdkWorkflows.summary,
  folderId: sdkWorkflows.folderId,
  isPublic: sdkWorkflows.isPublic,
  createdAt: sdkWorkflows.createdAt,
  updatedAt: sdkWorkflows.updatedAt,
}

const folderCols = {
  id: sdkFolders.id,
  workspaceId: sdkFolders.workspaceId,
  name: sdkFolders.name,
  metadata: sdkFolders.metadata,
  parentId: sdkFolders.parentId,
  isPublic: sdkFolders.isPublic,
  createdAt: sdkFolders.createdAt,
}

export type AccessibleWorkflowRow = {
  [K in keyof typeof workflowCols]: (typeof sdkWorkflows.$inferSelect)[K]
}
export type AccessibleFolderRow = {
  [K in keyof typeof folderCols]: (typeof sdkFolders.$inferSelect)[K]
}

// ─── Accessible-resources queries (the visibleFilter JOIN) ───────────────────

/**
 * Workflows the user may see in `workspaceExternalId`: owned or shared (any perm
 * row) OR public — scoped to the workspace, paginated in the query. The LEFT
 * join (not INNER) is what lets public workflows with no perm row through.
 */
export const getUserAccessibleWorkflows = async (
  trx: TxnOrClient,
  userId: number,
  workspaceExternalId: string,
  page?: { folderId?: string; limit?: number; offset?: number },
): Promise<AccessibleWorkflowRow[]> => {
  const conds = [
    eq(sdkWorkflows.workspaceId, workspaceExternalId),
    or(isNotNull(sdkResourcePermissions.userId), eq(sdkWorkflows.isPublic, true)),
  ]
  if (page?.folderId) conds.push(eq(sdkWorkflows.folderId, page.folderId))

  let q = trx
    .selectDistinct(workflowCols)
    .from(sdkWorkflows)
    .leftJoin(
      sdkResourcePermissions,
      and(
        eq(sdkResourcePermissions.resourceId, sdkWorkflows.id),
        eq(sdkResourcePermissions.resourceType, "workflow"),
        eq(sdkResourcePermissions.userId, userId),
      ),
    )
    .where(and(...conds))
    .orderBy(desc(sdkWorkflows.updatedAt))
    .$dynamic()

  if (page?.limit !== undefined) q = q.limit(page.limit)
  if (page?.offset !== undefined) q = q.offset(page.offset)
  return q
}

/** Folders the user may see — same visibility rule as workflows. */
export const getUserAccessibleFolders = async (
  trx: TxnOrClient,
  userId: number,
  workspaceExternalId: string,
): Promise<AccessibleFolderRow[]> => {
  return trx
    .selectDistinct(folderCols)
    .from(sdkFolders)
    .leftJoin(
      sdkResourcePermissions,
      and(
        eq(sdkResourcePermissions.resourceId, sdkFolders.id),
        eq(sdkResourcePermissions.resourceType, "folder"),
        eq(sdkResourcePermissions.userId, userId),
      ),
    )
    .where(
      and(
        eq(sdkFolders.workspaceId, workspaceExternalId),
        or(isNotNull(sdkResourcePermissions.userId), eq(sdkFolders.isPublic, true)),
      ),
    )
    .orderBy(desc(sdkFolders.createdAt))
}

/** Total + per-folder counts over the visible workflow set (folder rail). */
export const getAccessibleWorkflowCounts = async (
  trx: TxnOrClient,
  userId: number,
  workspaceExternalId: string,
): Promise<{ total: number; byFolder: Record<string, { total: number; active: number }> }> => {
  const rows = await trx
    .selectDistinct({
      id: sdkWorkflows.id,
      folderId: sdkWorkflows.folderId,
      status: sdkWorkflows.status,
    })
    .from(sdkWorkflows)
    .leftJoin(
      sdkResourcePermissions,
      and(
        eq(sdkResourcePermissions.resourceId, sdkWorkflows.id),
        eq(sdkResourcePermissions.resourceType, "workflow"),
        eq(sdkResourcePermissions.userId, userId),
      ),
    )
    .where(
      and(
        eq(sdkWorkflows.workspaceId, workspaceExternalId),
        or(isNotNull(sdkResourcePermissions.userId), eq(sdkWorkflows.isPublic, true)),
      ),
    )

  const byFolder: Record<string, { total: number; active: number }> = {}
  for (const r of rows) {
    const e = byFolder[r.folderId] ?? { total: 0, active: 0 }
    e.total++
    if (r.status === "ACTIVE") e.active++
    byFolder[r.folderId] = e
  }
  return { total: rows.length, byFolder }
}

// ─── Point role lookups (permissions / permissionsBatch) ─────────────────────

/**
 * The caller's explicit role on each ref, in one query — powers the SDK's
 * permissionsBatch so list projection is not N round-trips. Keyed
 * `${type}:${id}`; absent from the map ⇒ no explicit grant (the authorizer then
 * falls back to public → viewer). Public is NOT resolved here — the resource's
 * isPublic column travels on the record's attributes.
 */
export const getResourceRoles = async (
  trx: TxnOrClient,
  userId: number,
  refs: ReadonlyArray<{ type: SdkResourceType; id: string }>,
): Promise<Map<string, SdkResourceRole>> => {
  if (refs.length === 0) return new Map()
  const rows = await trx
    .select({
      resourceType: sdkResourcePermissions.resourceType,
      resourceId: sdkResourcePermissions.resourceId,
      role: sdkResourcePermissions.role,
    })
    .from(sdkResourcePermissions)
    .where(
      and(
        eq(sdkResourcePermissions.userId, userId),
        or(
          ...refs.map((r) =>
            and(
              eq(sdkResourcePermissions.resourceType, r.type),
              eq(sdkResourcePermissions.resourceId, r.id),
            ),
          ),
        ),
      ),
    )
  return new Map(
    rows.map((r) => [`${r.resourceType}:${r.resourceId}`, r.role as SdkResourceRole]),
  )
}

// ─── Mutations (grant / revoke / list — the share operations) ────────────────

/** Upsert a grant on the (user, type, id) unique index — used to share and to stamp ownership at create. */
export const grantSdkPermission = async (
  trx: TxnOrClient,
  userId: number,
  type: SdkResourceType,
  resourceId: string,
  role: SdkResourceRole,
): Promise<void> => {
  await trx
    .insert(sdkResourcePermissions)
    .values({ userId, resourceType: type, resourceId, role })
    .onConflictDoUpdate({
      target: [
        sdkResourcePermissions.userId,
        sdkResourcePermissions.resourceType,
        sdkResourcePermissions.resourceId,
      ],
      set: { role, updatedAt: new Date() },
    })
}

/** Remove a user's grant on a resource (unshare). No-op if none exists. */
export const revokeSdkPermission = async (
  trx: TxnOrClient,
  userId: number,
  type: SdkResourceType,
  resourceId: string,
): Promise<void> => {
  await trx
    .delete(sdkResourcePermissions)
    .where(
      and(
        eq(sdkResourcePermissions.userId, userId),
        eq(sdkResourcePermissions.resourceType, type),
        eq(sdkResourcePermissions.resourceId, resourceId),
      ),
    )
}

/** Everyone with an explicit grant on a resource + their user details — for the share dialog. */
export const listSdkGrantsFor = async (
  trx: TxnOrClient,
  type: SdkResourceType,
  resourceId: string,
): Promise<
  Array<{ userId: number; role: SdkResourceRole; email: string; name: string; photoLink: string | null }>
> => {
  const rows = await trx
    .select({
      userId: sdkResourcePermissions.userId,
      role: sdkResourcePermissions.role,
      email: users.email,
      name: users.name,
      photoLink: users.photoLink,
    })
    .from(sdkResourcePermissions)
    .innerJoin(users, eq(sdkResourcePermissions.userId, users.id))
    .where(
      and(
        eq(sdkResourcePermissions.resourceType, type),
        eq(sdkResourcePermissions.resourceId, resourceId),
      ),
    )
  return rows.map((r) => ({ ...r, role: r.role as SdkResourceRole }))
}
