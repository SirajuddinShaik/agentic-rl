import { describe, expect, test } from "bun:test"
import type { Collection, CollectionItem, NewCollectionItem } from "@/platform/db/schema"

process.env.ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

const DRIZZLE_TABLE_NAME = Symbol.for("drizzle:Name")

function getTableName(table: unknown): string | undefined {
  if (!table || typeof table !== "object") {
    return undefined
  }

  return (table as Record<symbol, string | undefined>)[DRIZZLE_TABLE_NAME]
}

async function loadUpdateCollectionItem() {
  const module = await import(
    `../platform/db/knowledgeBase.ts?knowledgeBaseDbTest=${Date.now()}-${Math.random()}`
  )
  return module.updateCollectionItem
}

async function loadCreateCollection() {
  const module = await import(
    `../platform/db/knowledgeBase.ts?knowledgeBaseDbTest=${Date.now()}-${Math.random()}`
  )
  return module.createCollection
}

async function loadCreateFolder() {
  const module = await import(
    `../platform/db/knowledgeBase.ts?knowledgeBaseDbTest=${Date.now()}-${Math.random()}`
  )
  return module.createFolder
}

async function loadUpdateParentStatus() {
  const module = await import(
    `../platform/db/knowledgeBase.ts?knowledgeBaseDbTest=${Date.now()}-${Math.random()}`
  )
  return module.updateParentStatus
}

// Return type left to inference: the cache-busting `import(...?t=)` helpers above
// spawn a second, unrelated `Collection` type, so a nominal `: Collection` return
// annotation here trips TS2719 even though the shape is identical.
const createCollectionRow = (
  overrides: Partial<Collection> = {},
) => ({
  id: "collection-alpha",
  workspaceId: 1,
  ownerId: 1,
  name: "KB",
  description: null,
  vespaDocId: "cl-collection-alpha",
  isPrivate: true,
  totalItems: 0,
  lastUpdatedByEmail: "owner@example.com",
  lastUpdatedById: 1,
  uploadStatus: "completed" as any,
  vespaMetadataSyncStatus: "pending" as any,
  vespaMetadataSyncAttempts: 0,
  vespaMetadataSyncError: null,
  vespaMetadataSyncedAt: null,
  vespaMetadataSyncNextAttemptAt: null,
  vespaMetadataSyncStartedAt: null,
  statusMessage: null,
  retryCount: 0,
  metadata: {},
  permissions: [],
  collectionSourceUpdatedAt: new Date("2025-01-01T00:00:00.000Z"),
  createdAt: new Date("2025-01-01T00:00:00.000Z"),
  updatedAt: new Date("2025-01-02T00:00:00.000Z"),
  deletedAt: null,
  via_apiKey: false,
  ...overrides,
})

const createItem = (overrides: Partial<CollectionItem> = {}): CollectionItem => ({
  id: "item-1",
  collectionId: "collection-alpha",
  parentId: null,
  workspaceId: 1,
  name: "README.md",
  type: "file",
  path: "/",
  position: 0,
  vespaDocId: "clf-item-1",
  totalFileCount: 0,
  originalName: "README.md",
  storagePath: "/tmp/readme.md",
  storageKey: "storage-key",
  mimeType: "text/markdown",
  fileSize: 128,
  checksum: null,
  uploadedByEmail: "owner@example.com",
  uploadedById: 1,
  lastUpdatedByEmail: "owner@example.com",
  lastUpdatedById: 1,
  processingInfo: {},
  processedAt: null,
  uploadStatus: "completed" as any,
  vespaMetadataSyncStatus: "pending" as any,
  vespaMetadataSyncAttempts: 0,
  vespaMetadataSyncError: null,
  vespaMetadataSyncedAt: null,
  vespaMetadataSyncNextAttemptAt: null,
  vespaMetadataSyncStartedAt: null,
  statusMessage: null,
  retryCount: 0,
  metadata: {},
  createdAt: new Date("2025-01-01T00:00:00.000Z"),
  updatedAt: new Date("2025-01-02T00:00:00.000Z"),
  deletedAt: null,
  ...overrides,
})

function createMockTrx(
  existingItem: CollectionItem,
  updateOverrides: Partial<CollectionItem> = {},
) {
  const updateCalls: Array<{
    tableName?: string
    values?: Record<string, unknown>
  }> = []

  const trx = {
    select() {
      return {
        from() {
          return {
            where: async () => [existingItem],
          }
        },
      }
    },
    update(table: unknown) {
      const tableName = getTableName(table)
      const call: { tableName?: string; values?: Record<string, unknown> } = {
        ...(tableName !== undefined && { tableName }),
      }
      updateCalls.push(call)

      return {
        set(values: Record<string, unknown>) {
          call.values = values
          return {
            where() {
              if (call.tableName === "collection_items") {
                return {
                  returning: async () => [
                    {
                      ...existingItem,
                      ...updateOverrides,
                      ...values,
                    },
                  ],
                }
              }

              return Promise.resolve([])
            },
          }
        },
      }
    },
  }

  return { trx: trx as any, updateCalls }
}

function createInsertMockTrx() {
  const insertCalls: Array<{
    tableName?: string
    values?: Record<string, unknown>
  }> = []

  const trx = {
    insert(table: unknown) {
      const tableName = getTableName(table)
      const call: { tableName?: string; values?: Record<string, unknown> } = {
        ...(tableName !== undefined && { tableName }),
      }
      insertCalls.push(call)

      return {
        values(values: Record<string, unknown>) {
          call.values = values
          return {
            returning: async () => [
              {
                id: "collection-alpha",
                createdAt: new Date("2025-01-01T00:00:00.000Z"),
                updatedAt: new Date("2025-01-01T00:00:00.000Z"),
                deletedAt: null,
                retryCount: 0,
                uploadStatus: "created",
                statusMessage: null,
                totalItems: 0,
                ...values,
              },
            ],
          }
        },
      }
    },
  }

  return { trx: trx as any, insertCalls }
}

function createUpdateParentStatusMockTrx(selectResults: unknown[]) {
  const updateCalls: Array<{
    tableName?: string
    values?: Record<string, unknown>
  }> = []

  const trx = {
    select() {
      return {
        from() {
          return {
            where: async () => {
              const next = selectResults.shift()
              return Array.isArray(next) ? next : []
            },
          }
        },
      }
    },
    update(table: unknown) {
      const tableName = getTableName(table)
      const call: { tableName?: string; values?: Record<string, unknown> } = {
        ...(tableName !== undefined && { tableName }),
      }
      updateCalls.push(call)

      return {
        set(values: Record<string, unknown>) {
          call.values = values
          return {
            where() {
              return Promise.resolve([])
            },
          }
        },
      }
    },
  }

  return { trx: trx as any, updateCalls }
}

describe("updateCollectionItem", () => {
  test("touches the collection ls watermark when structure fields change", async () => {
    const existingItem = createItem()
    const { trx, updateCalls } = createMockTrx(existingItem, {
      name: "Guide.md",
    })
    const updateCollectionItem = await loadUpdateCollectionItem()

    const result = await updateCollectionItem(trx, existingItem.id, {
      name: "Guide.md",
    } satisfies Partial<NewCollectionItem>)

    expect(result.name).toBe("Guide.md")

    const collectionTouchCalls = updateCalls.filter(
      (call) => call.tableName === "collections",
    )
    expect(collectionTouchCalls).toHaveLength(1)
    expect(collectionTouchCalls[0]?.values).toHaveProperty(
      "collectionSourceUpdatedAt",
    )
    expect(collectionTouchCalls[0]?.values).toHaveProperty("updatedAt")
  })

  test("does not touch the collection ls watermark for non-structural updates", async () => {
    const existingItem = createItem()
    const { trx, updateCalls } = createMockTrx(existingItem, {
      statusMessage: "Queued",
    })
    const updateCollectionItem = await loadUpdateCollectionItem()

    const result = await updateCollectionItem(trx, existingItem.id, {
      statusMessage: "Queued",
    } satisfies Partial<NewCollectionItem>)

    expect(result.statusMessage).toBe("Queued")
    expect(
      updateCalls.filter((call) => call.tableName === "collections"),
    ).toHaveLength(0)
  })

  test("touches collection ls watermarks when an item moves to another collection", async () => {
    const existingItem = createItem()
    const { trx, updateCalls } = createMockTrx(existingItem, {
      collectionId: "collection-beta",
    })
    const updateCollectionItem = await loadUpdateCollectionItem()

    const result = await updateCollectionItem(trx, existingItem.id, {
      collectionId: "collection-beta",
    } satisfies Partial<NewCollectionItem>)

    expect(result.collectionId).toBe("collection-beta")

    const collectionTouchCalls = updateCalls.filter(
      (call) => call.tableName === "collections",
    )
    expect(collectionTouchCalls).toHaveLength(1)
    expect(collectionTouchCalls[0]?.values).toHaveProperty(
      "collectionSourceUpdatedAt",
    )
  })

  test("marks folder metadata sync pending when a folder is renamed", async () => {
    const existingItem = createItem({
      type: "folder",
      name: "Specs",
      vespaMetadataSyncStatus: "synced" as any,
      vespaMetadataSyncedAt: new Date("2025-01-03T00:00:00.000Z"),
    })
    const { trx, updateCalls } = createMockTrx(existingItem, {
      name: "Docs",
    })
    const updateCollectionItem = await loadUpdateCollectionItem()

    const result = await updateCollectionItem(trx, existingItem.id, {
      name: "Docs",
    } satisfies Partial<NewCollectionItem>)

    expect(result.name).toBe("Docs")
    const itemUpdateCall = updateCalls.find(
      (call) => call.tableName === "collection_items",
    )
    expect(itemUpdateCall?.values).toMatchObject({
      vespaMetadataSyncStatus: "pending",
      vespaMetadataSyncAttempts: 0,
      vespaMetadataSyncError: null,
      vespaMetadataSyncedAt: null,
      vespaMetadataSyncNextAttemptAt: null,
      vespaMetadataSyncStartedAt: null,
    })
  })
})

describe("createCollection", () => {
  test("stores the generated vespa doc id in metadata when metadata is an object", async () => {
    const { trx, insertCalls } = createInsertMockTrx()
    const createCollection = await loadCreateCollection()

    const result = await createCollection(trx, {
      name: "KB8",
      description: null,
      workspaceId: 1,
      ownerId: 1,
      isPrivate: true,
      metadata: { source: "api", vespaDocId: "stale-id" },
    } as any)

    const insertCall = insertCalls.find((call) => call.tableName === "collections")
    const insertedValues = insertCall?.values

    expect(insertedValues).toBeDefined()
    expect(insertedValues?.vespaDocId).toEqual(result.vespaDocId)
    expect(insertedValues?.metadata).toMatchObject({
      source: "api",
      vespaDocId: result.vespaDocId,
    })
    expect(result.metadata).toMatchObject({
      source: "api",
      vespaDocId: result.vespaDocId,
    })
    expect(insertedValues?.uploadStatus).toBe("completed")
    expect(insertedValues?.vespaMetadataSyncStatus).toBe("pending")
  })
})

describe("createFolder", () => {
  test("creates completed folders without marking parent processing", async () => {
    const collection = createCollectionRow()
    const insertedItems: Record<string, unknown>[] = []
    const updateCalls: Array<{
      tableName?: string
      values?: Record<string, unknown>
    }> = []

    const trx = {
      select() {
        return {
          from(table: unknown) {
            const tableName = getTableName(table)
            return {
              where: () => {
                if (tableName === "collections") {
                  return [collection]
                }
                const rows: CollectionItem[] & { orderBy?: () => Promise<CollectionItem[]> } =
                  [] as any
                rows.orderBy = async () => []
                return rows
              },
            }
          },
        }
      },
      insert() {
        return {
          values(values: Record<string, unknown>) {
            insertedItems.push(values)
            return {
              returning: async () => [
                createItem({
                  ...(values as Partial<CollectionItem>),
                  id: "folder-1",
                  type: "folder",
                }),
              ],
            }
          },
        }
      },
      update(table: unknown) {
        const tableName = getTableName(table)
        const call: { tableName?: string; values?: Record<string, unknown> } = {
          ...(tableName !== undefined && { tableName }),
        }
        updateCalls.push(call)

        return {
          set(values: Record<string, unknown>) {
            call.values = values
            return {
              where: async () => [],
            }
          },
        }
      },
    }
    const createFolder = await loadCreateFolder()

    const result = await createFolder(
      trx as any,
      collection.id,
      null,
      "Docs",
      {},
      1,
      "owner@example.com",
    )

    expect(result.uploadStatus).toBe("completed")
    expect(insertedItems[0]).toMatchObject({
      uploadStatus: "completed",
      statusMessage: "Successfully processed folder",
      vespaMetadataSyncStatus: "pending",
    })
    const parentStatusUpdates = updateCalls.filter(
      (call) =>
        (call.tableName === "collections" ||
          call.tableName === "collection_items") &&
        call.values?.uploadStatus === "processing",
    )
    expect(parentStatusUpdates).toHaveLength(0)
  })
})

describe("updateParentStatus", () => {
  test("propagates empty folder completion back to the parent collection", async () => {
    const { trx, updateCalls } = createUpdateParentStatusMockTrx([
      [],
      [{ parentId: null, collectionId: "collection-alpha" }],
      [{ uploadStatus: "completed" }],
    ])
    const updateParentStatus = await loadUpdateParentStatus()

    await updateParentStatus(trx, "folder-1", false)

    const folderUpdateCalls = updateCalls.filter(
      (call) => call.tableName === "collection_items",
    )
    const collectionUpdateCalls = updateCalls.filter(
      (call) => call.tableName === "collections",
    )

    expect(folderUpdateCalls).toHaveLength(1)
    expect(folderUpdateCalls[0]?.values).toMatchObject({
      uploadStatus: "completed",
      statusMessage: "Successfully processed folder",
    })

    expect(collectionUpdateCalls).toHaveLength(1)
    expect(collectionUpdateCalls[0]?.values).toMatchObject({
      uploadStatus: "completed",
      statusMessage: "Successfully processed collection: 1 completed, 0 failed",
    })
  })
})
