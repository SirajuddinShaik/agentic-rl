/**
 * Migrates datasource files from agents' app_integrations into the knowledge
 * base as collections. Migrated files carry no storage key (the originals
 * don't exist physically) and are re-inserted into Vespa's kb_items schema.
 *
 * Usage:
 *   bun run scripts/migrate-datasources-to-kb.ts [--dry-run] [--remove-datasource]
 *
 * Flags:
 *   --dry-run             Preview without making changes
 *   --remove-datasource   Drop DataSource objects after a verified migration
 *
 * NOTE: never deletes datasources or datasource files from Vespa.
 */

import { db } from "@/platform/db/client"
import {
  createCollection,
  createFileItem,
  generateFileVespaDocId,
} from "@/platform/db/knowledgeBase"
import { agents, collectionItems, collections } from "@/platform/db/schema"
import { getLogger } from "@/platform/logger"
import {
  insert,
  GetDocument,
} from "@/platform/search/vespa"
import { UploadStatus } from "@/platform/shared/types"
import { Subsystem } from "@/types"
import { Apps, KnowledgeBaseEntity, KbItemsSchema } from "@xyne/vespa-ts/types"
import type { VespaDataSource, VespaDataSourceFile } from "@xyne/vespa-ts/types"
import { eq, isNull, sql } from "drizzle-orm"

const Logger = getLogger(Subsystem.Api).child({
  module: "datasource-to-kb-migration",
})

interface MigrationStats {
  totalAgentsProcessed: number
  totalDatasourcesProcessed: number
  totalFilesCreated: number
  totalCollectionsCreated: number
  errors: Array<{
    agentId: number
    datasourceId: string
    error: string
  }>
}

async function migrateDatasourcesToKnowledgeBase(removeDataSource = false) {
  const stats: MigrationStats = {
    totalAgentsProcessed: 0,
    totalDatasourcesProcessed: 0,
    totalFilesCreated: 0,
    totalCollectionsCreated: 0,
    errors: [],
  }

  Logger.info("Starting datasource to knowledge base migration...")

  try {
    const agentsWithDatasources = await db
      .select()
      .from(agents)
      .where(isNull(agents.deletedAt))

    Logger.info(
      `Found ${agentsWithDatasources.length} agents (including those without datasources)`,
    )

    for (const agent of agentsWithDatasources) {
      try {
        stats.totalAgentsProcessed++

        const appIntegrations = agent.appIntegrations as any

        if (
          !appIntegrations ||
          typeof appIntegrations !== "object" ||
          !appIntegrations.DataSource
        ) {
          Logger.debug(
            `Agent ${agent.id} (${agent.name}) has no datasource integrations, skipping...`,
          )
          continue
        }

        const datasourceIntegration = appIntegrations.DataSource
        const datasourceIds = datasourceIntegration.itemIds as string[]

        if (!datasourceIds || datasourceIds.length === 0) {
          Logger.debug(
            `Agent ${agent.id} (${agent.name}) has empty datasource itemIds, skipping...`,
          )
          continue
        }

        Logger.info(
          `Processing agent ${agent.id} (${agent.name}) with ${datasourceIds.length} datasources`,
        )

        const user = await db.query.users.findFirst({
          where: (users, { eq }) => eq(users.id, agent.userId),
        })

        if (!user) {
          Logger.error(`User ${agent.userId} not found for agent ${agent.id}`)
          stats.errors.push({
            agentId: agent.id,
            datasourceId: "N/A",
            error: `User ${agent.userId} not found`,
          })
          continue
        }

        const migratedCollectionIds: string[] = []

        for (const datasourceId of datasourceIds) {
          try {
            stats.totalDatasourcesProcessed++

            Logger.info(`Processing datasource: ${datasourceId}`)

            let datasource: VespaDataSource | null = null
            let datasourceName: string = `Datasource_${datasourceId}`

            try {
              const datasourceDoc = await GetDocument("datasource", datasourceId)

              if (datasourceDoc && datasourceDoc.fields) {
                datasource = datasourceDoc.fields as VespaDataSource
                datasourceName = datasource.name || datasourceName
                Logger.info(
                  `Found datasource: "${datasourceName}" (${datasourceId})`,
                )
              } else {
                Logger.warn(
                  `Datasource ${datasourceId} not found in Vespa, will use ID as name`,
                )
              }
            } catch (fetchError) {
              Logger.warn(
                `Error fetching datasource ${datasourceId}: ${fetchError}`,
              )
            }

            if (!datasource) {
              Logger.warn(
                `Could not fetch datasource ${datasourceId}, using ID as name for collection`,
              )
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
            const uniqueCollectionName = `${datasourceName}_${timestamp}`

            // Match on originalDatasourceId across ALL users (not just the
            // owner) since datasources can be shared.
            const existingCollection = await db.query.collections.findFirst({
              where: (collections, { and, isNull, sql }) =>
                and(
                  sql`${collections.metadata}->>'originalDatasourceId' = ${datasourceId}`,
                  isNull(collections.deletedAt),
                ),
            })

            let collection
            if (existingCollection) {
              Logger.info(
                `Collection for datasource "${datasourceId}" already exists with name "${existingCollection.name}", using existing collection. Skipping file migration.`,
              )
              collection = existingCollection

              // Already migrated: attach to agent, skip re-importing files.
              migratedCollectionIds.push(`cl-${collection.id}`)
              continue
            } else {
              collection = await createCollection(db, {
                workspaceId: user.workspaceId,
                ownerId: user.id,
                name: uniqueCollectionName,
                description: `Migrated from datasource: ${datasourceName} (${datasourceId})`,
                uploadStatus: UploadStatus.PROCESSING,
                metadata: {
                  migratedFrom: "datasource",
                  originalDatasourceName: datasourceName,
                  originalDatasourceId: datasourceId,
                  migratedAt: new Date().toISOString(),
                },
              })

              stats.totalCollectionsCreated++
              Logger.info(
                `Created collection: ${collection.name} (${collection.id})`,
              )
            }

            migratedCollectionIds.push(`cl-${collection.id}`) // "cl-" + Postgres UUID, the app_integrations id form

            Logger.info(
              `Fetching files for datasource ${datasourceId} from Vespa...`,
            )

            const datasourceFilesSearch = await fetchDatasourceFiles(
              datasourceId,
              user.email,
            )

            if (!datasourceFilesSearch || datasourceFilesSearch.length === 0) {
              Logger.warn(
                `No files found in datasource ${datasourceId}, skipping...`,
              )
              continue
            }

            Logger.info(
              `Found ${datasourceFilesSearch.length} files in datasource ${datasourceName}`,
            )

            for (const dsFileSearchResult of datasourceFilesSearch) {
              try {
                const docId = (dsFileSearchResult as any).fields?.docId ||
                             (dsFileSearchResult as any).docId

                if (!docId) {
                  Logger.warn('File search result missing docId, skipping...')
                  continue
                }

                Logger.debug(`Fetching full document from Vespa for file: ${docId}`)

                // GetDocument (not the search hit) to pull chunks and all fields.
                const fullFileDoc = await GetDocument(
                  "datasource_file",
                  docId,
                )

                if (!fullFileDoc || !fullFileDoc.fields) {
                  Logger.warn(
                    `Could not fetch full document for ${docId}, skipping...`,
                  )
                  continue
                }

                await migrateFileToKnowledgeBase(
                  fullFileDoc.fields as VespaDataSourceFile,
                  collection.id,
                  user.id,
                  user.email,
                  user.workspaceId,
                )
                stats.totalFilesCreated++
              } catch (fileError) {
                const fileId = (dsFileSearchResult as any).fields?.docId ||
                              (dsFileSearchResult as any).docId ||
                              'unknown'
                Logger.error(`Error migrating file ${fileId}:`, fileError)
                stats.errors.push({
                  agentId: agent.id,
                  datasourceId,
                  error: `Failed to migrate file ${fileId}: ${fileError}`,
                })
              }
            }

            await db
              .update(collections)
              .set({
                uploadStatus: UploadStatus.COMPLETED,
                statusMessage: `Migration completed: ${datasourceFilesSearch.length} files migrated`,
                updatedAt: sql`NOW()`,
              })
              .where(eq(collections.id, collection.id))

            Logger.info(
              `Successfully migrated datasource ${datasourceName} with ${datasourceFilesSearch.length} files`,
            )
          } catch (datasourceError) {
            Logger.error(
              `Error processing datasource ${datasourceId}:`,
              datasourceError,
            )
            stats.errors.push({
              agentId: agent.id,
              datasourceId,
              error: `${datasourceError}`,
            })
          }
        }

        if (migratedCollectionIds.length > 0) {
          await updateAgentWithKnowledgeBase(
            agent.id,
            migratedCollectionIds,
            removeDataSource,
          )
          Logger.info(
            `Updated agent ${agent.id} with ${migratedCollectionIds.length} knowledge base collections${removeDataSource ? " and removed DataSource integration" : ""}`,
          )
        }
      } catch (agentError) {
        Logger.error(`Error processing agent ${agent.id}:`, agentError)
        stats.errors.push({
          agentId: agent.id,
          datasourceId: "N/A",
          error: `${agentError}`,
        })
      }
    }

    Logger.info("=" + "=".repeat(60))
    Logger.info("Migration Summary:")
    Logger.info(`Total agents processed: ${stats.totalAgentsProcessed}`)
    Logger.info(
      `Total datasources processed: ${stats.totalDatasourcesProcessed}`,
    )
    Logger.info(`Total collections created: ${stats.totalCollectionsCreated}`)
    Logger.info(`Total files migrated: ${stats.totalFilesCreated}`)
    Logger.info(`Total errors: ${stats.errors.length}`)
    Logger.info("=" + "=".repeat(60))

    if (stats.errors.length > 0) {
      Logger.warn("Errors encountered during migration:")
      stats.errors.forEach((error, index) => {
        Logger.warn(
          `${index + 1}. Agent ${error.agentId}, Datasource ${error.datasourceId}: ${error.error}`,
        )
      })
    }

    return stats
  } catch (error) {
    Logger.error("Fatal error during migration:", error)
    throw error
  }
}

/** Migrate one datasource file into the knowledge base (Postgres + Vespa). */
async function migrateFileToKnowledgeBase(
  dsFile: VespaDataSourceFile,
  collectionId: string,
  userId: number,
  userEmail: string,
  _workspaceId: number,
) {
  const fileName = dsFile.fileName || `file_${dsFile.docId}`

  Logger.debug(`Migrating file: ${fileName} (${dsFile.docId})`)

  const kbVespaDocId = generateFileVespaDocId()

  // storagePath/storageKey/checksum are empty: the original file no longer
  // exists physically, only its indexed chunks.
  const fileItem = await createFileItem(
    db,
    collectionId,
    null, // parentId (root)
    fileName,
    kbVespaDocId,
    fileName, // originalName
    "", // storagePath
    "", // storageKey
    dsFile.mimeType || null,
    dsFile.fileSize || null,
    null, // checksum
    {
      migratedFrom: "datasource",
      originalDatasourceFileId: dsFile.docId,
      migratedAt: new Date().toISOString(),
    },
    userId,
    userEmail,
    `Migrated from datasource file: ${dsFile.docId}`,
  )

  const collection = await db.query.collections.findFirst({
    where: (collections, { eq }) => eq(collections.id, collectionId),
  })

  if (!collection) {
    throw new Error(`Collection ${collectionId} not found`)
  }

  const vespaDoc = {
    docId: kbVespaDocId,
    clId: collection.vespaDocId, // "cl-"-prefixed collection Vespa id
    itemId: fileItem.id,
    fileName: fileName,
    app: Apps.KnowledgeBase as const,
    entity: KnowledgeBaseEntity.File,
    description: dsFile.description || "",
    storagePath: "", // no physical file
    chunks: dsFile.chunks || [],
    chunks_pos: dsFile.chunks_pos || [],
    image_chunks: dsFile.image_chunks || [],
    image_chunks_pos: dsFile.image_chunks_pos || [],
    chunks_map: [],
    image_chunks_map: [],
    metadata: JSON.stringify({
      migratedFrom: "datasource",
      originalDatasourceFileId: dsFile.docId,
      originalFileName: dsFile.fileName,
      uploadedBy: userEmail,
      chunksCount: (dsFile.chunks || []).length + (dsFile.image_chunks || []).length,
      imageChunksCount: (dsFile.image_chunks || []).length,
      lastModified: Date.now(),
    }),
    createdBy: userEmail,
    duration: dsFile.duration || 0,
    mimeType: dsFile.mimeType || "text/plain",
    fileSize: dsFile.fileSize || 0,
    createdAt: dsFile.createdAt || Date.now(),
    updatedAt: Date.now(),
  }

  await insert(vespaDoc, KbItemsSchema)

  await db
    .update(collectionItems)
    .set({
      uploadStatus: UploadStatus.COMPLETED,
      processedAt: new Date(),
      updatedAt: sql`NOW()`,
    })
    .where(eq(collectionItems.id, fileItem.id))

  Logger.debug(`Successfully migrated file ${fileName} to knowledge base`)
}

/** Merge migrated collections into the agent's knowledge_base integration,
 *  optionally dropping its DataSource integration. */
async function updateAgentWithKnowledgeBase(
  agentId: number,
  collectionVespaIds: string[],
  removeDataSource: boolean = false,
) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId))

  if (!agent) {
    throw new Error(`Agent ${agentId} not found`)
  }

  const appIntegrations = (agent.appIntegrations as any) || {}

  if (!appIntegrations.knowledge_base) {
    Logger.debug(
      `Creating new knowledge_base entry for agent ${agentId} with ${collectionVespaIds.length} collections`,
    )
    appIntegrations.knowledge_base = {
      itemIds: collectionVespaIds,
      selectedAll: false,
    }
  } else {
    // Union with existing itemIds — must not drop collections already attached.
    const existingIds = appIntegrations.knowledge_base.itemIds || []
    const mergedIds = [...new Set([...existingIds, ...collectionVespaIds])]
    Logger.debug(
      `Merging knowledge_base collections for agent ${agentId}: ${existingIds.length} existing + ${collectionVespaIds.length} new = ${mergedIds.length} total`,
    )
    appIntegrations.knowledge_base.itemIds = mergedIds
  }

  if (removeDataSource && appIntegrations.DataSource) {
    Logger.info(`✓ Removing DataSource integration from agent ${agentId}`)
    delete appIntegrations.DataSource
  } else if (removeDataSource && !appIntegrations.DataSource) {
    Logger.debug(`DataSource already removed from agent ${agentId}`)
  } else if (!removeDataSource && appIntegrations.DataSource) {
    Logger.debug(`Preserving DataSource integration for agent ${agentId} (use --remove-datasource to remove)`)
  }

  await db
    .update(agents)
    .set({
      appIntegrations: appIntegrations,
      updatedAt: sql`NOW()`,
    })
    .where(eq(agents.id, agentId))

  Logger.debug(
    `Updated agent ${agentId} with knowledge base collections: ${collectionVespaIds.join(", ")}${removeDataSource ? " (DataSource removed)" : ""}`,
  )
}

/** Page through all files of a datasource from Vespa, matched by dataSourceId. */
async function fetchDatasourceFiles(
  datasourceId: string,
  _userEmail: string,
): Promise<any[]> {
  try {
    const configModule = await import("@/config")
    const CLUSTER = configModule.CLUSTER

    // Source is `CLUSTER.datasource_file` (schema only, no namespace).
    const yql = `select * from ${CLUSTER}.datasource_file where dataSourceId contains "${datasourceId}"`

    Logger.info(`Executing Vespa query: ${yql}`)

    // Hit the query endpoint's /search/, not the document API.
    const vespaEndpoint = configModule.default.vespaEndpoint.queryEndpoint
    const searchUrl = `${vespaEndpoint}/search/`

    Logger.debug(`Vespa endpoint: ${searchUrl}`)

    const hitsPerPage = 400 // Vespa max
    let offset = 0
    let allFiles: any[] = []
    let totalCount = 0
    let hasMore = true

    while (hasMore) {
      Logger.debug(`Fetching files with offset ${offset}, hits ${hitsPerPage}`)

      const response = await fetch(searchUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          yql,
          hits: hitsPerPage,
          offset: offset,
          timeout: 10000,
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        Logger.error(`Vespa HTTP error: ${response.status} ${response.statusText}`)
        Logger.error(`Vespa error response: ${errorText}`)
        throw new Error(
          `Vespa query failed: ${response.status} ${response.statusText}`,
        )
      }

      const results = await response.json()

      if (results && results.root) {
        if (offset === 0 && results.root.fields && results.root.fields.totalCount !== undefined) {
          totalCount = results.root.fields.totalCount
          Logger.info(`Total files in datasource ${datasourceId}: ${totalCount}`)
        }

        if (results.root.errors && results.root.errors.length > 0) {
          Logger.error(`Vespa query errors: ${JSON.stringify(results.root.errors)}`)
        }

        if (results.root.children && results.root.children.length > 0) {
          allFiles = allFiles.concat(results.root.children)
          Logger.debug(`Fetched ${results.root.children.length} files in this batch (total so far: ${allFiles.length})`)

          offset += results.root.children.length
          hasMore = results.root.children.length === hitsPerPage && offset < totalCount
        } else {
          hasMore = false
        }
      } else {
        hasMore = false
      }
    }

    if (allFiles.length > 0) {
      Logger.info(
        `Found ${allFiles.length} files for datasource ${datasourceId}`,
      )
      return allFiles
    }

    Logger.warn(
      `No files found for datasource ${datasourceId} (query returned no results)`,
    )
    return []
  } catch (error) {
    Logger.error(
      `Error fetching files for datasource ${datasourceId}:`,
      error,
    )
    if (error instanceof Error) {
      Logger.error(`Error message: ${error.message}`)
      Logger.error(`Error stack: ${error.stack}`)
    }
    return []
  }
}

async function dryRun() {
  Logger.info("Running in DRY RUN mode - no changes will be made")

  const agentsWithDatasources = await db
    .select()
    .from(agents)
    .where(isNull(agents.deletedAt))

  let totalDatasources = 0
  let agentsWithDsCount = 0

  for (const agent of agentsWithDatasources) {
    const appIntegrations = agent.appIntegrations as any

    if (
      appIntegrations &&
      typeof appIntegrations === "object" &&
      appIntegrations.DataSource
    ) {
      const datasourceIds = appIntegrations.DataSource.itemIds as string[]
      if (datasourceIds && datasourceIds.length > 0) {
        agentsWithDsCount++
        totalDatasources += datasourceIds.length
        Logger.info(
          `Agent ${agent.id} (${agent.name}): ${datasourceIds.length} datasources - ${datasourceIds.join(", ")}`,
        )
      }
    }
  }

  Logger.info("=" + "=".repeat(60))
  Logger.info("Dry Run Summary:")
  Logger.info(`Total agents: ${agentsWithDatasources.length}`)
  Logger.info(`Agents with datasources: ${agentsWithDsCount}`)
  Logger.info(`Total datasources to migrate: ${totalDatasources}`)
  Logger.info("=" + "=".repeat(60))
}

// Main execution
const args = process.argv.slice(2)
const isDryRun = args.includes("--dry-run")
const removeDataSource = args.includes("--remove-datasource")

Logger.info("Migration Script Configuration:")
Logger.info(`  Dry run: ${isDryRun}`)
Logger.info(`  Remove DataSource after migration: ${removeDataSource}`)
if (!removeDataSource) {
  Logger.warn("  ⚠️  DataSource objects will NOT be removed (use --remove-datasource to remove)")
}
Logger.info("=" + "=".repeat(60))

if (isDryRun) {
  dryRun()
    .then(() => {
      Logger.info("Dry run completed successfully")
      process.exit(0)
    })
    .catch((error) => {
      Logger.error("Dry run failed:", error)
      process.exit(1)
    })
} else {
  migrateDatasourcesToKnowledgeBase(removeDataSource)
    .then(() => {
      Logger.info("Migration completed successfully")
      process.exit(0)
    })
    .catch((error) => {
      Logger.error("Migration failed:", error)
      process.exit(1)
    })
}
