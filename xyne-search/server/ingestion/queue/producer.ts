import type { CollectionItem } from "@/platform/db/schema"
import { queuePdfForDoclingScheduler } from "@/ingestion/docling/scheduler/intake"
import { FileProcessingQueue, boss } from "@/platform/queue/api-server-queue"
import { ProcessingJobType } from "@/types"

export type QueueDoclingPdfInput = {
  item: CollectionItem
  collectionName: string
  mimeType: string
}

export const queuePdfForDocling = async (
  input: QueueDoclingPdfInput,
): ReturnType<typeof queuePdfForDoclingScheduler> => {
  const item = input.item
  return await queuePdfForDoclingScheduler({
    fileId: item.id,
    vespaDocId: item.vespaDocId,
    collectionId: item.collectionId,
    parentId: item.parentId,
    collectionName: input.collectionName,
    fileName: item.name,
    originalName: item.originalName,
    storagePath: item.storagePath,
    path: item.path,
    mimeType: item.mimeType || input.mimeType,
    fileSize: item.fileSize,
    uploadedByEmail: item.uploadedByEmail,
    metadata: item.metadata,
  })
}

export const queueStandardFileProcessing = async (
  fileId: string,
): Promise<void> => {
  await boss.send(
    FileProcessingQueue,
    {
      fileId,
      type: ProcessingJobType.FILE,
      useOCR: true,
    },
    { retryLimit: 3, expireInHours: 12 },
  )
}
