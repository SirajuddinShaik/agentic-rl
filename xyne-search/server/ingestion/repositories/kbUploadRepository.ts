import { db } from "@/platform/db/client"
import {
  createFileItem,
  generateFileVespaDocId,
  generateStorageKey,
  getCollectionItemById,
} from "@/platform/db/knowledgeBase"
import type { CollectionItem } from "@/platform/db/schema"
import { IngestionUploadError } from "@/ingestion/domain/errors"
import type { TxnOrClient } from "@/types"

export type UploadIdentifiers = {
  storageKey: string
  vespaDocId: string
}

export const createUploadIdentifiers = (): UploadIdentifiers => ({
  storageKey: generateStorageKey(),
  vespaDocId: generateFileVespaDocId(),
})

export const assertValidUploadParent = async (
  collectionId: string,
  parentId: string | null,
): Promise<void> => {
  if (!parentId) {
    return
  }
  const parent = await getCollectionItemById(db, parentId)
  if (!parent || parent.collectionId !== collectionId || parent.type !== "folder") {
    throw new IngestionUploadError("INVALID_PARENT", "Invalid parentId", 400)
  }
}

export type CreateUploadedFileItemInput = {
  collectionId: string
  parentId: string | null
  name: string
  vespaDocId: string
  storagePath: string
  storageKey: string
  mimeType: string
  fileSize: number
  checksum: string
  uploadedById: number
  uploadedByEmail: string
}

export const createUploadedFileItem = async (
  input: CreateUploadedFileItemInput,
): Promise<CollectionItem> => {
  return await db.transaction(async (tx: TxnOrClient) =>
    createFileItem(
      tx,
      input.collectionId,
      input.parentId,
      input.name,
      input.vespaDocId,
      input.name,
      input.storagePath,
      input.storageKey,
      input.mimeType,
      input.fileSize,
      input.checksum,
      {},
      input.uploadedById,
      input.uploadedByEmail,
      "File uploaded successfully, queued for processing",
    ),
  )
}
