import type { CollectionItem } from "@/platform/db/schema"
import { getBaseMimeType } from "@/integrations/dataSource/config"
import { getLogger } from "@/platform/logger"
import {
  queuePdfForDocling,
  queueStandardFileProcessing,
} from "@/ingestion/queue/producer"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Api).child({
  module: "ingestion/admission",
})

const OCR_REQUIRED_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
])

export const requiresOCR = (mimeType: string): boolean =>
  OCR_REQUIRED_MIME_TYPES.has(getBaseMimeType(mimeType))

export type AdmitUploadedKbFileInput = {
  item: CollectionItem
  collectionName: string
  mimeType: string
}

export const admitUploadedKbFile = async (
  input: AdmitUploadedKbFileInput,
): Promise<void> => {
  const requiresOcr = requiresOCR(input.mimeType)
  if (requiresOcr) {
    const { schedulerFile, sourceKind, basePriority } =
      await queuePdfForDocling({
        item: input.item,
        collectionName: input.collectionName,
        mimeType: input.mimeType,
      })
    Logger.info(
      {
        fileId: input.item.id,
        sourceKind,
        basePriority,
        requiresOcr,
        queuedThroughDoclingScheduler: Boolean(schedulerFile),
      },
      schedulerFile
        ? "Queued uploaded file directly for async OCR scheduler"
        : "Skipped direct async OCR scheduler queue because file already exists there",
    )
    return
  }

  Logger.info(
    {
      fileId: input.item.id,
      mimeType: input.mimeType,
      requiresOcr,
    },
    "Queued uploaded file for standard processing",
  )
  await queueStandardFileProcessing(input.item.id)
}
