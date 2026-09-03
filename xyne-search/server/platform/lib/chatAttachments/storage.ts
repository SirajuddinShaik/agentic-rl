// Disk I/O for chat attachments. The DB row stores `storagePath` relative to
// the configured root; the helpers below are the only place that resolves
// that relative path against the absolute root and reads/writes bytes. Every
// other layer treats attachments as opaque blobs.
//
// Layout on disk:
//   <root>/<conversationId>/<attachmentId>-<sanitizedFileName>
//
// The attachmentId prefix means two uploads of the same `report.xlsx` don't
// collide; the original `fileName` is preserved on the DB row for display
// and as the in-sandbox filename.

import { promises as fs } from "node:fs"
import * as path from "node:path"

// Storage root, resolved against the server's cwd at boot. Override via env
// for prod deployments that mount a separate PVC (typical when xyne-app runs
// on the GCP VM where the bind-mount lives under /usr/src/app/server/storage).
const STORAGE_ROOT = path.resolve(
  process.env["BACKENDV2_CHAT_ATTACHMENTS_DIR"] ?? "./storage/chat_attachments",
)

// Strip anything that could escape the conversation subdir or break a shell
// later. Allowlist: letters, digits, dot, dash, underscore. Everything else
// collapses to "_". Filenames are capped at 200 chars to stay well under the
// typical 255-byte FS limit even when the attachmentId prefix is added.
const sanitizeFileName = (name: string): string => {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 200)
  return cleaned.length > 0 ? cleaned : "unnamed"
}

const absDir = (conversationId: string): string =>
  path.join(STORAGE_ROOT, conversationId)

const relPathFor = (
  conversationId: string,
  attachmentId: string,
  fileName: string,
): string =>
  path.join(conversationId, `${attachmentId}-${sanitizeFileName(fileName)}`)

const absPathFor = (relPath: string): string => path.join(STORAGE_ROOT, relPath)

/** Persist bytes for an attachment. Returns the path the caller should store
 *  on the DB row. Idempotent — safe to retry after a partial failure as long
 *  as the caller passes the same attachmentId. */
export async function writeAttachmentBytes(args: {
  conversationId: string
  attachmentId: string
  fileName: string
  bytes: Uint8Array
}): Promise<{ relPath: string }> {
  await fs.mkdir(absDir(args.conversationId), { recursive: true })
  const relPath = relPathFor(
    args.conversationId,
    args.attachmentId,
    args.fileName,
  )
  await fs.writeFile(absPathFor(relPath), args.bytes)
  return { relPath }
}

/** Read an attachment's bytes back. Throws if the underlying file is missing
 *  (DB row exists but the bytes have been removed out-of-band — treat as a
 *  bug, not an expected state). */
export async function readAttachmentBytes(relPath: string): Promise<Uint8Array> {
  const buf = await fs.readFile(absPathFor(relPath))
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

/** Delete an attachment's bytes. Best-effort — a missing file is a no-op
 *  rather than an error (e.g. the file was already cleaned up by a prior
 *  partial delete that succeeded on the FS but failed on the DB row). */
export async function deleteAttachmentBytes(relPath: string): Promise<void> {
  try {
    await fs.unlink(absPathFor(relPath))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "ENOENT") throw err
  }
}

/** Delete an entire conversation's attachment dir. Called when a conversation
 *  is hard-deleted — the FK cascade removes DB rows; this removes the bytes.
 *  Best-effort: a missing dir is fine. */
export async function deleteConversationAttachmentsDir(
  conversationId: string,
): Promise<void> {
  try {
    await fs.rm(absDir(conversationId), { recursive: true, force: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "ENOENT") throw err
  }
}

export const _internals = {
  STORAGE_ROOT,
  sanitizeFileName,
  relPathFor,
  absPathFor,
}
