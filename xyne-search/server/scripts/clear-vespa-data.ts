import path from "path"
import fs from "fs/promises"
import type {
  VespaSearchResponse,
  VespaSchema,
} from "@xyne/vespa-ts/types"
import {
  fileSchema,
  userSchema,
  mailSchema,
  eventSchema,
  userQuerySchema,
  mailAttachmentSchema,
  chatContainerSchema,
  chatTeamSchema,
  chatMessageSchema,
  chatUserSchema,
  chatAttachmentSchema,
} from "@xyne/vespa-ts/types"

// Returns namespace-prefixed names, e.g. "my_content.file".
async function getVespaSchemas(): Promise<string[]> {
  const scriptDir = path.dirname(new URL(import.meta.url).pathname)
  const schemasDir = path.join(scriptDir, "../vespa/schemas")
  try {
    const files = await fs.readdir(schemasDir)
    const schemaNames = files
      .filter((file) => file.endsWith(".sd"))
      .map((file) => `my_content.${file.replace(".sd", "")}`)
    return schemaNames
  } catch (error) {
    console.error(`Error reading Vespa schemas directory ${schemasDir}:`, error)
    return []
  }
}

import VespaClient from "@xyne/vespa-ts/client"
import { UpdateDocument, DeleteDocument } from "@/platform/search/vespa"

const vespaClient = new VespaClient()

async function getVespaDocumentCount(yqlQuery: string): Promise<number> {
  try {
    const countPayload = {
      yql: yqlQuery,
      hits: 0,
      "ranking.profile": "unranked",
    }
    const searchResult: VespaSearchResponse =
      await vespaClient.search(countPayload)
    return searchResult.root?.fields?.totalCount || 0
  } catch (error) {
    console.error(
      `Error getting Vespa document count for query "${yqlQuery}":`,
      error,
    )
    return 0
  }
}

// schemaName is bare (e.g. "mail") for DeleteDocument; yqlQuery must already
// carry the fully-qualified name (e.g. my_content.mail). userId is for logging.
async function deleteDocumentsByQuery(
  _targetNamespace: string,
  _targetCluster: string,
  schemaName: VespaSchema,
  yqlQuery: string,
  userId: string,
): Promise<void> {
  const BATCH_SIZE = 100
  let offset = 0
  let hasMore = true
  let totalDeleted = 0

  while (hasMore) {
    try {
      const searchPayload = {
        yql: yqlQuery,
        hits: BATCH_SIZE,
        offset: offset,
        timeout: "10s",
        "ranking.profile": "unranked",
      }

      const searchResult: VespaSearchResponse =
        await vespaClient.search<VespaSearchResponse>(searchPayload)
      const docsToDelete = searchResult.root?.children || []

      if (docsToDelete.length === 0) {
        hasMore = false
        break
      }

      console.log(
        `Found ${docsToDelete.length} documents in schema '${schemaName}' (query context) for user '${userId}'. Deleting...`,
      )

      for (const doc of docsToDelete) {
        if (doc.fields && "docId" in doc.fields) {
          const docIdToDelete = doc.fields.docId as string
          if (docIdToDelete) {
            await DeleteDocument(docIdToDelete, schemaName)
            totalDeleted++
          }
        }
      }
      console.log(
        `Deleted batch of ${docsToDelete.length} documents for schema '${schemaName}', user '${userId}'. Total deleted so far: ${totalDeleted}`,
      )

      offset += docsToDelete.length
      if (docsToDelete.length < BATCH_SIZE) {
        hasMore = false
      }
    } catch (error) {
      console.error(
        `Error searching/deleting documents in schema ${schemaName} for user ${userId}:`,
        error,
      )
      hasMore = false
    }
  }
  console.log(
    `Finished deleting documents in schema '${schemaName}' for user '${userId}'. Total deleted: ${totalDeleted}`,
  )
}

// Removes `email` from each matching doc's permissions array; deletes the doc
// when it was the last holder. bareSchemaName (e.g. "file") feeds Update/Delete.
async function processDocumentsWithEmailPermissions(
  _targetNamespace: string,
  _targetCluster: string,
  bareSchemaName: VespaSchema,
  vespaClient: VespaClient,
  permissionQuery: string,
  email: string,
): Promise<void> {
  console.log(
    `[Permissions] Processing schema '${bareSchemaName}' for email ${email}. Fetch query: ${permissionQuery}`,
  )

  const lowercasedEmailToRemove = email.toLowerCase()

  let offset = 0
  let hasMore = true
  const BATCH_SIZE = 50
  let processedCount = 0
  let deletedCount = 0
  let updatedCount = 0

  while (hasMore) {
    const searchPayload = {
      yql: permissionQuery,
      hits: BATCH_SIZE,
      offset: offset,
      timeout: "10s",
      "ranking.profile": "unranked",
    }

    console.log(
      `  [Permissions] Fetching batch for ${bareSchemaName} with offset ${offset}. Payload: ${JSON.stringify(searchPayload)}`,
    )
    const searchResult: VespaSearchResponse =
      await vespaClient.search(searchPayload)
    const docsToProcess = searchResult.root?.children || []
    console.log(
      `  [Permissions] Fetched ${docsToProcess.length} documents in this batch for ${bareSchemaName}.`,
    )

    if (docsToProcess.length === 0) {
      hasMore = false
      break
    }

    processedCount += docsToProcess.length
    console.log(
      `[Permissions] Total documents fetched so far for ${bareSchemaName}: ${processedCount}. Processing current batch...`,
    )

    for (const doc of docsToProcess) {
      if (
        !doc.fields ||
        !("docId" in doc.fields) ||
        !("permissions" in doc.fields)
      ) {
        console.warn(
          `[Permissions] Skipping document from '${bareSchemaName}' (Vespa ID: ${doc.id}, internal docId: ${(doc.fields as any)?.docId}) due to missing docId or permissions field. Fetched fields: ${JSON.stringify(doc.fields)}`,
        )
        continue
      }
      const docFields = doc.fields as { docId: string; permissions: string[] }
      const docIdToProcess = docFields.docId
      const currentPermissions = Array.isArray(docFields.permissions)
        ? docFields.permissions
        : []

      console.log(
        `[Permissions] Processing docId ${docIdToProcess} (Vespa ID: ${doc.id}) from schema ${bareSchemaName}. Current permissions: [${currentPermissions.join(", ")}] for email ${email}.`,
      )

      const emailExistsInPermissions = currentPermissions.some(
        (p) => p.toLowerCase() === lowercasedEmailToRemove,
      )

      if (emailExistsInPermissions) {
        const updatedPermissions = currentPermissions.filter(
          (p) => p.toLowerCase() !== lowercasedEmailToRemove,
        )
        console.log(
          `  [Permissions] Email ${email} (match found) in permissions for docId ${docIdToProcess}. Original: [${currentPermissions.join(", ")}], After filtering ${email}: [${updatedPermissions.join(", ")}].`,
        )

        if (updatedPermissions.length === 0) {
          console.log(
            `  [Permissions] DocId ${docIdToProcess} in '${bareSchemaName}': email ${email} was the last permission holder. Attempting to delete document.`,
          )
          await DeleteDocument(docIdToProcess, bareSchemaName)
          console.log(
            `    [Permissions] Successfully requested deletion for docId ${docIdToProcess}.`,
          )
          deletedCount++
        } else {
          console.log(
            `  [Permissions] DocId ${docIdToProcess} in '${bareSchemaName}': email ${email} removed from permissions. Others remain. Attempting to update permissions to [${updatedPermissions.join(", ")}].`,
          )
          await UpdateDocument(bareSchemaName, docIdToProcess, {
            permissions: updatedPermissions,
          })
          console.log(
            `    [Permissions] Successfully requested permission update for docId ${docIdToProcess} to [${updatedPermissions.join(", ")}].`,
          )
          updatedCount++
        }
      } else {
        console.warn(
          `  [Permissions] DocId ${docIdToProcess} in '${bareSchemaName}' was fetched by query "${permissionQuery}", but email ${email} NOT in its permissions [${currentPermissions.join(", ")}]. This might indicate an issue or stale index. Skipping modification for this document.`,
        )
      }
    }
    offset += docsToProcess.length
    if (docsToProcess.length < BATCH_SIZE) {
      hasMore = false
    }
  }
  console.log(
    `[Permissions] Finished processing schema '${bareSchemaName}' for email ${email}. Total Fetched: ${processedCount}, Deleted: ${deletedCount}, Permissions Updated: ${updatedCount}.`,
  )
}

async function clearVespaDataByUser(email: string): Promise<void> {
  console.log(
    `Starting to clear data for user: ${email} from Vespa (primarily 'my_content' namespace)...`,
  )
  const allPrefixedSchemas = await getVespaSchemas()
  if (allPrefixedSchemas.length === 0) {
    console.warn(
      "No Vespa schemas (for 'my_content' namespace) found. Aborting clear operation for user.",
    )
    return
  }

  const targetNamespace = "my_content"
  const targetCluster = "my_content"

  const chatSchemasToSkip: VespaSchema[] = [
    chatMessageSchema,
    chatContainerSchema,
    chatTeamSchema,
    chatUserSchema,
    chatAttachmentSchema,
  ]

  for (const fullSchemaName of allPrefixedSchemas) {
    const bareSchemaNameString = fullSchemaName.replace(
      `${targetNamespace}.`,
      "",
    )
    // Safe cast: names come from real .sd files, which map to VespaSchema.
    const bareSchemaName = bareSchemaNameString as any as VespaSchema

    if (chatSchemasToSkip.includes(bareSchemaName)) {
      console.log(
        `Skipping chat schema: ${fullSchemaName} (bare: ${bareSchemaName}) for user-specific deletion.`,
      )
      continue
    }

    let yqlQueryForDirectDelete = ""
    let permissionProcessingQuery = ""
    let postPermissionYqlDeleteQuery = ""

    console.log(
      `Processing schema ${fullSchemaName} (bare: ${bareSchemaName}) for user ${email}`,
    )

    try {
      switch (bareSchemaName) {
        case userSchema:
          yqlQueryForDirectDelete = `select * from ${fullSchemaName} where email contains "${email}"`
          break

        case mailSchema:
          permissionProcessingQuery = `select docId, permissions from ${fullSchemaName} where permissions contains "${email}"`
          // Owned mails are deleted outright; from/to/cc/bcc-only mails are not.
          yqlQueryForDirectDelete = `select * from ${fullSchemaName} where owner contains "${email}"`
          break

        case mailAttachmentSchema:
          permissionProcessingQuery = `select docId, permissions from ${fullSchemaName} where permissions contains "${email}"`
          yqlQueryForDirectDelete = ""
          break

        case fileSchema: {
          permissionProcessingQuery = `select docId, permissions from ${fullSchemaName} where permissions contains "${email}"`
          break
        }

        case eventSchema: {
          permissionProcessingQuery = `select docId, permissions from ${fullSchemaName} where permissions contains "${email}"`
          // Runs after permission processing: also delete events the user
          // created, organized, or attended.
          postPermissionYqlDeleteQuery = `select * from ${fullSchemaName} where creator.email contains "${email}" or organizer.email contains "${email}" or attendees.email contains "${email}"`
          break
        }

        case userQuerySchema:
          console.log(
            `Skipping schema '${userQuerySchema}' (full: ${fullSchemaName}) for email ${email}.`,
          )
          yqlQueryForDirectDelete = ""
          permissionProcessingQuery = ""
          break

        default:
          console.log(
            `No specific user deletion logic for schema: ${fullSchemaName} (bare: ${bareSchemaName}). Skipping.`,
          )
          continue
      }

      // 1. Permission-array processing
      if (permissionProcessingQuery) {
        const initialCount = await getVespaDocumentCount(
          permissionProcessingQuery,
        )
        console.log(
          `Schema '${fullSchemaName}': Initial count for permission processing (query: ${permissionProcessingQuery}): ${initialCount}`,
        )
        if (initialCount > 0) {
          await processDocumentsWithEmailPermissions(
            targetNamespace,
            targetCluster,
            bareSchemaName,
            vespaClient,
            permissionProcessingQuery,
            email,
          )
        } else {
          console.log(
            `Schema '${fullSchemaName}': No documents found for permission processing (query: ${permissionProcessingQuery}).`,
          )
        }
      }

      // 2. Direct deletions
      if (yqlQueryForDirectDelete) {
        const initialCount = await getVespaDocumentCount(
          yqlQueryForDirectDelete,
        )
        console.log(
          `Schema '${fullSchemaName}': Initial count for direct deletion (query: ${yqlQueryForDirectDelete}): ${initialCount}`,
        )
        if (initialCount > 0) {
          await deleteDocumentsByQuery(
            targetNamespace,
            targetCluster,
            bareSchemaName,
            yqlQueryForDirectDelete,
            email,
          )
          const finalCount = await getVespaDocumentCount(
            yqlQueryForDirectDelete,
          )
          console.log(
            `Schema '${fullSchemaName}': Final count after direct deletion (query: ${yqlQueryForDirectDelete}): ${finalCount}.`,
          )
        } else {
          console.log(
            `Schema '${fullSchemaName}': No documents found for direct deletion (query: ${yqlQueryForDirectDelete}).`,
          )
        }
      }

      // 3. Post-permission deletions (e.g. event roles)
      if (postPermissionYqlDeleteQuery) {
        const initialCount = await getVespaDocumentCount(
          postPermissionYqlDeleteQuery,
        )
        console.log(
          `Schema '${fullSchemaName}': Initial count for post-permission deletion (query: ${postPermissionYqlDeleteQuery}): ${initialCount}`,
        )
        if (initialCount > 0) {
          await deleteDocumentsByQuery(
            targetNamespace,
            targetCluster,
            bareSchemaName,
            postPermissionYqlDeleteQuery,
            email,
          )
          const finalCount = await getVespaDocumentCount(
            postPermissionYqlDeleteQuery,
          )
          console.log(
            `Schema '${fullSchemaName}': Final count after post-permission deletion (query: ${postPermissionYqlDeleteQuery}): ${finalCount}.`,
          )
        } else {
          console.log(
            `Schema '${fullSchemaName}': No documents found for post-permission deletion (query: ${postPermissionYqlDeleteQuery}).`,
          )
        }
      }
    } catch (error: any) {
      console.error(
        `Error processing schema ${fullSchemaName} (bare: ${bareSchemaName}) for user ${email}:`,
        error,
      )
    }
  }
  console.log(`Finished clearing data for user: ${email} from Vespa.`)
}

;(async () => {
  try {
    const userEmailToClear = ""
    await clearVespaDataByUser(userEmailToClear)
  } catch (error: any) {
    console.error("Error in main execution:", error)
  }
})()
