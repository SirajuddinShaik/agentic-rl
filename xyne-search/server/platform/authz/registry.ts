// Resource registry: the only place that knows the *shape* of each resource
// type. Each descriptor answers two questions the engine needs:
//   - parentOf(id): the containing resource, for inheritance (KB: folder ->
//     parent folder -> collection). null for flat/root resources.
//   - workspaceOf(id): the resource's workspace, for stamping new grant rows.
// Adding a resource type (project, data_source, …) = register a descriptor;
// no change to the resolver or propagation engine.

import { eq } from "drizzle-orm"
import type { TxnOrClient } from "@/types"
import {
  collections,
  collectionItems,
  agents,
  skills,
  mcps,
  users,
} from "@/platform/db/schema"
import { AclResourceType, type ResourceRef, type ResourceType } from "./types"

export type ResourceDescriptor = {
  parentOf: (trx: TxnOrClient, id: string) => Promise<ResourceRef | null>
  workspaceOf: (trx: TxnOrClient, id: string) => Promise<number | null>
}

// Folders and files are both rows in collection_items, so they share one
// descriptor: inherit from the parent folder, or the collection at the root.
const collectionItemDescriptor: ResourceDescriptor = {
  parentOf: async (trx, id) => {
    const [row] = await trx
      .select({
        parentId: collectionItems.parentId,
        collectionId: collectionItems.collectionId,
      })
      .from(collectionItems)
      .where(eq(collectionItems.id, id))
      .limit(1)
    if (!row) return null
    return row.parentId
      ? { type: AclResourceType.Folder, id: row.parentId }
      : { type: AclResourceType.Collection, id: row.collectionId }
  },
  workspaceOf: async (trx, id) => {
    const [row] = await trx
      .select({ workspaceId: collectionItems.workspaceId })
      .from(collectionItems)
      .where(eq(collectionItems.id, id))
      .limit(1)
    return row?.workspaceId ?? null
  },
}

const descriptors: Partial<Record<ResourceType, ResourceDescriptor>> = {
  // A KB collection is a root — no parent. Its own workspace column.
  [AclResourceType.Collection]: {
    parentOf: async () => null,
    workspaceOf: async (trx, id) => {
      const [row] = await trx
        .select({ workspaceId: collections.workspaceId })
        .from(collections)
        .where(eq(collections.id, id))
        .limit(1)
      return row?.workspaceId ?? null
    },
  },

  [AclResourceType.Folder]: collectionItemDescriptor,
  [AclResourceType.File]: collectionItemDescriptor,

  // Agents are flat. resourceId is the numeric agents.id as text.
  [AclResourceType.Agent]: {
    parentOf: async () => null,
    workspaceOf: async (trx, id) => {
      const numeric = Number(id)
      if (!Number.isFinite(numeric)) return null
      const [row] = await trx
        .select({ workspaceId: agents.workspaceId })
        .from(agents)
        .where(eq(agents.id, numeric))
        .limit(1)
      return row?.workspaceId ?? null
    },
  },

  // Skills have no workspace column — their workspace is the creator's.
  [AclResourceType.Skill]: {
    parentOf: async () => null,
    workspaceOf: async (trx, id) => {
      const [row] = await trx
        .select({ workspaceId: users.workspaceId })
        .from(skills)
        .innerJoin(users, eq(users.id, skills.createdBy))
        .where(eq(skills.id, id))
        .limit(1)
      return row?.workspaceId ?? null
    },
  },

  // MCPs mirror skills: flat, workspace = creator's.
  [AclResourceType.Mcp]: {
    parentOf: async () => null,
    workspaceOf: async (trx, id) => {
      const [row] = await trx
        .select({ workspaceId: users.workspaceId })
        .from(mcps)
        .innerJoin(users, eq(users.id, mcps.createdBy))
        .where(eq(mcps.id, id))
        .limit(1)
      return row?.workspaceId ?? null
    },
  },
}

export const registerResource = (
  type: ResourceType,
  descriptor: ResourceDescriptor,
): void => {
  descriptors[type] = descriptor
}

export const getDescriptor = (
  type: ResourceType,
): ResourceDescriptor | undefined => descriptors[type]
