import { type Context } from "hono"
import { HTTPException } from "hono/http-exception"

import { db } from "@/platform/db/client"
import {
  getCollectionById,
  getCollectionItemById,
} from "@/platform/db/knowledgeBase"
import type { Collection, CollectionItem } from "@/platform/db/schema"
import { getUserByEmail } from "@/platform/db/user"
import {
  AclResourceType,
  resolveAccess,
  roleAllows,
  type Role,
} from "@/platform/authz"

export type KbRouteVars = {
  jwtPayload: { sub: string; workspaceId: string }
}

export type Actor = {
  id: number
  email: string
  workspaceId: number
  workspaceExternalId: string
}

export type CollectionAccess = {
  collection: Collection
  /** Effective role: owner | editor | viewer. */
  role: Role
  /** editor+ — upload / edit / add files, and share to others. */
  canWrite: boolean
  /** owner — delete the collection, change settings, transfer. */
  canManage: boolean
}

export const loadActor = async (
  c: Context<{ Variables: KbRouteVars }>,
): Promise<Actor> => {
  const email = c.get("jwtPayload").sub
  const users = await getUserByEmail(db, email)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const u = users[0]!
  return {
    id: u.id,
    email: u.email,
    workspaceId: u.workspaceId,
    workspaceExternalId: u.workspaceExternalId,
  }
}

/** Enforce read access and compute write/manage capability in one pass, via the
 *  unified ACL resolver (owner/editor/viewer + workspace-public + folder
 *  inheritance). Replaces the legacy owner_id/permissions[]/is_private check. */
export const loadCollection = async (
  clId: string,
  actor: Actor,
): Promise<CollectionAccess> => {
  const collection = await getCollectionById(db, clId)
  if (!collection) {
    throw new HTTPException(404, { message: "Collection not found" })
  }
  const role = await resolveAccess(
    db,
    { userId: actor.id, workspaceId: actor.workspaceId },
    { type: AclResourceType.Collection, id: clId },
  )
  if (role === null) {
    throw new HTTPException(403, { message: "Forbidden" })
  }
  return {
    collection,
    role,
    canWrite: roleAllows(role, "write"),
    canManage: roleAllows(role, "delete"),
  }
}

/** editor+ — upload / edit / add files, share to others. */
export const assertCanWrite = (access: CollectionAccess): void => {
  if (!access.canWrite) {
    throw new HTTPException(403, { message: "Editor access required" })
  }
}

/** owner — delete the collection, change settings, transfer ownership. */
export const assertCanManage = (access: CollectionAccess): void => {
  if (!access.canManage) {
    throw new HTTPException(403, { message: "Owner access required" })
  }
}

export type ItemAccess = {
  item: CollectionItem
  /** Effective role on the file/folder: owner | editor | viewer. */
  role: Role
  /** editor+ — rename / delete / add children. */
  canWrite: boolean
  /** owner — of the item itself. */
  canManage: boolean
}

/** Resolve access to a single KB item (file or folder) at its own grain. The
 *  resolver walks item → folder → collection, so a collection-level grant still
 *  admits the item (backward compatible) AND a direct file/folder grant works
 *  (per-item sharing) — a strict superset of the old collection-only check. */
export const loadItemAccess = async (
  clId: string,
  itemId: string,
  actor: Actor,
): Promise<ItemAccess> => {
  const item = await getCollectionItemById(db, itemId)
  if (!item || item.collectionId !== clId) {
    throw new HTTPException(404, { message: "Item not found" })
  }
  const refType =
    item.type === "folder" ? AclResourceType.Folder : AclResourceType.File
  const role = await resolveAccess(
    db,
    { userId: actor.id, workspaceId: actor.workspaceId },
    { type: refType, id: itemId },
  )
  if (role === null) {
    throw new HTTPException(403, { message: "Forbidden" })
  }
  return {
    item,
    role,
    canWrite: roleAllows(role, "write"),
    canManage: roleAllows(role, "delete"),
  }
}

/** editor+ on the item — rename / delete / add children. */
export const assertItemCanWrite = (access: ItemAccess): void => {
  if (!access.canWrite) {
    throw new HTTPException(403, { message: "Editor access required" })
  }
}
