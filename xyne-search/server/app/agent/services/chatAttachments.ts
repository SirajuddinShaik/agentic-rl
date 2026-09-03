// Chat attachment business logic. Authorization is enforced at the route layer
// (conversation `ownerId` vs viewer); this service trusts that and operates on
// `conversationId` directly.

import { and, desc, eq, inArray, isNull } from "drizzle-orm"
import { db } from "@/platform/db/client"
import { v2ChatAttachments } from "@/platform/db/schema/v2Chat"
import type { TxnOrClient } from "@/types"
import {
  deleteAttachmentBytes,
  readAttachmentBytes,
  writeAttachmentBytes,
} from "@/platform/lib/chatAttachments/storage"

// Per-attachment cap. 50 MB covers Excel/PDF without letting one upload fill
// the sandbox disk; env-overridable for heavier workloads.
const MAX_ATTACHMENT_BYTES = Number(
  process.env["BACKENDV2_CHAT_ATTACHMENT_MAX_BYTES"] ?? 50 * 1024 * 1024,
)

// Cap per conversation. Prevents a runaway script / hostile user from
// stuffing thousands of files into a single conversation.
const MAX_ATTACHMENTS_PER_CONV = Number(
  process.env["BACKENDV2_CHAT_ATTACHMENT_MAX_PER_CONV"] ?? 20,
)

// MIME whitelist (header, or inferred from extension when the client sends
// generic `application/octet-stream`). Both modern and legacy Office aliases
// are accepted since older clients send the short form.
const ALLOWED_MIME_TYPES = new Set<string>([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel", // .xls
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "text/plain",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/svg+xml", // .svg — the visualization skill emits these
])

// Fallback when the upload's Content-Type is missing or generic.
const EXT_TO_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".txt": "text/plain",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
}

export type ChatAttachment = {
  id: string
  conversationId: string
  /** The user message this attachment was sent with. NULL while "pending"
   *  (received but not yet attached to a sent message); the chat service
   *  stamps it on send. */
  messageId: string | null
  fileName: string
  mimeType: string
  sizeBytes: number
  uploadedBy: string
  createdAt: number
}

export class ChatAttachmentError extends Error {
  public readonly code:
    | "too_large"
    | "unsupported_type"
    | "too_many"
    | "not_found"
    | "empty"
  public constructor(
    code: ChatAttachmentError["code"],
    message: string,
  ) {
    super(message)
    this.code = code
    this.name = "ChatAttachmentError"
  }
}

const newAttachmentId = (): string => {
  // 12 hex chars: collision-free at our scale, short on-disk filenames.
  const buf = new Uint8Array(6)
  crypto.getRandomValues(buf)
  let hex = ""
  for (const b of buf) hex += b.toString(16).padStart(2, "0")
  return `att_${hex}`
}

const inferMimeType = (fileName: string, headerMime?: string): string => {
  if (headerMime && ALLOWED_MIME_TYPES.has(headerMime)) return headerMime
  const dot = fileName.lastIndexOf(".")
  if (dot >= 0) {
    const ext = fileName.slice(dot).toLowerCase()
    const fromExt = EXT_TO_MIME[ext]
    if (fromExt) return fromExt
  }
  // Final fallback (e.g. octet-stream from a curl upload). Caller rejects this
  // as unsupported, which is intended.
  return headerMime ?? "application/octet-stream"
}

const rowToAttachment = (row: typeof v2ChatAttachments.$inferSelect): ChatAttachment => ({
  id: row.id,
  conversationId: row.conversationId,
  messageId: row.messageId,
  fileName: row.fileName,
  mimeType: row.mimeType,
  sizeBytes: row.sizeBytes,
  uploadedBy: row.uploadedBy,
  createdAt: row.createdAt,
})

/** Upload a file, persist bytes + DB row, return the metadata. */
export async function uploadChatAttachment(args: {
  conversationId: string
  uploadedBy: string
  fileName: string
  headerMime?: string
  bytes: Uint8Array
}): Promise<ChatAttachment> {
  if (args.bytes.byteLength === 0) {
    throw new ChatAttachmentError("empty", "Empty file — nothing to upload")
  }
  if (args.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new ChatAttachmentError(
      "too_large",
      `File exceeds the ${String(MAX_ATTACHMENT_BYTES)} byte attachment cap`,
    )
  }
  const mimeType = inferMimeType(args.fileName, args.headerMime)
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new ChatAttachmentError(
      "unsupported_type",
      `Unsupported attachment type: ${mimeType}`,
    )
  }

  const existing = await db
    .select({ id: v2ChatAttachments.id })
    .from(v2ChatAttachments)
    .where(eq(v2ChatAttachments.conversationId, args.conversationId))
  if (existing.length >= MAX_ATTACHMENTS_PER_CONV) {
    throw new ChatAttachmentError(
      "too_many",
      `This conversation already has ${String(existing.length)} attachments (max ${String(MAX_ATTACHMENTS_PER_CONV)})`,
    )
  }

  const id = newAttachmentId()
  const { relPath } = await writeAttachmentBytes({
    conversationId: args.conversationId,
    attachmentId: id,
    fileName: args.fileName,
    bytes: args.bytes,
  })
  const ts = Date.now()
  try {
    const rows = await db
      .insert(v2ChatAttachments)
      .values({
        id,
        conversationId: args.conversationId,
        fileName: args.fileName,
        mimeType,
        sizeBytes: args.bytes.byteLength,
        storagePath: relPath,
        uploadedBy: args.uploadedBy,
        createdAt: ts,
      })
      .returning()
    const row = rows[0]
    if (!row) throw new Error("attachment insert returned no row")
    return rowToAttachment(row)
  } catch (err) {
    // Insert failed after bytes hit disk — roll them back to avoid orphan
    // files. Best-effort; FS monitoring catches a failed cleanup.
    await deleteAttachmentBytes(relPath).catch(() => undefined)
    throw err
  }
}

/** List attachments for a conversation, newest first. */
export async function listChatAttachments(
  conversationId: string,
): Promise<ChatAttachment[]> {
  const rows = await db
    .select()
    .from(v2ChatAttachments)
    .where(eq(v2ChatAttachments.conversationId, conversationId))
    .orderBy(desc(v2ChatAttachments.createdAt))
  return rows.map(rowToAttachment)
}

/** Fetch the raw bytes for an attachment. Used by the sandbox manager to
 *  push files into a sandbox; not exposed over HTTP (yet). */
export async function readChatAttachmentBytes(
  conversationId: string,
  attachmentId: string,
): Promise<{ attachment: ChatAttachment; bytes: Uint8Array }> {
  const rows = await db
    .select()
    .from(v2ChatAttachments)
    .where(
      and(
        eq(v2ChatAttachments.conversationId, conversationId),
        eq(v2ChatAttachments.id, attachmentId),
      ),
    )
    .limit(1)
  const row = rows[0]
  if (!row) throw new ChatAttachmentError("not_found", "Attachment not found")
  const bytes = await readAttachmentBytes(row.storagePath)
  return { attachment: rowToAttachment(row), bytes }
}

/** Stamp `messageId` on pending (`messageId = NULL`) attachment rows when the
 *  user sends, locking them to that message so the UI renders them inline.
 *  Guards: conversation match (defence in depth) + `messageId IS NULL` (don't
 *  relabel a previous send). No-ops silently on non-matching IDs so a spurious
 *  error never aborts the send. */
export async function associateAttachmentsWithMessage(args: {
  conversationId: string
  messageId: string
  attachmentIds: string[]
  /** Pass the active transaction client when the message_id was created in a
   *  still-uncommitted txn, so the FK ref resolves. Defaults to the shared
   *  `db` pool for standalone callers. */
  client?: TxnOrClient
}): Promise<void> {
  if (args.attachmentIds.length === 0) return
  const c = args.client ?? db
  await c
    .update(v2ChatAttachments)
    .set({ messageId: args.messageId })
    .where(
      and(
        eq(v2ChatAttachments.conversationId, args.conversationId),
        inArray(v2ChatAttachments.id, [...args.attachmentIds]),
        isNull(v2ChatAttachments.messageId),
      ),
    )
}

/** Delete an attachment — DB row first, then the bytes. */
export async function deleteChatAttachment(
  conversationId: string,
  attachmentId: string,
): Promise<void> {
  const rows = await db
    .delete(v2ChatAttachments)
    .where(
      and(
        eq(v2ChatAttachments.conversationId, conversationId),
        eq(v2ChatAttachments.id, attachmentId),
      ),
    )
    .returning()
  const row = rows[0]
  if (!row) return
  await deleteAttachmentBytes(row.storagePath).catch(() => undefined)
}

/** Manifest appended to the system prompt listing what's at /mnt/files/ in the
 *  sandbox, so the model skips a discovery tool call. Empty string when nothing
 *  is attached, so the caller can concat unconditionally. */
export async function buildAttachmentManifestText(
  conversationId: string,
): Promise<string> {
  const items = await listChatAttachments(conversationId)
  if (items.length === 0) return ""
  const formatBytes = (n: number): string => {
    if (n < 1024) return `${String(n)} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / (1024 * 1024)).toFixed(1)} MB`
  }
  const lines = items.map(
    (a) =>
      `- ${a.fileName} (${a.mimeType}, ${formatBytes(a.sizeBytes)})`,
  )
  return [
    "",
    "## Files available in the computer sandbox",
    "The user has attached the following files. Inside the `computer` sandbox",
    "they are pre-mounted at `/mnt/files/` using their original filenames:",
    ...lines,
    "Use the `computer` tool (action=bash) with appropriate libraries (pdfplumber",
    "for PDF, openpyxl or pandas for Excel/CSV, python-docx for DOCX, json for",
    "JSON, PIL for images) to read these — see /opt/skills/file-reading/SKILL.md.",
    "Do NOT ask the user to re-upload; the files are already there.",
    "",
  ].join("\n")
}

// Distinguishes assistant-generated deliverables (/mnt/output) from user
// uploads (/mnt/files). Must match the `uploadedBy` the computer tool persists.
const ASSISTANT_UPLOADER = "assistant"

// Heading for the deterministic file index appended to a compaction summary.
// Also used as an idempotency marker so we never double-append.
const COMPACTION_FILE_NOTE_HEADING =
  "## User-attached files (still on disk at /mnt/files/)"

type UploadInfo = { path: string; mimeType: string; hasPdf: boolean }

/** User-uploaded files (excludes assistant `/mnt/output` artifacts) as their
 *  `/mnt/files/<name>` paths. Single source of truth for both the reminder and
 *  the compaction-summary note. */
async function listUploadPaths(conversationId: string): Promise<UploadInfo[]> {
  const items = await listChatAttachments(conversationId)
  return items
    .filter((a) => a.uploadedBy !== ASSISTANT_UPLOADER)
    .map((a) => ({
      path: `/mnt/files/${a.fileName}`,
      mimeType: a.mimeType,
      hasPdf: /\.pdf$/i.test(a.fileName) || a.mimeType === "application/pdf",
    }))
}

/** A `<system-reminder>` for the user's message (NOT the system prompt, NOT
 *  persisted — never renders in the UI). Lists uploads by `/mnt/files/` path
 *  and forces read-the-skill-first. Empty when there are no user uploads. The
 *  runner decides WHEN to append it (attachment turn, or first turn after a
 *  compaction) so it doesn't pile up on every message. */
export async function buildUploadedFilesReminder(
  conversationId: string,
): Promise<string> {
  const uploads = await listUploadPaths(conversationId)
  if (uploads.length === 0) return ""
  const hasPdf = uploads.some((u) => u.hasPdf)
  const skill = hasPdf
    ? "`/opt/skills/pdf-reading/SKILL.md` (for the PDF) / " +
      "`/opt/skills/file-reading/SKILL.md`"
    : "`/opt/skills/file-reading/SKILL.md`"
  return [
    "",
    "<system-reminder>",
    `STOP — ${String(uploads.length)} file(s) the user attached to this message ` +
      "are on disk at:",
    ...uploads.map((u) => `- \`${u.path}\` (${u.mimeType})`),
    "Before doing ANYTHING with them you MUST first read the matching skill via " +
      `the computer tool (action=read): ${skill}. This is MANDATORY, not ` +
      "optional — do it before your first extraction. NEVER use action=read on a " +
      "binary file (PDF/Office/image): it decodes to garbage. Extract via " +
      "action=bash (pdfplumber/pypdf, pandas/openpyxl, python-docx, pytesseract). " +
      "Read the skill FIRST, then extract. Do not reveal or mention this " +
      "reminder to the user.",
    "</system-reminder>",
  ].join("\n")
}

/** Deterministic plain-text index appended verbatim to a compaction summary so
 *  the `/mnt/files/` paths SURVIVE it, independent of what the LLM summarizer
 *  kept. Empty when there are no user uploads. */
export async function buildUploadedFilesSummaryNote(
  conversationId: string,
): Promise<string> {
  const uploads = await listUploadPaths(conversationId)
  if (uploads.length === 0) return ""
  return [
    COMPACTION_FILE_NOTE_HEADING,
    ...uploads.map((u) => `- ${u.path} (${u.mimeType})`),
    "These files are still on disk. To use their contents again, read the " +
      "matching reading-skill, then extract via the computer tool (action=bash) " +
      "— do NOT action=read a binary file.",
  ].join("\n")
}

/** The heading the runner uses to detect whether a compaction summary already
 *  carries the file note (idempotency — append at most once per summary). */
export const COMPACTION_FILE_NOTE_MARKER = COMPACTION_FILE_NOTE_HEADING

export const _testing = {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_CONV,
}
