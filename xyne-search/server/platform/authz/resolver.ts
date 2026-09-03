// The read side of the ACL engine: the ONE function every access check goes
// through. resolveAccess walks a resource's ancestor chain (KB inheritance),
// collects the viewer's grants (as a user and as the workspace principal), and
// returns the MAX role. `can`/`assertCan` layer capabilities on top.

import { and, eq, or } from "drizzle-orm"
import type { TxnOrClient } from "@/types"
import { acl } from "@/platform/db/schema"
import { AclPrincipalType } from "@/platform/db/schema/acl"
import {
  maxRole,
  roleAllows,
  type Capability,
  type ResourceRef,
  type ResourceType,
  type Role,
  type Viewer,
} from "./types"
import { getDescriptor } from "./registry"

// Safety bound on the ancestor walk (deep folder nesting). Real trees are
// shallow; this just prevents an infinite loop if data is ever cyclic.
const MAX_DEPTH = 64

export class AccessDeniedError extends Error {
  public override readonly name = "AccessDeniedError"
  public readonly ref: ResourceRef
  public readonly capability: Capability
  constructor(ref: ResourceRef, capability: Capability) {
    super(`Access denied: ${capability} on ${ref.type}:${ref.id}`)
    this.ref = ref
    this.capability = capability
  }
}

/** A resource plus all its ancestors — the chain grants inherit down. */
export const ancestorsOf = async (
  trx: TxnOrClient,
  ref: ResourceRef,
): Promise<ResourceRef[]> => {
  const chain: ResourceRef[] = [ref]
  let cur: ResourceRef = ref
  const seen = new Set<string>([`${ref.type}:${ref.id}`])
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const descriptor = getDescriptor(cur.type)
    if (!descriptor) break
    const parent = await descriptor.parentOf(trx, cur.id)
    if (!parent) break
    const key = `${parent.type}:${parent.id}`
    if (seen.has(key)) break // cycle guard
    seen.add(key)
    chain.push(parent)
    cur = parent
  }
  return chain
}

/** Effective role for `viewer` on `ref` = MAX over the viewer's direct grants,
 *  workspace-principal (public) grants, and grants inherited from any ancestor.
 *  `null` = no access. */
export const resolveAccess = async (
  trx: TxnOrClient,
  viewer: Viewer,
  ref: ResourceRef,
): Promise<Role | null> => {
  const chain = await ancestorsOf(trx, ref)
  const nodeMatch = or(
    ...chain.map((n) =>
      and(eq(acl.resourceType, n.type), eq(acl.resourceId, n.id)),
    ),
  )
  const principalMatch = or(
    and(
      eq(acl.principalType, AclPrincipalType.User),
      eq(acl.principalId, viewer.userId),
    ),
    and(
      eq(acl.principalType, AclPrincipalType.Workspace),
      eq(acl.principalId, viewer.workspaceId),
    ),
  )
  const rows = await trx
    .select({ role: acl.role })
    .from(acl)
    .where(and(nodeMatch, principalMatch))

  let best: Role | null = null
  for (const row of rows) best = maxRole(best, row.role as Role)
  return best
}

export const can = async (
  trx: TxnOrClient,
  viewer: Viewer,
  capability: Capability,
  ref: ResourceRef,
): Promise<boolean> => roleAllows(await resolveAccess(trx, viewer, ref), capability)

/** Throws AccessDeniedError when the viewer lacks `capability` on `ref`. */
export const assertCan = async (
  trx: TxnOrClient,
  viewer: Viewer,
  capability: Capability,
  ref: ResourceRef,
): Promise<void> => {
  if (!(await can(trx, viewer, capability, ref))) {
    throw new AccessDeniedError(ref, capability)
  }
}

/** Resolve several refs at once (list endpoints). Keyed `type:id`. */
export const resolveMany = async (
  trx: TxnOrClient,
  viewer: Viewer,
  refs: ReadonlyArray<ResourceRef>,
): Promise<Map<string, Role | null>> => {
  const out = new Map<string, Role | null>()
  await Promise.all(
    refs.map(async (ref) => {
      out.set(`${ref.type}:${ref.id}`, await resolveAccess(trx, viewer, ref))
    }),
  )
  return out
}

/** IDs of resources of `type` the viewer has a direct or workspace grant on —
 *  for "list what I can access" endpoints. Does not expand inheritance downward
 *  (a collection grant isn't unpacked into its folders). */
export const accessibleResourceIds = async (
  trx: TxnOrClient,
  viewer: Viewer,
  resourceType: ResourceType,
): Promise<string[]> => {
  const rows = await trx
    .selectDistinct({ id: acl.resourceId })
    .from(acl)
    .where(
      and(
        eq(acl.resourceType, resourceType),
        or(
          and(
            eq(acl.principalType, AclPrincipalType.User),
            eq(acl.principalId, viewer.userId),
          ),
          and(
            eq(acl.principalType, AclPrincipalType.Workspace),
            eq(acl.principalId, viewer.workspaceId),
          ),
        ),
      ),
    )
  return rows.map((r) => r.id)
}

/** Ids of `resourceType` that are workspace-public (carry a workspace-principal
 *  grant). Derives the is_public / is_private display flag from acl — the single
 *  source — for list endpoints (fetch once, then set-membership per row). */
export const workspacePublicIds = async (
  trx: TxnOrClient,
  resourceType: ResourceType,
  workspaceId: number,
): Promise<Set<string>> => {
  const rows = await trx
    .selectDistinct({ id: acl.resourceId })
    .from(acl)
    .where(
      and(
        eq(acl.resourceType, resourceType),
        eq(acl.principalType, AclPrincipalType.Workspace),
        eq(acl.principalId, workspaceId),
      ),
    )
  return new Set(rows.map((r) => r.id))
}

/** Whether a single resource is workspace-public (for single-resource reads). */
export const isWorkspacePublic = async (
  trx: TxnOrClient,
  ref: ResourceRef,
  workspaceId: number,
): Promise<boolean> => {
  const [row] = await trx
    .select({ id: acl.id })
    .from(acl)
    .where(
      and(
        eq(acl.resourceType, ref.type),
        eq(acl.resourceId, ref.id),
        eq(acl.principalType, AclPrincipalType.Workspace),
        eq(acl.principalId, workspaceId),
      ),
    )
    .limit(1)
  return !!row
}
