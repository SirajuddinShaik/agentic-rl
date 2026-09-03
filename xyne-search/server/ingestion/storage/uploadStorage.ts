import { mkdir, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { getUploadStoragePath } from "@/ingestion/storage/paths"

export type WriteUploadedBytesInput = {
  workspaceExternalId: string
  collectionId: string
  storageKey: string
  fileName: string
  buffer: Buffer
}

export const writeUploadedBytes = async (
  input: WriteUploadedBytesInput,
): Promise<string> => {
  const storagePath = getUploadStoragePath(
    input.workspaceExternalId,
    input.collectionId,
    input.storageKey,
    input.fileName,
  )
  await mkdir(dirname(storagePath), { recursive: true })
  await writeFile(storagePath, new Uint8Array(input.buffer))
  return storagePath
}

export const removeUploadedBytes = async (
  storagePath: string,
): Promise<void> => {
  await unlink(storagePath)
}
