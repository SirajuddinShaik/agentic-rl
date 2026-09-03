import * as crypto from "crypto"
import { extname } from "node:path"
import { fileTypeFromBuffer } from "file-type"

import {
  createUploadedFileItem,
  createUploadIdentifiers,
  assertValidUploadParent,
} from "@/ingestion/repositories/kbUploadRepository"
import { sanitizeFileName } from "@/ingestion/storage/paths"
import {
  removeUploadedBytes,
  writeUploadedBytes,
} from "@/ingestion/storage/uploadStorage"
import { admitUploadedKbFile } from "@/ingestion/services/admissionService"
import {
  MAX_KB_UPLOAD_FILE_SIZE_BYTES,
  type UploadBatchInput,
  type UploadBatchResult,
  type UploadResult,
} from "@/ingestion/domain/types"
import { getLogger } from "@/platform/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Api).child({ module: "ingestion/upload" })

const EXT_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".html": "text/html",
  ".json": "application/json",
  ".md": "text/markdown",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

const OOXML_EXT_MIME: Record<string, string> = {
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

const detectMime = async (
  fileName: string,
  buf: Buffer,
  browserType?: string,
): Promise<string> => {
  // OOXML formats (.docx, .pptx, .xlsx) are ZIP archives — file-type sniffs
  // the ZIP magic bytes and returns "application/zip" before the extension
  // fallback runs. Check extension first for these formats.
  const ext = extname(fileName).toLowerCase()
  if (OOXML_EXT_MIME[ext]) {
    return OOXML_EXT_MIME[ext]!
  }
  try {
    const sniffed = await fileTypeFromBuffer(buf)
    if (sniffed?.mime) {
      return sniffed.mime
    }
  } catch {
    // ignore
  }
  if (browserType && browserType !== "application/octet-stream") {
    return browserType
  }
  if (EXT_MIME[ext]) {
    return EXT_MIME[ext]!
  }
  return "application/octet-stream"
}

const checksum = (buf: ArrayBuffer): string =>
  crypto.createHash("sha256").update(new Uint8Array(buf)).digest("hex")

export const uploadKbFiles = async (
  input: UploadBatchInput,
): Promise<UploadBatchResult> => {
  await assertValidUploadParent(input.collection.id, input.parentId)

  const results: UploadResult[] = []

  for (const file of input.files) {
    const originalName = sanitizeFileName(file.name)
    if (file.size > MAX_KB_UPLOAD_FILE_SIZE_BYTES) {
      results.push({
        success: false,
        name: originalName,
        error: `File too large (max ${String(MAX_KB_UPLOAD_FILE_SIZE_BYTES / 1024 / 1024)} MB)`,
      })
      continue
    }

    let storagePath = ""
    try {
      const arrayBuffer = await file.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)
      const sum = checksum(arrayBuffer)
      const mime = await detectMime(originalName, buffer, file.type)
      const { storageKey, vespaDocId } = createUploadIdentifiers()

      storagePath = await writeUploadedBytes({
        workspaceExternalId: input.actor.workspaceExternalId,
        collectionId: input.collection.id,
        storageKey,
        fileName: originalName,
        buffer,
      })

      const item = await createUploadedFileItem({
        collectionId: input.collection.id,
        parentId: input.parentId,
        name: originalName,
        vespaDocId,
        storagePath,
        storageKey,
        mimeType: mime,
        fileSize: file.size,
        checksum: sum,
        uploadedById: input.actor.id,
        uploadedByEmail: input.actor.email,
      })

      try {
        await admitUploadedKbFile({
          item,
          collectionName: input.collection.name,
          mimeType: mime,
        })
      } catch (err) {
        // Preserve existing upload semantics: once the file is persisted and
        // its DB row exists, admission/enqueue failure is logged but the upload
        // response still reports success. Reapers/retries remain responsible
        // for repair visibility.
        Logger.error({ err, fileId: item.id }, "queue enqueue failed")
      }

      results.push({ success: true, itemId: item.id, name: originalName })
      Logger.info(
        {
          fileId: item.id,
          clId: input.collection.id,
          ownerEmail: input.actor.email,
        },
        `Uploaded ${originalName} to KB ${input.collection.id}`,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : "upload failed"
      if (storagePath) {
        try {
          await removeUploadedBytes(storagePath)
        } catch {
          // ignore
        }
      }
      Logger.error({ err, name: originalName }, "upload failed")
      results.push({ success: false, name: originalName, error: msg })
    }
  }

  return {
    results,
    summary: {
      total: input.files.length,
      successful: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
    },
  }
}
