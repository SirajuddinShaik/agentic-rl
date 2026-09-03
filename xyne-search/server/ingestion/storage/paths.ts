import { isAbsolute, join, extname } from "node:path"

import config from "@/config"

const KB_STORAGE_ROOT = isAbsolute(config.knowledgeBaseStorageRoot)
  ? config.knowledgeBaseStorageRoot
  : join(process.cwd(), config.knowledgeBaseStorageRoot)

export function sanitizeFileName(fileName: string): string {
  if (!fileName || typeof fileName !== "string") {
    return "unnamed_file"
  }

  let sanitized = fileName.normalize("NFC")
  sanitized = sanitized.replace(/[/\\]/g, "_")
  sanitized = sanitized.replace(/[\x00-\x1F]/g, "")
  sanitized = sanitized.replace(/^[\s.]+/, "")
  sanitized = sanitized.replace(/\.{2,}/g, ".")
  sanitized = sanitized.replace(/[\s.]+$/, "")

  if (sanitized.length > 255) {
    const ext = extname(sanitized)
    const baseName = sanitized.slice(0, -ext.length || sanitized.length)
    sanitized = baseName.slice(0, 255 - ext.length) + ext
  }

  if (!sanitized || sanitized.trim() === "") {
    return "unnamed_file"
  }

  return sanitized
}

export function getUploadStoragePath(
  workspaceId: string,
  collectionId: string,
  storageKey: string,
  fileName: string,
): string {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const sanitizedFileName = sanitizeFileName(fileName)
  return join(
    KB_STORAGE_ROOT,
    workspaceId,
    collectionId,
    year.toString(),
    month,
    `${storageKey}_${sanitizedFileName}`,
  )
}
