// The write side of agent → KB grant propagation. Replaces the fragile
// "recompute the justified union" reconciliation (updateCollectionsWithSharedEmails
// + reconcileAgentCollectionGrants): here a derived grant carries its provenance
// (source = agent:<id>), so revoke is an exact delete-by-source, not a re-derivation.
//
// Decoupled from agent.ts on purpose (callers pass the resolved collectionIds in),
// so this module depends only on the acl engine — no circular import.

import { and, eq } from "drizzle-orm"
import type { TxnOrClient } from "@/types"
import { acl } from "@/platform/db/schema"
import { AclPrincipalType, AclRole, AclSourceType } from "@/platform/db/schema/acl"
import {
  AclResourceType,
  resolveAccess,
  grant,
  revokeBySource,
  roleAllows,
  type Principal,
  type ResourceRef,
  type Source,
} from "@/platform/authz"

const agentSource = (agentId: number): Source => ({
  type: AclSourceType.Agent,
  id: String(agentId),
})

const agentRef = (agentId: number): ResourceRef => ({
  type: AclResourceType.Agent,
  id: String(agentId),
})

/** Distinct principals holding any acl grant on the agent — its audience: owners,
 *  explicitly-shared users, and the workspace principal when the agent is public. */
export const agentAudience = async (
  trx: TxnOrClient,
  agentId: number,
): Promise<Principal[]> => {
  const ref = agentRef(agentId)
  const rows = await trx
    .selectDistinct({
      principalType: acl.principalType,
      principalId: acl.principalId,
    })
    .from(acl)
    .where(and(eq(acl.resourceType, ref.type), eq(acl.resourceId, ref.id)))
  return rows.map((r) => ({
    type: r.principalType as (typeof AclPrincipalType)[keyof typeof AclPrincipalType],
    id: r.principalId,
  }))
}

/** User ids that OWN the agent — the authority set: a KB ref only propagates if
 *  some owner still holds editor+ on it (Decision 5, and the legacy owner guard). */
const agentOwnerUserIds = async (
  trx: TxnOrClient,
  agentId: number,
): Promise<number[]> => {
  const ref = agentRef(agentId)
  const rows = await trx
    .select({ principalId: acl.principalId })
    .from(acl)
    .where(
      and(
        eq(acl.resourceType, ref.type),
        eq(acl.resourceId, ref.id),
        eq(acl.principalType, AclPrincipalType.User),
        eq(acl.role, AclRole.Owner),
      ),
    )
  return rows.map((r) => r.principalId)
}

/** Grant read on the agent's KB collections to its audience, tagged
 *  source=agent:<id>. A collection propagates only if some agent owner holds
 *  editor+ on it (grant authority). Idempotent, and never downgrades — effective
 *  access is MAX-of-sources, so an existing higher grant is untouched. */
export const propagateAgentGrants = async (
  trx: TxnOrClient,
  opts: { agentId: number; workspaceId: number; collectionIds: string[] },
): Promise<void> => {
  const { agentId, workspaceId, collectionIds } = opts
  if (collectionIds.length === 0) return
  const audience = await agentAudience(trx, agentId)
  if (audience.length === 0) return
  const owners = await agentOwnerUserIds(trx, agentId)
  const source = agentSource(agentId)

  for (const collectionId of collectionIds) {
    const ref: ResourceRef = {
      type: AclResourceType.Collection,
      id: collectionId,
    }
    let authorized = false
    for (const ownerId of owners) {
      const ownerRole = await resolveAccess(
        trx,
        { userId: ownerId, workspaceId },
        ref,
      )
      if (roleAllows(ownerRole, "share")) {
        authorized = true
        break
      }
    }
    if (!authorized) continue
    for (const principal of audience) {
      await grant(trx, {
        ref,
        principal,
        role: AclRole.Viewer,
        source,
        workspaceId,
      })
    }
  }
}

/** Remove the KB grants this agent produced (unshare, unpublish, ref change,
 *  or delete). Optionally narrowed to one principal or one collection. */
export const revokeAgentGrants = async (
  trx: TxnOrClient,
  agentId: number,
  narrow?: { principal?: Principal; collectionId?: string },
): Promise<void> => {
  const scope: { ref?: ResourceRef; principal?: Principal } = {}
  if (narrow?.collectionId) {
    scope.ref = { type: AclResourceType.Collection, id: narrow.collectionId }
  }
  if (narrow?.principal) scope.principal = narrow.principal
  await revokeBySource(trx, agentSource(agentId), scope)
}

/** Recompute an agent's derived grants from scratch: drop everything it produced,
 *  then re-propagate to its current audience × current refs. The uniform handler
 *  for any share/publish/ref change — dropped collections and removed users fall
 *  out automatically. */
export const repropagateAgentGrants = async (
  trx: TxnOrClient,
  opts: { agentId: number; workspaceId: number; collectionIds: string[] },
): Promise<void> => {
  await revokeAgentGrants(trx, opts.agentId)
  await propagateAgentGrants(trx, opts)
}

/** Removing these owners would orphan referenced KB from the agent — no remaining
 *  owner can justify (editor+) it, so the audience would silently lose it. */
export class NoSilentLossError extends Error {
  public override readonly name = "NoSilentLossError"
  public readonly agentExternalId: string
  public readonly atRiskCollectionIds: string[]
  constructor(agentExternalId: string, atRiskCollectionIds: string[]) {
    super(
      `Removing this owner would orphan ${atRiskCollectionIds.length} referenced collection(s) from agent ${agentExternalId}`,
    )
    this.agentExternalId = agentExternalId
    this.atRiskCollectionIds = atRiskCollectionIds
  }
}

/** The no-silent-loss check: of the agent's referenced collections, which would
 *  lose their last justifying owner if `removingUserIds` are dropped as owners —
 *  i.e. some *removed* owner holds editor+ on it but no *remaining* owner does.
 *  Empty ⇒ the removal loses no files and is safe to proceed. */
export const atRiskCollectionsOnOwnerRemoval = async (
  trx: TxnOrClient,
  opts: {
    agentId: number
    workspaceId: number
    removingUserIds: number[]
    collectionIds: string[]
  },
): Promise<string[]> => {
  const { agentId, workspaceId, removingUserIds, collectionIds } = opts
  if (collectionIds.length === 0 || removingUserIds.length === 0) return []
  const removing = new Set(removingUserIds)
  const remaining = (await agentOwnerUserIds(trx, agentId)).filter(
    (id) => !removing.has(id),
  )
  const hasShare = async (userId: number, collectionId: string) =>
    roleAllows(
      await resolveAccess(trx, { userId, workspaceId }, {
        type: AclResourceType.Collection,
        id: collectionId,
      }),
      "share",
    )

  const atRisk: string[] = []
  for (const collectionId of collectionIds) {
    let remainingJustifies = false
    for (const uid of remaining) {
      if (await hasShare(uid, collectionId)) {
        remainingJustifies = true
        break
      }
    }
    if (remainingJustifies) continue
    // No remaining owner can justify it — at risk only if a *removed* owner did
    // (otherwise it was never propagating and nothing is lost).
    let removedJustified = false
    for (const uid of removingUserIds) {
      if (await hasShare(uid, collectionId)) {
        removedJustified = true
        break
      }
    }
    if (removedJustified) atRisk.push(collectionId)
  }
  return atRisk
}
