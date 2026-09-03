import path from "node:path"
import { db } from "@/platform/db/client"
import { collectionItems } from "@/platform/db/schema"
import { getDoclingRuntimeConfig } from "@/ingestion/docling/runtime/config"
import { buildDoclingSchedulerSourceReference } from "@/ingestion/docling/scheduler/storage"
import {
  inferDoclingSourcePriority,
  upsertDoclingAsyncFileForSplit,
} from "@/ingestion/docling/scheduler/store"
import { UploadStatus } from "@/platform/shared/types"
import { eq } from "drizzle-orm"

const DOCLING_OCR_PROCESSING_METHOD = "docling"

export function resolveRuntimeStoragePath(storagePath: string): string {
  const runtimeServerRoot =
    process.env.XYNE_CONTAINER_SERVER_ROOT || process.cwd()
  const hostServerRoot = process.env.XYNE_HOST_SERVER_ROOT

  if (hostServerRoot && storagePath.startsWith(hostServerRoot + path.sep)) {
    return path.join(
      runtimeServerRoot,
      path.relative(hostServerRoot, storagePath),
    )
  }

  const marker = "/server/storage/"
  const markerIndex = storagePath.indexOf(marker)
  if (
    markerIndex >= 0 &&
    !storagePath.startsWith(runtimeServerRoot + path.sep)
  ) {
    return path.join(
      runtimeServerRoot,
      storagePath.slice(markerIndex + "/server/".length),
    )
  }

  return storagePath
}

export function mergeCollectionItemMetadata(
  existingMetadata: unknown,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const baseMetadata =
    typeof existingMetadata === "object" && existingMetadata !== null
      ? { ...(existingMetadata as Record<string, unknown>) }
      : {}

  return {
    ...baseMetadata,
    ...updates,
  }
}

export type QueuePdfForDoclingSchedulerInput = {
  fileId: string
  vespaDocId: string | null
  collectionId: string
  parentId?: string | null
  collectionName: string
  fileName: string
  originalName?: string | null
  storagePath: string | null
  path: string
  mimeType?: string | null
  fileSize?: number | null
  uploadedByEmail?: string | null
  pageTitle?: string
  metadata?: unknown
}

export const queuePdfForDoclingScheduler = async (
  input: QueuePdfForDoclingSchedulerInput,
) => {
  if (!input.storagePath) {
    throw new Error(`No storage path for file: ${input.fileId}`)
  }

  if (!input.vespaDocId) {
    throw new Error(`No vespaDocId for file: ${input.fileId}`)
  }

  const runtimeStoragePath = resolveRuntimeStoragePath(input.storagePath)
  const { sourceKind, basePriority } = inferDoclingSourcePriority({
    collectionId: input.collectionId,
    ...(input.parentId !== undefined && { parentId: input.parentId }),
    metadata: input.metadata,
  })
  const schedulerSource =
    buildDoclingSchedulerSourceReference(runtimeStoragePath)
  const runtimeConfig = getDoclingRuntimeConfig()

  const schedulerFile = await upsertDoclingAsyncFileForSplit({
    fileId: input.fileId,
    vespaDocId: input.vespaDocId,
    collectionId: input.collectionId,
    parentId: input.parentId,
    collectionName: input.collectionName,
    fileName: input.fileName,
    originalName: input.originalName,
    sourcePath: schedulerSource.sourcePath,
    sourceStorageKey: schedulerSource.sourceStorageKey,
    path: input.path,
    mimeType: input.mimeType,
    fileSize: input.fileSize,
    uploadedByEmail: input.uploadedByEmail,
    pageTitle: input.pageTitle,
    metadata: input.metadata,
    sourceKind,
    basePriority,
    priorityOverride: null,
    totalPages: 0,
    totalParts: 0,
    pageChunkSize: runtimeConfig.pageChunkSize,
  })

  if (!schedulerFile) {
    return {
      schedulerFile: null,
      runtimeStoragePath,
      sourceKind,
      basePriority,
    }
  }

  await db
    .update(collectionItems)
    .set({
      uploadStatus: UploadStatus.PROCESSING,
      statusMessage: `Queued file for async OCR scheduler: ${input.fileName}`,
      metadata: mergeCollectionItemMetadata(input.metadata, {
        pdfProcessingMethod: DOCLING_OCR_PROCESSING_METHOD,
        ocrProcessingMethod: DOCLING_OCR_PROCESSING_METHOD,
        ocrProcessingMimeType: input.mimeType || null,
        doclingAsyncScheduler: true,
        doclingPageChunkSize: runtimeConfig.pageChunkSize,
      }),
      updatedAt: new Date(),
    })
    .where(eq(collectionItems.id, input.fileId))

  return {
    schedulerFile,
    runtimeStoragePath,
    sourceKind,
    basePriority,
  }
}
