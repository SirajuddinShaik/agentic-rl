import {
  KB_METADATA_SYNC_STATUS,
  collections,
  collectionLsProjections,
  collectionItems,
  type Collection,
  type CollectionLsProjection,
  type NewCollection,
  type CollectionItem,
  type NewCollectionItem,
  type File,
} from "@/platform/db/schema"

import { createId } from "@paralleldrive/cuid2"
import type { TxnOrClient } from "@/types"
import { and, asc, desc, eq, isNull, sql, inArray } from "drizzle-orm"
import { UploadStatus } from "@/platform/shared/types"
import { resolveAccess, AclResourceType } from "@/platform/authz"
import { getUserByEmail } from "./user"

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

export const touchCollectionLsStructure = async (
  trx: TxnOrClient,
  collectionId: string,
): Promise<void> => {
  await trx
    .update(collections)
    .set({
      collectionSourceUpdatedAt: sql`NOW()`,
      updatedAt: sql`NOW()`,
    })
    .where(eq(collections.id, collectionId))
}

export const touchCollectionLsStructures = async (
  trx: TxnOrClient,
  collectionIds: string[],
): Promise<void> => {
  const uniqueCollectionIds = [...new Set(collectionIds.filter(Boolean))]
  if (!uniqueCollectionIds.length) return

  await trx
    .update(collections)
    .set({
      collectionSourceUpdatedAt: sql`NOW()`,
      updatedAt: sql`NOW()`,
    })
    .where(inArray(collections.id, uniqueCollectionIds))
}

export const getCollectionLsProjection = async (
  trx: TxnOrClient,
  collectionId: string,
): Promise<CollectionLsProjection | null> => {
  const [result] = await trx
    .select()
    .from(collectionLsProjections)
    .where(eq(collectionLsProjections.collectionId, collectionId))

  return result || null
}

export const upsertCollectionLsProjection = async (
  trx: TxnOrClient,
  params: {
    collectionId: string
    projection: Record<string, unknown>
    lsCollectionProjectionUpdatedAt: Date
    lastError?: string | null
  },
): Promise<CollectionLsProjection> => {
  const [result] = await trx
    .insert(collectionLsProjections)
    .values({
      collectionId: params.collectionId,
      projection: params.projection,
      lsCollectionProjectionUpdatedAt: params.lsCollectionProjectionUpdatedAt,
      lastError: params.lastError ?? null,
    })
    .onConflictDoUpdate({
      target: collectionLsProjections.collectionId,
      set: {
        projection: params.projection,
        lsCollectionProjectionUpdatedAt: params.lsCollectionProjectionUpdatedAt,
        lastError: params.lastError ?? null,
        updatedAt: sql`NOW()`,
      },
    })
    .returning()

  if (!result) {
    throw new Error("Failed to upsert collection ls projection")
  }

  return result
}

export const recordCollectionLsProjectionError = async (
  trx: TxnOrClient,
  collectionId: string,
  lastError: string,
): Promise<void> => {
  await trx
    .insert(collectionLsProjections)
    .values({
      collectionId,
      projection: {
        rootIds: [],
        childrenByParentId: {},
        nodesById: {},
        nodeIdByPath: {},
      },
      lsCollectionProjectionUpdatedAt: new Date(0),
      lastError,
    })
    .onConflictDoUpdate({
      target: collectionLsProjections.collectionId,
      set: {
        lastError,
        updatedAt: sql`NOW()`,
      },
    })
}

// Collection CRUD operations
export const createCollection = async (
  trx: TxnOrClient,
  collection: Omit<NewCollection, "vespaDocId">,
): Promise<Collection> => {
  const vespaDocId = generateCollectionVespaDocId()
  const metadata =
    collection.metadata &&
    typeof collection.metadata === "object" &&
    !Array.isArray(collection.metadata)
      ? { ...collection.metadata, vespaDocId }
      : collection.metadata

  const collectionData: NewCollection = {
    ...collection,
    uploadStatus: UploadStatus.COMPLETED,
    vespaMetadataSyncStatus: KB_METADATA_SYNC_STATUS.PENDING,
    vespaMetadataSyncAttempts: 0,
    vespaMetadataSyncError: null,
    vespaMetadataSyncedAt: null,
    vespaMetadataSyncNextAttemptAt: null,
    vespaMetadataSyncStartedAt: null,
    metadata,
    vespaDocId,
  }

  const [result] = await trx
    .insert(collections)
    .values(collectionData)
    .returning()
  if (!result) {
    throw new Error("Failed to create collection")
  }
  return result
}

export const getCollectionById = async (
  trx: TxnOrClient,
  collectionId: string,
): Promise<Collection | null> => {
  const [result] = await trx
    .select()
    .from(collections)
    .where(and(eq(collections.id, collectionId), isNull(collections.deletedAt)))
  return result || null
}

// getCollectionsByOwner / getAccessibleCollections (legacy owner_id / permissions
// / is_private access predicate) removed — accessible collections now resolve
// through the unified ACL (accessibleResourceIds).

export const updateCollection = async (
  trx: TxnOrClient,
  collectionId: string,
  updates: Partial<NewCollection>,
): Promise<Collection> => {
  const shouldMarkMetadataSyncPending =
    hasOwn(updates, "name") ||
    hasOwn(updates, "description") ||
    hasOwn(updates, "metadata") ||
    hasOwn(updates, "lastUpdatedByEmail") ||
    hasOwn(updates, "lastUpdatedById")
  const metadataSyncUpdates = shouldMarkMetadataSyncPending
    ? {
        vespaMetadataSyncStatus: KB_METADATA_SYNC_STATUS.PENDING,
        vespaMetadataSyncAttempts: 0,
        vespaMetadataSyncError: null,
        vespaMetadataSyncedAt: null,
        vespaMetadataSyncNextAttemptAt: null,
        vespaMetadataSyncStartedAt: null,
      }
    : {}

  const [result] = await trx
    .update(collections)
    .set({
      ...updates,
      ...metadataSyncUpdates,
      updatedAt: sql`NOW()`,
    })
    .where(eq(collections.id, collectionId))
    .returning()
  if (!result) {
    throw new Error("Collection not found")
  }
  return result
}

export const softDeleteCollection = async (
  trx: TxnOrClient,
  collectionId: string,
): Promise<Collection> => {
  await touchCollectionLsStructure(trx, collectionId)

  const [result] = await trx
    .update(collections)
    .set({
      deletedAt: sql`NOW()`,
      updatedAt: sql`NOW()`,
    })
    .where(eq(collections.id, collectionId))
    .returning()
  if (!result) {
    throw new Error("Collection not found")
  }
  return result
}

// Collection Items (Folders and Files) operations
export const createCollectionItem = async (
  trx: TxnOrClient,
  item: NewCollectionItem,
): Promise<CollectionItem> => {
  const [result] = await trx.insert(collectionItems).values(item).returning()
  if (!result) {
    throw new Error("Failed to create collection item")
  }
  return result
}

export const getCollectionItemById = async (
  trx: TxnOrClient,
  itemId: string,
): Promise<CollectionItem | null> => {
  const [result] = await trx
    .select()
    .from(collectionItems)
    .where(
      and(eq(collectionItems.id, itemId), isNull(collectionItems.deletedAt)),
    )
  return result || null
}

export const getCollectionItemsByParent = async (
  trx: TxnOrClient,
  collectionId: string,
  parentId: string | null,
): Promise<CollectionItem[]> => {
  return await trx
    .select()
    .from(collectionItems)
    .where(
      and(
        eq(collectionItems.collectionId, collectionId),
        parentId
          ? eq(collectionItems.parentId, parentId)
          : isNull(collectionItems.parentId),
        isNull(collectionItems.deletedAt),
      ),
    )
    .orderBy(
      desc(collectionItems.type),
      asc(collectionItems.position),
      asc(collectionItems.name),
    )
}

export const getCollectionItemsByParentPaginated = async (
  trx: TxnOrClient,
  collectionId: string,
  parentId: string | null,
  opts: { limit: number; offset: number },
): Promise<{
  items: CollectionItem[]
  total: number
  folderCount: number
  fileCount: number
}> => {
  const whereClause = and(
    eq(collectionItems.collectionId, collectionId),
    parentId
      ? eq(collectionItems.parentId, parentId)
      : isNull(collectionItems.parentId),
    isNull(collectionItems.deletedAt),
  )
  const [items, countRows] = await Promise.all([
    trx
      .select()
      .from(collectionItems)
      .where(whereClause)
      .orderBy(
        desc(collectionItems.type),
        asc(collectionItems.position),
        asc(collectionItems.name),
      )
      .limit(opts.limit)
      .offset(opts.offset),
    trx
      .select({
        folderCount: sql<number>`COUNT(*) FILTER (WHERE ${collectionItems.type} = 'folder')::int`,
        fileCount: sql<number>`COUNT(*) FILTER (WHERE ${collectionItems.type} = 'file')::int`,
      })
      .from(collectionItems)
      .where(whereClause),
  ])
  const folderCount = countRows[0]?.folderCount ?? 0
  const fileCount = countRows[0]?.fileCount ?? 0
  return {
    items,
    total: folderCount + fileCount,
    folderCount,
    fileCount,
  }
}

export const getCollectionItemByPath = async (
  trx: TxnOrClient,
  collectionId: string,
  path: string,
  name: string,
): Promise<CollectionItem | null> => {
  const [result] = await trx
    .select()
    .from(collectionItems)
    .where(
      and(
        eq(collectionItems.collectionId, collectionId),
        eq(collectionItems.path, path),
        eq(collectionItems.name, name),
        isNull(collectionItems.deletedAt),
      ),
    )
  return result || null
}

export const updateCollectionItem = async (
  trx: TxnOrClient,
  itemId: string,
  updates: Partial<NewCollectionItem>,
): Promise<CollectionItem> => {
  const existing = await getCollectionItemById(trx, itemId)
  if (!existing) {
    throw new Error("Collection item not found")
  }

  const nameChanged =
    hasOwn(updates, "name") && updates.name !== existing.name
  const pathChanged =
    hasOwn(updates, "path") && updates.path !== existing.path
  const parentIdChanged =
    hasOwn(updates, "parentId") && updates.parentId !== existing.parentId
  const collectionChanged =
    hasOwn(updates, "collectionId") &&
    typeof updates.collectionId === "string" &&
    updates.collectionId !== existing.collectionId
  const shouldMarkMetadataSyncPending =
    existing.type === "folder" &&
    (nameChanged ||
      pathChanged ||
      parentIdChanged ||
      collectionChanged ||
      hasOwn(updates, "metadata") ||
      hasOwn(updates, "lastUpdatedByEmail") ||
      hasOwn(updates, "lastUpdatedById"))
  const metadataSyncUpdates = shouldMarkMetadataSyncPending
    ? {
        vespaMetadataSyncStatus: KB_METADATA_SYNC_STATUS.PENDING,
        vespaMetadataSyncAttempts: 0,
        vespaMetadataSyncError: null,
        vespaMetadataSyncedAt: null,
        vespaMetadataSyncNextAttemptAt: null,
        vespaMetadataSyncStartedAt: null,
      }
    : {}

  const [result] = await trx
    .update(collectionItems)
    .set({
      ...updates,
      ...metadataSyncUpdates,
      updatedAt: sql`NOW()`,
    })
    .where(eq(collectionItems.id, itemId))
    .returning()
  if (!result) {
    throw new Error("Collection item not found")
  }

  if (nameChanged || pathChanged || parentIdChanged || collectionChanged) {
    const affectedCollectionIds = collectionChanged
      ? [existing.collectionId, updates.collectionId as string]
      : [existing.collectionId]

    if (affectedCollectionIds.length === 1) {
      await touchCollectionLsStructure(trx, affectedCollectionIds[0]!)
    } else {
      await touchCollectionLsStructures(trx, affectedCollectionIds)
    }
  }

  return result
}

export const softDeleteCollectionItem = async (
  trx: TxnOrClient,
  itemId: string,
): Promise<CollectionItem> => {
  const item = await getCollectionItemById(trx, itemId)
  if (!item) {
    throw new Error("Collection item not found")
  }

  await touchCollectionLsStructure(trx, item.collectionId)

  if (item.type === "folder") {
    const markDescendantsAsDeleted = async (
      parentId: string,
    ): Promise<number> => {
      const children = await trx
        .select()
        .from(collectionItems)
        .where(
          and(
            eq(collectionItems.parentId, parentId),
            isNull(collectionItems.deletedAt),
          ),
        )

      // Only file counts are decremented for parents.
      let filesDeleted = children.filter((c) => c.type === "file").length

      if (children.length > 0) {
        await trx
          .update(collectionItems)
          .set({
            deletedAt: sql`NOW()`,
            updatedAt: sql`NOW()`,
          })
          .where(
            and(
              eq(collectionItems.parentId, parentId),
              isNull(collectionItems.deletedAt),
            ),
          )

        for (const child of children) {
          if (child.type === "folder") {
            filesDeleted += await markDescendantsAsDeleted(child.id)
          }
        }
      }

      return filesDeleted
    }

    await trx
      .update(collectionItems)
      .set({
        deletedAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      })
      .where(eq(collectionItems.id, itemId))

    const descendantFilesCount = await markDescendantsAsDeleted(itemId)

    // Direct children count drives the collection total (files + folders).
    const directChildren = await trx
      .select()
      .from(collectionItems)
      .where(
        and(
          eq(collectionItems.parentId, itemId),
          isNull(collectionItems.deletedAt),
        ),
      )

    // Total decrements by direct children plus the folder itself.
    await updateCollectionTotalCount(
      trx,
      item.collectionId,
      -(directChildren.length + 1),
    )

    if (item.parentId) {
      await updateParentFolderCounts(trx, item.parentId, -descendantFilesCount)
    }
  } else {
    await trx
      .update(collectionItems)
      .set({
        deletedAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      })
      .where(eq(collectionItems.id, itemId))

    await updateCollectionTotalCount(trx, item.collectionId, -1)

    if (item.parentId) {
      await updateParentFolderCounts(trx, item.parentId, -1)
    }
  }

  const [result] = await trx
    .select()
    .from(collectionItems)
    .where(eq(collectionItems.id, itemId))

  if (!result) {
    throw new Error("Collection item not found")
  }

  return result
}

export const updateCollectionTotalCount = async (
  trx: TxnOrClient,
  collectionId: string,
  delta: number,
): Promise<void> => {
  await trx
    .update(collections)
    .set({
      totalItems: sql`${collections.totalItems} + ${delta}`,
      updatedAt: sql`NOW()`,
    })
    .where(eq(collections.id, collectionId))
}

export const updateFolderTotalCount = async (
  trx: TxnOrClient,
  folderId: string,
  delta: number,
): Promise<void> => {
  await trx
    .update(collectionItems)
    .set({
      totalFileCount: sql`${collectionItems.totalFileCount} + ${delta}`,
      updatedAt: sql`NOW()`,
    })
    .where(
      and(eq(collectionItems.id, folderId), eq(collectionItems.type, "folder")),
    )
}

// Walk up the folder chain, applying delta to each ancestor's totalFileCount.
export const updateParentFolderCounts = async (
  trx: TxnOrClient,
  parentId: string | null,
  delta: number,
): Promise<void> => {
  if (!parentId) return

  await updateFolderTotalCount(trx, parentId, delta)

  const parentFolder = await getCollectionItemById(trx, parentId)
  if (parentFolder && parentFolder.parentId) {
    await updateParentFolderCounts(trx, parentFolder.parentId, delta)
  }
}

export const createFolder = async (
  trx: TxnOrClient,
  collectionId: string,
  parentId: string | null,
  name: string,
  metadata: any = {},
  userId?: number,
  userEmail?: string,
): Promise<CollectionItem> => {
  const collection = await getCollectionById(trx, collectionId)
  if (!collection) {
    throw new Error("Collection not found")
  }

  // path is the parent's ancestry: parent.path + parent.name + "/".
  let path = "/"
  if (parentId) {
    const parent = await getCollectionItemById(trx, parentId)
    if (!parent) {
      throw new Error("Parent folder not found")
    }
    if (parent.type !== "folder") {
      throw new Error("Parent must be a folder")
    }
    path = parent.path + parent.name + "/"
  }

  const existing = await getCollectionItemByPath(trx, collectionId, path, name)
  if (existing) {
    throw new Error("Folder already exists at this path")
  }

  const siblings = await getCollectionItemsByParent(trx, collectionId, parentId)
  const nextPosition = siblings.length

  const vespaDocId = generateFolderVespaDocId()

  const folder = await createCollectionItem(trx, {
    collectionId: collectionId,
    parentId,
    workspaceId: collection.workspaceId,
    name,
    type: "folder",
    path,
    position: nextPosition,
    vespaDocId,
    totalFileCount: 0,
    originalName: name,
    mimeType: "application/x-folder",
    fileSize: null,
    checksum: null,
    storagePath: null,
    storageKey: null,
    uploadedById: userId,
    uploadedByEmail: userEmail,
    lastUpdatedById: userId,
    lastUpdatedByEmail: userEmail,
    processingInfo: {
      version: "1.0",
      lastModified: Date.now(),
      tags: metadata.tags || [],
    },
    processedAt: new Date(),
    uploadStatus: UploadStatus.COMPLETED,
    statusMessage: "Successfully processed folder",
    vespaMetadataSyncStatus: KB_METADATA_SYNC_STATUS.PENDING,
    vespaMetadataSyncAttempts: 0,
    vespaMetadataSyncError: null,
    vespaMetadataSyncedAt: null,
    vespaMetadataSyncNextAttemptAt: null,
    vespaMetadataSyncStartedAt: null,
    metadata,
  })

  await touchCollectionLsStructure(trx, collectionId)
  await updateCollectionTotalCount(trx, collectionId, 1)

  return folder
}

export const createFileItem = async (
  trx: TxnOrClient,
  collectionId: string,
  parentId: string | null,
  name: string,
  vespaDocId: string,
  originalName: string,
  storagePath: string,
  storageKey: string,
  mimeType: string | null,
  fileSize: number | null,
  checksum: string | null,
  metadata: any = {},
  userId?: number,
  userEmail?: string,
  statusMessage?: string,
): Promise<CollectionItem> => {
  const collection = await getCollectionById(trx, collectionId)
  if (!collection) {
    throw new Error("Collection not found")
  }

  // path is the parent's ancestry: parent.path + parent.name + "/".
  let path = "/"
  if (parentId) {
    const parent = await getCollectionItemById(trx, parentId)
    if (!parent) {
      throw new Error("Parent folder not found")
    }
    if (parent.type !== "folder") {
      throw new Error("Parent must be a folder")
    }
    path = parent.path + parent.name + "/"
  }

  const existing = await getCollectionItemByPath(trx, collectionId, path, name)
  if (existing) {
    throw new Error("File already exists at this path")
  }

  const siblings = await getCollectionItemsByParent(trx, collectionId, parentId)
  const nextPosition = siblings.length

  const item = await createCollectionItem(trx, {
    collectionId: collectionId,
    parentId,
    workspaceId: collection.workspaceId,
    name,
    type: "file",
    path,
    position: nextPosition,
    vespaDocId,
    originalName,
    storagePath,
    storageKey,
    mimeType,
    fileSize,
    checksum,
    uploadedById: userId,
    uploadedByEmail: userEmail,
    lastUpdatedById: userId,
    lastUpdatedByEmail: userEmail,
    statusMessage,
    metadata,
  })

  await touchCollectionLsStructure(trx, collectionId)
  await updateCollectionTotalCount(trx, collectionId, 1)

  if (parentId) {
    await updateParentFolderCounts(trx, parentId, 1)
  }

  // A new file flips its parent (folder or collection) to PROCESSING.
  if (parentId) {
    await markParentAsProcessing(trx, parentId, false)
  } else {
    await markParentAsProcessing(trx, collectionId, true)
  }

  return item
}

export const getAllCollectionItems = async (
  trx: TxnOrClient,
  collectionId: string,
): Promise<CollectionItem[]> => {
  const items = await trx
    .select()
    .from(collectionItems)
    .where(
      and(
        eq(collectionItems.collectionId, collectionId),
        isNull(collectionItems.deletedAt),
      ),
    )
    .orderBy(
      desc(collectionItems.type),
      asc(collectionItems.position),
      asc(collectionItems.name),
    )

  return items
}

// Helper functions for traversing folder structure
export const getParentItems = async (
  parentId: string,
  trx: TxnOrClient,
): Promise<CollectionItem[]> => {
  const results = await trx
    .select()
    .from(collectionItems)
    .where(
      and(
        eq(collectionItems.parentId, parentId),
        isNull(collectionItems.deletedAt),
      ),
    )
  return results
}

export const getAllCollectionAndFolderItems = async (
  parentIds: string[],
  trx: TxnOrClient,
) => {
  const fileIds: string[] = []
  const folderIds: string[] = []
  type Q = { itemId: string }
  const queue: Q[] = []

  for (const input of parentIds) {
    if (input.startsWith("cl-")) {
      // cl- = collection vespa docId -> fetch top-level items
      const [col] = await trx
        .select({ id: collections.id })
        .from(collections)
        .where(
          and(eq(collections.vespaDocId, input), isNull(collections.deletedAt)),
        )
      if (!col) continue
      const roots = await trx
        .select({ id: collectionItems.id, type: collectionItems.type })
        .from(collectionItems)
        .where(
          and(
            eq(collectionItems.collectionId, col.id),
            isNull(collectionItems.parentId),
            isNull(collectionItems.deletedAt),
          ),
        )
      roots.forEach((r) => queue.push({ itemId: r.id }))
      roots.forEach((r) => {
        if (r.type == "folder") {
          folderIds.push(r.id)
        } else if (r.type == "file") {
          fileIds.push(r.id)
        }
      })
    } else if (input.startsWith("clfd-")) {
      // clfd- = folder vespa docId -> resolve to item id
      const [folder] = await trx
        .select({ id: collectionItems.id })
        .from(collectionItems)
        .where(
          and(
            eq(collectionItems.vespaDocId, input),
            isNull(collectionItems.deletedAt),
          ),
        )
      if (folder) {
        queue.push({ itemId: folder.id })
        folderIds.push(folder.id)
      }
    } else if (input.startsWith("clf-")) {
      const [fileid] = await trx
        .select({ id: collectionItems.id })
        .from(collectionItems)
        .where(
          and(
            eq(collectionItems.vespaDocId, input),
            isNull(collectionItems.deletedAt),
          ),
        )
      if (fileid) fileIds.push(fileid.id)
    } else {
      // Assume it's a DB item id (UUID)
      queue.push({ itemId: input })
    }
  }

  // BFS: collect all file item ids under the given seeds
  while (queue.length > 0) {
    const { itemId } = queue.shift()!
    const children = await trx
      .select()
      .from(collectionItems)
      .where(
        and(
          eq(collectionItems.parentId, itemId),
          isNull(collectionItems.deletedAt),
        ),
      )
    if (children.length === 0) {
      // No children: a file leaf or an invalid id — only push files.
      const node = await getCollectionItemById(trx, itemId)
      if (node && node.type === "file") fileIds.push(itemId)
      continue
    }
    for (const child of children) {
      if (child.type === "folder") {
        folderIds.push(child.id)
        queue.push({ itemId: child.id })
      } else if (child.type === "file") {
        fileIds.push(child.id)
      }
    }
  }
  return { fileIds, folderIds }
}

// Keep the old function for backward compatibility
export const getAllFolderItems = async (
  parentIds: string[],
  trx: TxnOrClient,
) => {
  const res = []
  let queue = [...parentIds]
  while (queue.length > 0) {
    const curr = queue.shift()!

    const resp = await getParentItems(curr, trx)
    if (resp.length == 0) {
      res.push(curr)
      continue
    }
    for (const item of resp) {
      if (item.type == "folder") {
        queue.push(item.id)
      } else if (item.type == "file") {
        res.push(item.id)
      }
    }
  }
  return res
}

// Get all folder IDs recursively (not files) - for parentId queries
export const getAllFolderIds = async (
  parentIds: string[],
  trx: TxnOrClient,
) => {
  const res = []
  let queue = [...parentIds]
  while (queue.length > 0) {
    const curr = queue.shift()!

    const resp = await getParentItems(curr, trx)
    for (const item of resp) {
      if (item.type == "folder") {
        res.push(item.id)
        queue.push(item.id)
      }
    }
  }
  return res
}

export const getCollectionFilesVespaIds = async (
  collectionFileIds: string[],
  trx: TxnOrClient,
) => {
  const resp = await trx
    .select({
      id: collectionItems.id,
      vespaDocId: collectionItems.vespaDocId,
      originalName: collectionItems.originalName,
      mimeType: collectionItems.mimeType,
      fileSize: collectionItems.fileSize,
    })
    .from(collectionItems)
    .where(
      and(
        inArray(collectionItems.id, collectionFileIds),
        eq(collectionItems.type, "file"),
        isNull(collectionItems.deletedAt),
      ),
    )

  return resp
}

// Get collection items status for polling - with access control
// getCollectionItemsStatusByCollections removed — dead code that gated on the
// legacy collections.owner_id.

export const getCollectionFoldersItemIds = async (
  collectionFoldersIds: string[],
  trx: TxnOrClient,
) => {
  const resp = await trx
    .select({
      id: collectionItems.id,
      vespaDocId: collectionItems.vespaDocId,
      originalName: collectionItems.originalName,
      mimeType: collectionItems.mimeType,
      fileSize: collectionItems.fileSize,
    })
    .from(collectionItems)
    .where(
      and(
        inArray(collectionItems.id, collectionFoldersIds),
        eq(collectionItems.type, "folder"),
        isNull(collectionItems.deletedAt),
      ),
    )

  return resp
}

// Legacy compatibility functions
export const getCollectionFileByItemId = async (
  trx: TxnOrClient,
  itemId: string,
): Promise<File | null> => {
  const [result] = await trx
    .select()
    .from(collectionItems)
    .where(
      and(
        eq(collectionItems.id, itemId),
        eq(collectionItems.type, "file"),
        isNull(collectionItems.deletedAt),
      ),
    )
  return (result as File) || null
}

export const createCollectionFile = async (
  trx: TxnOrClient,
  file: NewCollectionItem,
): Promise<File> => {
  const fileData: NewCollectionItem = {
    ...file,
    type: "file",
  }
  const result = await createCollectionItem(trx, fileData)
  return result as File
}

export const updateCollectionFile = async (
  trx: TxnOrClient,
  itemId: string,
  updates: Partial<NewCollectionItem>,
): Promise<File> => {
  const result = await updateCollectionItem(trx, itemId, updates)
  return result as File
}

export const softDeleteCollectionFile = async (
  trx: TxnOrClient,
  itemId: string,
): Promise<File> => {
  const result = await softDeleteCollectionItem(trx, itemId)
  return result as File
}

export const generateStorageKey = (): string => {
  return createId()
}

// Vespa docId prefixes: cl- collection, clfd- folder, clf- file.
export const generateFileVespaDocId = (): string => {
  return `clf-${createId()}`
}

export const generateFolderVespaDocId = (): string => {
  return `clfd-${createId()}`
}

export const generateCollectionVespaDocId = (): string => {
  return `cl-${createId()}`
}

// Mark a parent (folder/collection) PROCESSING, recursing up to the collection.
export const markParentAsProcessing = async (
  trx: TxnOrClient,
  parentId: string | null,
  isCollection: boolean,
) => {
  if (!parentId) return

  const updateData = {
    uploadStatus: UploadStatus.PROCESSING,
    updatedAt: sql`NOW()`,
  }

  if (isCollection) {
    await trx
      .update(collections)
      .set(updateData)
      .where(eq(collections.id, parentId))
  } else {
    await trx
      .update(collectionItems)
      .set(updateData)
      .where(eq(collectionItems.id, parentId))

    const [folder] = await trx
      .select({
        parentId: collectionItems.parentId,
        collectionId: collectionItems.collectionId,
      })
      .from(collectionItems)
      .where(eq(collectionItems.id, parentId))

    if (folder) {
      await markParentAsProcessing(
        trx,
        folder.parentId || folder.collectionId,
        !folder.parentId, // no parentId => parent is the collection
      )
    }
  }
}

const propagateFolderCompletionToParent = async (
  trx: TxnOrClient,
  folderId: string,
) => {
  const [folder] = await trx
    .select({
      parentId: collectionItems.parentId,
      collectionId: collectionItems.collectionId,
    })
    .from(collectionItems)
    .where(eq(collectionItems.id, folderId))

  if (!folder) {
    return
  }

  await updateParentStatus(
    trx,
    folder.parentId || folder.collectionId,
    !folder.parentId, // no parentId => parent is the collection
  )
}

// Roll a parent up to COMPLETED once all its children settle (completed/failed).
export const updateParentStatus = async (
  trx: TxnOrClient,
  parentId: string | null,
  isCollection: boolean,
) => {
  if (!parentId) return

  const children = await trx
    .select({ uploadStatus: collectionItems.uploadStatus })
    .from(collectionItems)
    .where(
      and(
        isCollection
          ? eq(collectionItems.collectionId, parentId)
          : eq(collectionItems.parentId, parentId),
        isCollection ? isNull(collectionItems.parentId) : sql`true`,
        isNull(collectionItems.deletedAt),
      ),
    )

  const parentType = isCollection ? "collection" : "folder"

  if (children.length === 0) {
    const updateData = {
      uploadStatus: UploadStatus.COMPLETED,
      statusMessage: `Successfully processed ${parentType}`,
      updatedAt: sql`NOW()`,
    }

    if (isCollection) {
      await trx
        .update(collections)
        .set(updateData)
        .where(eq(collections.id, parentId))
    } else {
      await trx
        .update(collectionItems)
        .set(updateData)
        .where(eq(collectionItems.id, parentId))

      await propagateFolderCompletionToParent(trx, parentId)
    }
    return
  }

  const completedCount = children.filter(
    (c) => c.uploadStatus === UploadStatus.COMPLETED,
  ).length
  const failedCount = children.filter(
    (c) => c.uploadStatus === UploadStatus.FAILED,
  ).length

  if (completedCount + failedCount === children.length) {
    const updateData = {
      uploadStatus: UploadStatus.COMPLETED,
      statusMessage: `Successfully processed ${parentType}: ${completedCount} completed, ${failedCount} failed`,
      updatedAt: sql`NOW()`,
    }

    if (isCollection) {
      await trx
        .update(collections)
        .set(updateData)
        .where(eq(collections.id, parentId))
    } else {
      await trx
        .update(collectionItems)
        .set(updateData)
        .where(eq(collectionItems.id, parentId))

      await propagateFolderCompletionToParent(trx, parentId)
    }
  }
}

/** Resolve a KB path (`Collection/folder/file`) to its item, searching ONLY
 *  within `collectionIds` (an agent's accessible set). Does NOT gate on viewer
 *  ownership — authorization is the caller's (the agent-grant ancestor check) —
 *  and the scoping also disambiguates same-named collections. Returns null when
 *  the collection/item isn't found. */
export const getRecordItemByPathInCollections = async (
  path: string,
  trx: TxnOrClient,
  collectionIds: string[],
): Promise<{
  id: string
  type: string
  vespaDocId: string | null
  collectionId: string
  parentId: string | null
} | null> => {
  if (collectionIds.length === 0) {
    return null
  }
  let collectionName: string
  let directoryPath: string
  let currItem: string

  // Trim surrounding slashes so a trailing "/" doesn't leave an empty last
  // segment that would resolve to an arbitrary child.
  const cleanPath = path.replace(/^\/+|\/+$/g, "")
  if (cleanPath.length === 0) {
    return null
  }
  const segments = cleanPath.split("/")

  if (segments.length < 2) {
    // Bare collection name is ambiguous (use no `path` for whole-collection
    // scope); treat as not-found rather than picking an arbitrary child.
    return null
  }
  // length >= 2: first segment is the collection, last is the item.
  const firstSegment = segments[0]
  const lastSegment = segments[segments.length - 1]
  if (firstSegment === undefined || lastSegment === undefined) {
    return null
  }
  if (segments.length === 2) {
    collectionName = firstSegment
    directoryPath = "/"
    currItem = lastSegment
  } else {
    collectionName = firstSegment
    const middleSegments = segments.slice(1, -1)
    directoryPath = "/" + middleSegments.join("/") + "/"
    currItem = lastSegment
  }

  // By name within the agent's accessible collections — no viewer-ownership
  // filter (the agent grant is the access boundary).
  const [collection] = await trx
    .select({ id: collections.id })
    .from(collections)
    .where(
      and(
        eq(collections.name, collectionName),
        inArray(collections.id, collectionIds),
        isNull(collections.deletedAt),
      ),
    )

  if (!collection) {
    return null
  }

  const whereConditions = [
    eq(collectionItems.collectionId, collection.id),
    eq(collectionItems.path, directoryPath),
    isNull(collectionItems.deletedAt),
  ]

  if (currItem !== "") {
    whereConditions.push(eq(collectionItems.name, currItem))
  }

  const [item] = await trx
    .select({
      id: collectionItems.id,
      type: collectionItems.type,
      vespaDocId: collectionItems.vespaDocId,
      collectionId: collectionItems.collectionId,
      parentId: collectionItems.parentId,
    })
    .from(collectionItems)
    .where(and(...whereConditions))

  return item ?? null
}

/** Distinct collection ids owning the given item ids — derives an agent's
 *  reachable collections when it's scoped to folders/files, not collections. */
export const getCollectionIdsForItems = async (
  itemIds: string[],
  trx: TxnOrClient,
): Promise<string[]> => {
  if (itemIds.length === 0) {
    return []
  }
  const rows = await trx
    .selectDistinct({ collectionId: collectionItems.collectionId })
    .from(collectionItems)
    .where(inArray(collectionItems.id, itemIds))
  return rows.map((r) => r.collectionId)
}

export const getRecordBypath = async (
  path: string,
  trx: TxnOrClient,
  ownerEmail: string,
): Promise<{
  id: string
  type: "folder" | "file"
  vespaDocId: string | null
  collectionId: string
  parentId: string | null
} | null> => {
  let collectionName: string
  let directoryPath: string
  let currItem: string
  const user = await getUserByEmail(trx, ownerEmail)
  if (!user[0]) {
    throw new Error("Invalid User")
  }
  const cleanPath = path.replace(/^\/+|\/+$/g, "")
  if (cleanPath.length === 0) {
    return null
  }
  const segments = cleanPath.split("/")
  if (segments.length < 2) {
    return null
  }

  const firstSegment = segments[0]
  const lastSegment = segments[segments.length - 1]
  if (firstSegment === undefined || lastSegment === undefined) {
    throw new Error("Invalid path")
  }

  if (segments.length === 2) {
    collectionName = firstSegment
    directoryPath = "/"
    currItem = lastSegment
  } else {
    collectionName = firstSegment
    const middleSegments = segments.slice(1, -1)
    directoryPath = "/" + middleSegments.join("/") + "/"
    currItem = lastSegment
  }

  const candidates = await trx
    .select({ id: collections.id })
    .from(collections)
    .where(
      and(eq(collections.name, collectionName), isNull(collections.deletedAt)),
    )

  // Access via the unified resolver (replaces the legacy owner_id / permissions
  // predicate) so acl-only shares resolve. Pick the first same-named collection
  // the caller can actually read.
  let collection: { id: string } | undefined
  for (const cand of candidates) {
    const role = await resolveAccess(
      trx,
      { userId: user[0].id, workspaceId: user[0].workspaceId },
      { type: AclResourceType.Collection, id: cand.id },
    )
    if (role !== null) {
      collection = cand
      break
    }
  }
  if (!collection) {
    return null
  }

  const whereConditions = [
    eq(collectionItems.collectionId, collection.id),
    eq(collectionItems.path, directoryPath),
    isNull(collectionItems.deletedAt),
  ]

  if (currItem !== "") {
    whereConditions.push(eq(collectionItems.name, currItem))
  }

  const [item] = await trx
    .select({
      id: collectionItems.id,
      type: collectionItems.type,
      vespaDocId: collectionItems.vespaDocId,
      collectionId: collectionItems.collectionId,
      parentId: collectionItems.parentId,
    })
    .from(collectionItems)
    .where(and(...whereConditions))

  return item ?? null
}
