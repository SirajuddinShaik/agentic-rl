// Pure types + role/capability logic for the ACL engine. No DB access here so
// this stays trivially testable and importable from anywhere.

import {
  AclResourceType,
  AclRole,
  type AclResourceType as ResourceType,
  type AclRole as Role,
} from "@/platform/db/schema/acl"

export { AclResourceType, AclRole }
export type { ResourceType, Role }

/** A resource to check access on: `{ type, id }` where `id` is the resource's
 *  primary key as a string (uuid for collection/folder/skill/project, the
 *  numeric id for agents). */
export type ResourceRef = { type: ResourceType; id: string }

/** The acting user, by internal ids (matches the app's Viewer / KB Actor). */
export type Viewer = { userId: number; workspaceId: number }

/** Higher rank = more access. */
export const ROLE_RANK: Record<Role, number> = {
  [AclRole.Viewer]: 1,
  [AclRole.Editor]: 2,
  [AclRole.Owner]: 3,
}

/** Effective role = the max over all of a viewer's grants (direct + inherited). */
export const maxRole = (a: Role | null, b: Role | null): Role | null => {
  if (!a) return b
  if (!b) return a
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b
}

export type Capability = "read" | "write" | "share" | "delete" | "manage"

/** Minimum role each capability requires. viewer=read; editor=write+share
 *  (an editor can grant others — the re-share authority); owner=+delete/manage. */
const CAPABILITY_MIN_ROLE: Record<Capability, Role> = {
  read: AclRole.Viewer,
  write: AclRole.Editor,
  share: AclRole.Editor,
  delete: AclRole.Owner,
  manage: AclRole.Owner,
}

export const roleAllows = (role: Role | null, cap: Capability): boolean =>
  role !== null && ROLE_RANK[role] >= ROLE_RANK[CAPABILITY_MIN_ROLE[cap]]
