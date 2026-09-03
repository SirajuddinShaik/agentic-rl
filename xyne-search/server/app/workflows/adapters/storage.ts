import { mkdir, readFile, unlink, writeFile } from "fs/promises"
import path from "path"
import type { StorageAdapter, StorageFile, StorageScope } from "@xyne/workflow-sdk"
import type { Attachment } from "@xyne/workflow-sdk/common"
import { createId } from "@paralleldrive/cuid2"

const STORAGE_ROOT = path.resolve(
  process.env["WORKFLOW_ATTACHMENTS_DIR"] ?? "./storage/workflow_attachments",
)

// Resolve an attachment ref under STORAGE_ROOT, refusing any path that escapes
// it. ref.data comes from step config (attacker-influenced), so a "../.." would
// otherwise let read()/delete() reach arbitrary files on the host.
const resolveWithinRoot = (refData: string): string => {
  const filePath = path.resolve(STORAGE_ROOT, refData)
  if (filePath !== STORAGE_ROOT && !filePath.startsWith(STORAGE_ROOT + path.sep)) {
    throw new Error(
      `DiskStorageAdapter: attachment ref escapes storage root: ${JSON.stringify(refData)}`,
    )
  }
  return filePath
}

export class DiskStorageAdapter implements StorageAdapter {
  async store(scope: StorageScope, file: StorageFile): Promise<Attachment> {
    const workspaceId = (scope as { workspaceId?: string }).workspaceId
    const scopeDir = path.join(STORAGE_ROOT, workspaceId ?? "default")
    await mkdir(scopeDir, { recursive: true })
    const id = createId()
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_")
    const fileName = `${id}-${safeName}`
    const filePath = path.join(scopeDir, fileName)
    await writeFile(filePath, file.bytes)
    return {
      name: file.name,
      mimeType: file.mimeType,
      data: path.relative(STORAGE_ROOT, filePath), // relative ref stored in context
      size: file.bytes.byteLength,
    }
  }

  async read(ref: Attachment): Promise<Uint8Array> {
    const filePath = resolveWithinRoot(ref.data)
    const buf = await readFile(filePath)
    return new Uint8Array(buf)
  }

  async delete(ref: Attachment): Promise<void> {
    const filePath = resolveWithinRoot(ref.data)
    await unlink(filePath).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err
    })
  }
}
