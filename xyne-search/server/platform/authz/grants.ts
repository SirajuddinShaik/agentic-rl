// The write side of the ACL engine: create/remove grant rows. Provenance-aware
// so the propagation engine (Phase 4) can revoke exactly one share's grants via
// revokeBySource without touching independent (direct) or other-source grants.

import { and, eq, sql } from "drizzle-orm"
import type { TxnOrClient } from "@/types"
import { acl } from "@/platform/db/schema"
import {
  AclSourceType,
  type SelectAcl,
  type AclPrincipalType,
  type AclSourceType as SourceType,
} from "@/platform/db/schema/acl"
import type { ResourceRef, Role } from "./types"
import { getDescriptor } from "./registry"

export type Principal = { type: AclPrincipalType; id: number }
export type Source = { type: SourceType; id: string }

/** The provenance tag for an explicit (non-derived) share. */
export const DIRECT: Source = { type: AclSourceType.Direct, id: "" }

/** Insert or upsert a grant. Idempotent on (resource, principal, source). */
export const grant = async (
  trx: TxnOrClient,
  opts: {
    ref: ResourceRef
    principal: Principal
    role: Role
    source?: Source
    workspaceId?: number
    createdBy?: number | null
  },
): Promise<void> => {
  const source = opts.source ?? DIRECT
  const workspaceId =
    opts.workspaceId ??
    (await getDescriptor(opts.ref.type)?.workspaceOf(trx, opts.ref.id)) ??
    null
  if (workspaceId === null) {
    throw new Error(
      `Cannot resolve workspace for ${opts.ref.type}:${opts.ref.id}`,
    )
  }
  await trx
    .insert(acl)
    .values({
      workspaceId,
      resourceType: opts.ref.type,
      resourceId: opts.ref.id,
      principalType: opts.principal.type,
      principalId: opts.principal.id,
      role: opts.role,
      sourceType: source.type,
      sourceId: source.id,
      createdBy: opts.createdBy ?? null,
    })
    .onConflictDoUpdate({
      target: [
        acl.resourceType,
        acl.resourceId,
        acl.principalType,
        acl.principalId,
        acl.sourceType,
        acl.sourceId,
      ],
      set: { role: opts.role, updatedAt: sql`NOW()` },
    })
}

/** Delete grants produced by a given source (an agent/project share), optionally
 *  narrowed to a specific resource and/or principal. The cascade primitive. */
export const revokeBySource = async (
  trx: TxnOrClient,
  source: Source,
  narrow?: { ref?: ResourceRef; principal?: Principal },
): Promise<void> => {
  const conds = [eq(acl.sourceType, source.type), eq(acl.sourceId, source.id)]
  if (narrow?.ref) {
    conds.push(
      eq(acl.resourceType, narrow.ref.type),
      eq(acl.resourceId, narrow.ref.id),
    )
  }
  if (narrow?.principal) {
    conds.push(
      eq(acl.principalType, narrow.principal.type),
      eq(acl.principalId, narrow.principal.id),
    )
  }
  await trx.delete(acl).where(and(...conds))
}

/** Remove one specific grant (a direct un-share). */
export const revokeGrant = async (
  trx: TxnOrClient,
  opts: { ref: ResourceRef; principal: Principal; source?: Source },
): Promise<void> => {
  const source = opts.source ?? DIRECT
  await trx
    .delete(acl)
    .where(
      and(
        eq(acl.resourceType, opts.ref.type),
        eq(acl.resourceId, opts.ref.id),
        eq(acl.principalType, opts.principal.type),
        eq(acl.principalId, opts.principal.id),
        eq(acl.sourceType, source.type),
        eq(acl.sourceId, source.id),
      ),
    )
}

/** Remove every grant on a resource (when the resource itself is deleted). */
export const revokeAllForResource = async (
  trx: TxnOrClient,
  ref: ResourceRef,
): Promise<void> => {
  await trx
    .delete(acl)
    .where(
      and(eq(acl.resourceType, ref.type), eq(acl.resourceId, ref.id)),
    )
}

/** Every grant on a resource — who has access, for the share UI. */
export const listGrants = async (
  trx: TxnOrClient,
  ref: ResourceRef,
): Promise<SelectAcl[]> =>
  trx
    .select()
    .from(acl)
    .where(and(eq(acl.resourceType, ref.type), eq(acl.resourceId, ref.id)))
