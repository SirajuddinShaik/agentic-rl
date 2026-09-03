import config, { NAMESPACE } from "@/config"
import { db } from "@/platform/db/client"
import {
  KB_METADATA_SYNC_STATUS,
  collectionItems,
  collections,
  type Collection,
  type CollectionItem,
} from "@/platform/db/schema"
import { getLogger } from "@/platform/logger"
import { Subsystem } from "@/types"
import { Apps, KbItemsSchema, KnowledgeBaseEntity } from "@xyne/vespa-ts/types"
import { and, eq, inArray, isNull, sql } from "drizzle-orm"

const Logger = getLogger(Subsystem.Queue).child({ module: "kbMetadataSync" })

const KB_METADATA_SYNC_LEASE_MS = 5 * 60 * 1000
const KB_METADATA_SYNC_RETRY_BASE_MS = 30 * 1000
const KB_METADATA_SYNC_RETRY_MAX_MS = 10 * 60 * 1000
const REQUIRED_METADATA_SYNC_COLUMNS = [
  "vespa_metadata_sync_status",
  "vespa_metadata_sync_attempts",
  "vespa_metadata_sync_next_attempt_at",
]

type KbMetadataSyncTarget =
  | { kind: "collection"; id: string }
  | { kind: "folder"; id: string }

type KbMetadataSyncBatchResult = {
  collections: {
    claimed: number
    synced: number
    failed: number
  }
  folders: {
    claimed: number
    synced: number
    failed: number
  }
}

const allRows = <T>(result: { rows?: T[] } | T[]): T[] =>
  Array.isArray(result) ? result : result.rows || []

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const toEpochMs = (value: Date | string | number | null | undefined): number =>
  value ? new Date(value).getTime() : Date.now()

const retryBackoffMs = (attempt: number): number =>
  Math.min(
    KB_METADATA_SYNC_RETRY_MAX_MS,
    KB_METADATA_SYNC_RETRY_BASE_MS * 2 ** Math.max(attempt - 1, 0),
  )

let kbMetadataSyncColumnsAvailable: Promise<boolean> | null = null
let loggedMissingKbMetadataSyncColumns = false

const hasKbMetadataSyncColumns = async (): Promise<boolean> => {
  kbMetadataSyncColumnsAvailable ??= (async () => {
    const rows = allRows<{ table_name: string; column_name: string }>(
      await db.execute(sql`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('collections', 'collection_items')
          AND column_name IN (
            'vespa_metadata_sync_status',
            'vespa_metadata_sync_attempts',
            'vespa_metadata_sync_next_attempt_at'
          )
      `),
    )
    const columnsByTable = new Map<string, Set<string>>()
    for (const row of rows) {
      const columns = columnsByTable.get(row.table_name) || new Set<string>()
      columns.add(row.column_name)
      columnsByTable.set(row.table_name, columns)
    }

    return ["collections", "collection_items"].every((table) => {
      const columns = columnsByTable.get(table)
      return REQUIRED_METADATA_SYNC_COLUMNS.every((column) =>
        columns?.has(column),
      )
    })
  })()

  const available = await kbMetadataSyncColumnsAvailable
  if (!available && !loggedMissingKbMetadataSyncColumns) {
    loggedMissingKbMetadataSyncColumns = true
    Logger.warn(
      { requiredColumns: REQUIRED_METADATA_SYNC_COLUMNS },
      "Skipping KB metadata Vespa repair because metadata sync columns are absent",
    )
  }
  return available
}

export const buildCollectionVespaDocument = (collection: Collection) => {
  const metadata = asRecord(collection.metadata)

  return {
    docId: collection.vespaDocId,
    clId: collection.id,
    itemId: collection.id,
    fileName: collection.name,
    app: Apps.KnowledgeBase as const,
    entity: KnowledgeBaseEntity.Collection,
    description: collection.description || "",
    storagePath: "",
    chunks: [],
    image_chunks: [],
    chunks_pos: [],
    image_chunks_pos: [],
    chunks_map: [],
    image_chunks_map: [],
    metadata: JSON.stringify({
      version: "1.0",
      lastModified: toEpochMs(collection.updatedAt),
      ...metadata,
    }),
    createdBy: collection.lastUpdatedByEmail || "system",
    duration: 0,
    mimeType: "knowledge_base",
    fileSize: 0,
    createdAt: toEpochMs(collection.createdAt),
    updatedAt: toEpochMs(collection.updatedAt),
    clFd: null,
  }
}

export const buildFolderVespaDocument = (folder: CollectionItem) => {
  if (folder.type !== "folder") {
    throw new Error(`Collection item ${folder.id} is not a folder`)
  }
  if (!folder.vespaDocId) {
    throw new Error(`Folder ${folder.id} is missing vespaDocId`)
  }

  const metadata = asRecord(folder.metadata)
  const tags = Array.isArray(metadata.tags) ? metadata.tags : []

  return {
    docId: folder.vespaDocId,
    clId: folder.collectionId,
    itemId: folder.id,
    app: Apps.KnowledgeBase as const,
    fileName: folder.name,
    entity: KnowledgeBaseEntity.Folder,
    description: typeof metadata.description === "string" ? metadata.description : "",
    storagePath: "",
    chunks: [],
    image_chunks: [],
    chunks_pos: [],
    image_chunks_pos: [],
    chunks_map: [],
    image_chunks_map: [],
    metadata: JSON.stringify({
      version: "1.0",
      lastModified: toEpochMs(folder.updatedAt),
      ...metadata,
      tags,
    }),
    createdBy: folder.lastUpdatedByEmail || folder.uploadedByEmail || "system",
    duration: 0,
    mimeType: "folder",
    fileSize: 0,
    createdAt: toEpochMs(folder.createdAt),
    updatedAt: toEpochMs(folder.updatedAt),
    clFd: folder.parentId || null,
  }
}

const upsertKbItemInVespa = async (vespaDoc: Record<string, unknown>) => {
  const docId = String(vespaDoc.docId || "")
  if (!docId) {
    throw new Error("Missing Vespa docId for KB metadata sync")
  }

  const url = `${config.vespaEndpoint.feedEndpoint}/document/v1/${NAMESPACE}/${KbItemsSchema}/docid/${encodeURIComponent(docId)}?timeout=${encodeURIComponent(config.vespaDocumentUpdateTimeout)}`
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(config.kbMetadataVespaWriteTimeoutMs),
    body: JSON.stringify({ fields: vespaDoc }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText)
    throw new Error(
      `Vespa KB metadata write failed: ${response.status} ${response.statusText} ${body.slice(0, 500)}`,
    )
  }
}

const claimCollectionMetadataRows = async (
  limit: number,
): Promise<Collection[]> => {
  if (limit <= 0) return []

  return await db.transaction(async (tx) => {
    const idRows = allRows<{ id: string }>(
      await tx.execute(sql`
        SELECT id
        FROM collections
        WHERE deleted_at IS NULL
          AND (
            vespa_metadata_sync_status = ${KB_METADATA_SYNC_STATUS.PENDING}
            OR (
              vespa_metadata_sync_status = ${KB_METADATA_SYNC_STATUS.FAILED}
              AND (
                vespa_metadata_sync_next_attempt_at IS NULL
                OR vespa_metadata_sync_next_attempt_at <= NOW()
              )
            )
            OR (
              vespa_metadata_sync_status = ${KB_METADATA_SYNC_STATUS.PROCESSING}
              AND (
                vespa_metadata_sync_next_attempt_at IS NULL
                OR vespa_metadata_sync_next_attempt_at <= NOW()
              )
            )
          )
        ORDER BY COALESCE(vespa_metadata_sync_next_attempt_at, created_at), created_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      `),
    )

    const ids = idRows.map((row) => row.id).filter(Boolean)
    if (!ids.length) return []

    const leaseUntil = new Date(Date.now() + KB_METADATA_SYNC_LEASE_MS)
    return await tx
      .update(collections)
      .set({
        vespaMetadataSyncStatus: KB_METADATA_SYNC_STATUS.PROCESSING,
        vespaMetadataSyncNextAttemptAt: leaseUntil,
      })
      .where(inArray(collections.id, ids))
      .returning()
  })
}

const claimFolderMetadataRows = async (
  limit: number,
): Promise<CollectionItem[]> => {
  if (limit <= 0) return []

  return await db.transaction(async (tx) => {
    const idRows = allRows<{ id: string }>(
      await tx.execute(sql`
        SELECT id
        FROM collection_items
        WHERE type = 'folder'
          AND deleted_at IS NULL
          AND (
            vespa_metadata_sync_status = ${KB_METADATA_SYNC_STATUS.PENDING}
            OR (
              vespa_metadata_sync_status = ${KB_METADATA_SYNC_STATUS.FAILED}
              AND (
                vespa_metadata_sync_next_attempt_at IS NULL
                OR vespa_metadata_sync_next_attempt_at <= NOW()
              )
            )
            OR (
              vespa_metadata_sync_status = ${KB_METADATA_SYNC_STATUS.PROCESSING}
              AND (
                vespa_metadata_sync_next_attempt_at IS NULL
                OR vespa_metadata_sync_next_attempt_at <= NOW()
              )
            )
          )
        ORDER BY COALESCE(vespa_metadata_sync_next_attempt_at, created_at), created_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      `),
    )

    const ids = idRows.map((row) => row.id).filter(Boolean)
    if (!ids.length) return []

    const leaseUntil = new Date(Date.now() + KB_METADATA_SYNC_LEASE_MS)
    return await tx
      .update(collectionItems)
      .set({
        vespaMetadataSyncStatus: KB_METADATA_SYNC_STATUS.PROCESSING,
        vespaMetadataSyncNextAttemptAt: leaseUntil,
      })
      .where(inArray(collectionItems.id, ids))
      .returning()
  })
}

const claimCollectionMetadataById = async (
  collectionId: string,
): Promise<Collection | null> => {
  const leaseUntil = new Date(Date.now() + KB_METADATA_SYNC_LEASE_MS)
  const [collection] = await db
    .update(collections)
    .set({
      vespaMetadataSyncStatus: KB_METADATA_SYNC_STATUS.PROCESSING,
      vespaMetadataSyncNextAttemptAt: leaseUntil,
    })
    .where(
      and(
        eq(collections.id, collectionId),
        isNull(collections.deletedAt),
        sql`(
          ${collections.vespaMetadataSyncStatus} = ${KB_METADATA_SYNC_STATUS.PENDING}
          OR (
            ${collections.vespaMetadataSyncStatus} = ${KB_METADATA_SYNC_STATUS.FAILED}
            AND (
              ${collections.vespaMetadataSyncNextAttemptAt} IS NULL
              OR ${collections.vespaMetadataSyncNextAttemptAt} <= NOW()
            )
          )
          OR (
            ${collections.vespaMetadataSyncStatus} = ${KB_METADATA_SYNC_STATUS.PROCESSING}
            AND (
              ${collections.vespaMetadataSyncNextAttemptAt} IS NULL
              OR ${collections.vespaMetadataSyncNextAttemptAt} <= NOW()
            )
          )
        )`,
      ),
    )
    .returning()

  return collection || null
}

const claimFolderMetadataById = async (
  folderId: string,
): Promise<CollectionItem | null> => {
  const leaseUntil = new Date(Date.now() + KB_METADATA_SYNC_LEASE_MS)
  const [folder] = await db
    .update(collectionItems)
    .set({
      vespaMetadataSyncStatus: KB_METADATA_SYNC_STATUS.PROCESSING,
      vespaMetadataSyncNextAttemptAt: leaseUntil,
    })
    .where(
      and(
        eq(collectionItems.id, folderId),
        eq(collectionItems.type, "folder"),
        isNull(collectionItems.deletedAt),
        sql`(
          ${collectionItems.vespaMetadataSyncStatus} = ${KB_METADATA_SYNC_STATUS.PENDING}
          OR (
            ${collectionItems.vespaMetadataSyncStatus} = ${KB_METADATA_SYNC_STATUS.FAILED}
            AND (
              ${collectionItems.vespaMetadataSyncNextAttemptAt} IS NULL
              OR ${collectionItems.vespaMetadataSyncNextAttemptAt} <= NOW()
            )
          )
          OR (
            ${collectionItems.vespaMetadataSyncStatus} = ${KB_METADATA_SYNC_STATUS.PROCESSING}
            AND (
              ${collectionItems.vespaMetadataSyncNextAttemptAt} IS NULL
              OR ${collectionItems.vespaMetadataSyncNextAttemptAt} <= NOW()
            )
          )
        )`,
      ),
    )
    .returning()

  return folder || null
}

const markCollectionMetadataSyncSuccess = async (collection: Collection) => {
  await db
    .update(collections)
    .set({
      vespaMetadataSyncStatus: KB_METADATA_SYNC_STATUS.SYNCED,
      vespaMetadataSyncAttempts: 0,
      vespaMetadataSyncNextAttemptAt: null,
    })
    .where(
      and(
        eq(collections.id, collection.id),
        eq(
          collections.vespaMetadataSyncStatus,
          KB_METADATA_SYNC_STATUS.PROCESSING,
        ),
        sql`${collections.vespaMetadataSyncNextAttemptAt} = ${collection.vespaMetadataSyncNextAttemptAt}`,
      ),
    )
}

const markFolderMetadataSyncSuccess = async (folder: CollectionItem) => {
  await db
    .update(collectionItems)
    .set({
      vespaMetadataSyncStatus: KB_METADATA_SYNC_STATUS.SYNCED,
      vespaMetadataSyncAttempts: 0,
      vespaMetadataSyncNextAttemptAt: null,
    })
    .where(
      and(
        eq(collectionItems.id, folder.id),
        eq(
          collectionItems.vespaMetadataSyncStatus,
          KB_METADATA_SYNC_STATUS.PROCESSING,
        ),
        sql`${collectionItems.vespaMetadataSyncNextAttemptAt} = ${folder.vespaMetadataSyncNextAttemptAt}`,
      ),
    )
}

const markCollectionMetadataSyncFailure = async (
  collection: Collection,
) => {
  const attempts = (collection.vespaMetadataSyncAttempts || 0) + 1
  await db
    .update(collections)
    .set({
      vespaMetadataSyncStatus: KB_METADATA_SYNC_STATUS.FAILED,
      vespaMetadataSyncAttempts: attempts,
      vespaMetadataSyncNextAttemptAt: new Date(Date.now() + retryBackoffMs(attempts)),
    })
    .where(
      and(
        eq(collections.id, collection.id),
        eq(
          collections.vespaMetadataSyncStatus,
          KB_METADATA_SYNC_STATUS.PROCESSING,
        ),
        sql`${collections.vespaMetadataSyncNextAttemptAt} = ${collection.vespaMetadataSyncNextAttemptAt}`,
      ),
    )
}

const markFolderMetadataSyncFailure = async (
  folder: CollectionItem,
) => {
  const attempts = (folder.vespaMetadataSyncAttempts || 0) + 1
  await db
    .update(collectionItems)
    .set({
      vespaMetadataSyncStatus: KB_METADATA_SYNC_STATUS.FAILED,
      vespaMetadataSyncAttempts: attempts,
      vespaMetadataSyncNextAttemptAt: new Date(Date.now() + retryBackoffMs(attempts)),
    })
    .where(
      and(
        eq(collectionItems.id, folder.id),
        eq(
          collectionItems.vespaMetadataSyncStatus,
          KB_METADATA_SYNC_STATUS.PROCESSING,
        ),
        sql`${collectionItems.vespaMetadataSyncNextAttemptAt} = ${folder.vespaMetadataSyncNextAttemptAt}`,
      ),
    )
}

const syncClaimedCollection = async (
  collection: Collection,
): Promise<boolean> => {
  const startedAt = new Date()
  const leaseUntil = collection.vespaMetadataSyncNextAttemptAt
  Logger.info(
    {
      collectionId: collection.id,
      startedAt,
      leaseUntil,
    },
    "KB collection metadata Vespa sync started",
  )

  try {
    await upsertKbItemInVespa(buildCollectionVespaDocument(collection))
    await markCollectionMetadataSyncSuccess(collection)
    Logger.info(
      { collectionId: collection.id, startedAt, leaseUntil },
      "KB collection metadata Vespa sync completed",
    )
    return true
  } catch (error) {
    await markCollectionMetadataSyncFailure(collection)
    Logger.warn(
      { err: error, collectionId: collection.id, startedAt, leaseUntil },
      "KB collection metadata Vespa sync failed",
    )
    return false
  }
}

const syncClaimedFolder = async (folder: CollectionItem): Promise<boolean> => {
  const startedAt = new Date()
  const leaseUntil = folder.vespaMetadataSyncNextAttemptAt
  Logger.info(
    {
      folderId: folder.id,
      startedAt,
      leaseUntil,
    },
    "KB folder metadata Vespa sync started",
  )

  try {
    await upsertKbItemInVespa(buildFolderVespaDocument(folder))
    await markFolderMetadataSyncSuccess(folder)
    Logger.info(
      { folderId: folder.id, startedAt, leaseUntil },
      "KB folder metadata Vespa sync completed",
    )
    return true
  } catch (error) {
    await markFolderMetadataSyncFailure(folder)
    Logger.warn(
      { err: error, folderId: folder.id, startedAt, leaseUntil },
      "KB folder metadata Vespa sync failed",
    )
    return false
  }
}

export const syncCollectionMetadataById = async (
  collectionId: string,
): Promise<boolean> => {
  const collection = await claimCollectionMetadataById(collectionId)
  if (!collection) return false
  return await syncClaimedCollection(collection)
}

export const syncFolderMetadataById = async (
  folderId: string,
): Promise<boolean> => {
  const folder = await claimFolderMetadataById(folderId)
  if (!folder) return false
  return await syncClaimedFolder(folder)
}

export const kickoffKbMetadataSync = (target: KbMetadataSyncTarget): void => {
  setTimeout(() => {
    const work =
      target.kind === "collection"
        ? syncCollectionMetadataById(target.id)
        : syncFolderMetadataById(target.id)

    void work.catch((error) => {
      Logger.warn(
        { err: error, target },
        "Best-effort KB metadata Vespa sync crashed",
      )
    })
  }, 0)
}

export const repairKbMetadataSyncBatch = async (
  options: { collectionLimit?: number; folderLimit?: number } = {},
): Promise<KbMetadataSyncBatchResult> => {
  const collectionLimit = options.collectionLimit ?? 50
  const folderLimit = options.folderLimit ?? 100
  const result: KbMetadataSyncBatchResult = {
    collections: { claimed: 0, synced: 0, failed: 0 },
    folders: { claimed: 0, synced: 0, failed: 0 },
  }

  if (!(await hasKbMetadataSyncColumns())) {
    return result
  }

  const claimedCollections = await claimCollectionMetadataRows(collectionLimit)
  result.collections.claimed = claimedCollections.length
  for (const collection of claimedCollections) {
    if (await syncClaimedCollection(collection)) {
      result.collections.synced += 1
    } else {
      result.collections.failed += 1
    }
  }

  const claimedFolders = await claimFolderMetadataRows(folderLimit)
  result.folders.claimed = claimedFolders.length
  for (const folder of claimedFolders) {
    if (await syncClaimedFolder(folder)) {
      result.folders.synced += 1
    } else {
      result.folders.failed += 1
    }
  }

  if (result.collections.claimed > 0 || result.folders.claimed > 0) {
    Logger.info(
      result,
      "Repaired due KB metadata Vespa sync rows from DB state",
    )
  }

  return result
}
