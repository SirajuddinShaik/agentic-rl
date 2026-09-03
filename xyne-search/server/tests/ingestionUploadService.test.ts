import { beforeEach, describe, expect, mock, test } from "bun:test"

import { IngestionUploadError } from "@/ingestion/domain/errors"
import { MAX_KB_UPLOAD_FILE_SIZE_BYTES } from "@/ingestion/domain/types"

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation"

type CreateItemInput = {
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

const calls: {
  parentChecks: Array<{ collectionId: string; parentId: string | null }>
  writes: Array<{
    workspaceExternalId: string
    collectionId: string
    storageKey: string
    fileName: string
    buffer: Buffer
  }>
  removes: string[]
  creates: CreateItemInput[]
  doclingQueues: Array<{
    item: Record<string, unknown>
    collectionName: string
    mimeType: string
  }>
  standardQueues: string[]
  loggedErrors: unknown[]
} = {
  parentChecks: [],
  writes: [],
  removes: [],
  creates: [],
  doclingQueues: [],
  standardQueues: [],
  loggedErrors: [],
}

let parentCheckError: unknown = null
let storagePath = "/tmp/uploaded-file"
let createItemError: unknown = null
let queueError: unknown = null

mock.module("@/ingestion/storage/paths", () => ({
  sanitizeFileName: (name: string) => name.replace(/\s+/g, "_"),
}))

mock.module("@/ingestion/repositories/kbUploadRepository", () => ({
  assertValidUploadParent: async (
    collectionId: string,
    parentId: string | null,
  ) => {
    calls.parentChecks.push({ collectionId, parentId })
    if (parentCheckError) {
      throw parentCheckError
    }
  },
  createUploadIdentifiers: () => ({
    storageKey: "storage-key",
    vespaDocId: "vespa-doc-id",
  }),
  createUploadedFileItem: async (input: CreateItemInput) => {
    calls.creates.push(input)
    if (createItemError) {
      throw createItemError
    }
    return {
      id: "item-1",
      vespaDocId: input.vespaDocId,
      collectionId: input.collectionId,
      parentId: input.parentId,
      name: input.name,
      originalName: input.name,
      storagePath: input.storagePath,
      path: "/",
      mimeType: input.mimeType,
      fileSize: input.fileSize,
      uploadedByEmail: input.uploadedByEmail,
      metadata: {},
    }
  },
}))

mock.module("@/ingestion/storage/uploadStorage", () => ({
  writeUploadedBytes: async (input: (typeof calls)["writes"][number]) => {
    calls.writes.push(input)
    return storagePath
  },
  removeUploadedBytes: async (path: string) => {
    calls.removes.push(path)
  },
}))

mock.module("@/ingestion/queue/producer", () => ({
  queuePdfForDocling: async (
    input: (typeof calls)["doclingQueues"][number],
  ) => {
    calls.doclingQueues.push(input)
    if (queueError) {
      throw queueError
    }
    return {
      schedulerFile: { fileId: input.item.id },
      sourceKind: "ingestion",
      basePriority: 0,
    }
  },
  queueStandardFileProcessing: async (fileId: string) => {
    calls.standardQueues.push(fileId)
    if (queueError) {
      throw queueError
    }
  },
}))

mock.module("@/platform/logger", () => ({
  getLogger: () => ({
    child() {
      return this
    },
    error(...args: unknown[]) {
      calls.loggedErrors.push(args)
    },
    info() {},
    warn() {},
    debug() {},
  }),
}))

const { admitUploadedKbFile, requiresOCR } = await import(
  "@/ingestion/services/admissionService"
)
const { uploadKbFiles } = await import("@/ingestion/services/uploadService")

const makeFile = (
  name: string,
  content: string | Uint8Array,
  opts: { type?: string; size?: number } = {},
): File =>
  ({
    name,
    type: opts.type ?? "text/plain",
    size:
      opts.size ??
      (typeof content === "string"
        ? Buffer.byteLength(content)
        : content.byteLength),
    arrayBuffer: async () => {
      const bytes =
        typeof content === "string" ? new TextEncoder().encode(content) : content
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      )
    },
  }) as unknown as File

const sniffableZipBytes = () =>
  new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0])

const sniffablePdfBytes = () => new TextEncoder().encode("%PDF-1.7\n% test\n")

const admissionItem = {
  id: "file-1",
  vespaDocId: "vespa-doc-id",
  collectionId: "collection-1",
  parentId: null,
  name: "file",
  originalName: "file",
  storagePath: "/tmp/file",
  path: "/",
  mimeType: "application/pdf",
  fileSize: 42,
  uploadedByEmail: "owner@example.com",
  metadata: {},
}

const baseInput = (files: File[]) => ({
  actor: {
    id: 7,
    email: "owner@example.com",
    workspaceId: 11,
    workspaceExternalId: "workspace-ext",
  },
  collection: {
    id: "collection-1",
    name: "Collection One",
  },
  parentId: "folder-1",
  files,
})

beforeEach(() => {
  calls.parentChecks = []
  calls.writes = []
  calls.removes = []
  calls.creates = []
  calls.doclingQueues = []
  calls.standardQueues = []
  calls.loggedErrors = []
  parentCheckError = null
  storagePath = "/tmp/uploaded-file"
  createItemError = null
  queueError = null
})

describe("uploadKbFiles", () => {
  test("throws a typed error for invalid parent before processing files", async () => {
    parentCheckError = new IngestionUploadError(
      "INVALID_PARENT",
      "Invalid parentId",
      400,
    )

    await expect(uploadKbFiles(baseInput([makeFile("a.txt", "hello")]))).rejects.toThrow(
      "Invalid parentId",
    )
    expect(calls.parentChecks).toEqual([
      { collectionId: "collection-1", parentId: "folder-1" },
    ])
    expect(calls.writes).toHaveLength(0)
    expect(calls.creates).toHaveLength(0)
    expect(calls.doclingQueues).toHaveLength(0)
    expect(calls.standardQueues).toHaveLength(0)
  })

  test("returns a per-file failure for files above the upload size limit", async () => {
    const result = await uploadKbFiles(
      baseInput([
        makeFile("large file.txt", "", {
          size: MAX_KB_UPLOAD_FILE_SIZE_BYTES + 1,
        }),
      ]),
    )

    expect(result.summary).toEqual({ total: 1, successful: 0, failed: 1 })
    expect(result.results[0]).toEqual({
      success: false,
      name: "large_file.txt",
      error: "File too large (max 100 MB)",
    })
    expect(calls.writes).toHaveLength(0)
    expect(calls.creates).toHaveLength(0)
    expect(calls.doclingQueues).toHaveLength(0)
    expect(calls.standardQueues).toHaveLength(0)
  })

  test("writes storage, creates the DB item, and admits processing", async () => {
    const result = await uploadKbFiles(baseInput([makeFile("note.txt", "hello")]))

    expect(result.summary).toEqual({ total: 1, successful: 1, failed: 0 })
    expect(result.results[0]).toEqual({
      success: true,
      itemId: "item-1",
      name: "note.txt",
    })
    expect(calls.writes[0]).toMatchObject({
      workspaceExternalId: "workspace-ext",
      collectionId: "collection-1",
      storageKey: "storage-key",
      fileName: "note.txt",
    })
    expect(calls.creates[0]).toMatchObject({
      collectionId: "collection-1",
      parentId: "folder-1",
      name: "note.txt",
      vespaDocId: "vespa-doc-id",
      storagePath,
      storageKey: "storage-key",
      mimeType: "text/plain",
      fileSize: 5,
      uploadedById: 7,
      uploadedByEmail: "owner@example.com",
    })
    expect(calls.doclingQueues).toHaveLength(0)
    expect(calls.standardQueues).toEqual(["item-1"])
    expect(calls.removes).toHaveLength(0)
  })

  test("uses docx extension before sniffed zip MIME and routes to OCR", async () => {
    const result = await uploadKbFiles(
      baseInput([
        makeFile("report.docx", sniffableZipBytes(), {
          type: "application/octet-stream",
        }),
      ]),
    )

    expect(result.summary).toEqual({ total: 1, successful: 1, failed: 0 })
    expect(calls.creates[0]).toMatchObject({
      name: "report.docx",
      mimeType: DOCX_MIME,
    })
    expect(calls.doclingQueues).toHaveLength(1)
    expect(calls.doclingQueues[0]?.mimeType).toBe(DOCX_MIME)
    expect(calls.standardQueues).toHaveLength(0)
  })

  test("uses pptx extension before sniffed zip MIME and routes to OCR", async () => {
    const result = await uploadKbFiles(
      baseInput([
        makeFile("slides.pptx", sniffableZipBytes(), {
          type: "application/octet-stream",
        }),
      ]),
    )

    expect(result.summary).toEqual({ total: 1, successful: 1, failed: 0 })
    expect(calls.creates[0]).toMatchObject({
      name: "slides.pptx",
      mimeType: PPTX_MIME,
    })
    expect(calls.doclingQueues).toHaveLength(1)
    expect(calls.doclingQueues[0]?.mimeType).toBe(PPTX_MIME)
    expect(calls.standardQueues).toHaveLength(0)
  })

  test("routes txt and markdown uploads outside Docling so OCR permits cannot leak", async () => {
    const result = await uploadKbFiles(
      baseInput([
        makeFile("note.txt", "hello text", {
          type: "application/octet-stream",
        }),
        makeFile("guide.md", "# Guide\n\nhello markdown", {
          type: "application/octet-stream",
        }),
      ]),
    )

    expect(result.summary).toEqual({ total: 2, successful: 2, failed: 0 })
    expect(calls.creates.map((input) => input.mimeType)).toEqual([
      "text/plain",
      "text/markdown",
    ])
    expect(calls.doclingQueues).toHaveLength(0)
    expect(calls.standardQueues).toEqual(["item-1", "item-1"])
  })

  test("does not let a txt extension hide sniffed OCR-required content", async () => {
    const result = await uploadKbFiles(
      baseInput([
        makeFile("renamed.txt", sniffablePdfBytes(), {
          type: "application/octet-stream",
        }),
      ]),
    )

    expect(result.summary).toEqual({ total: 1, successful: 1, failed: 0 })
    expect(calls.creates[0]).toMatchObject({
      name: "renamed.txt",
      mimeType: "application/pdf",
    })
    expect(calls.doclingQueues).toHaveLength(1)
    expect(calls.doclingQueues[0]?.mimeType).toBe("application/pdf")
    expect(calls.standardQueues).toHaveLength(0)
  })

  test("preserves upload success when admission enqueue fails after DB creation", async () => {
    queueError = new Error("queue down")

    const result = await uploadKbFiles(baseInput([makeFile("note.txt", "hello")]))

    expect(result.summary).toEqual({ total: 1, successful: 1, failed: 0 })
    expect(result.results[0]).toEqual({
      success: true,
      itemId: "item-1",
      name: "note.txt",
    })
    expect(calls.creates).toHaveLength(1)
    expect(calls.standardQueues).toEqual(["item-1"])
    expect(calls.loggedErrors).toHaveLength(1)
    expect(calls.removes).toHaveLength(0)
  })

  test("removes stored bytes when DB item creation fails", async () => {
    createItemError = new Error("db unavailable")
    storagePath = "/tmp/created-before-db-failure"

    const result = await uploadKbFiles(baseInput([makeFile("note.txt", "hello")]))

    expect(result.summary).toEqual({ total: 1, successful: 0, failed: 1 })
    expect(result.results[0]).toEqual({
      success: false,
      name: "note.txt",
      error: "db unavailable",
    })
    expect(calls.writes).toHaveLength(1)
    expect(calls.creates).toHaveLength(1)
    expect(calls.doclingQueues).toHaveLength(0)
    expect(calls.standardQueues).toHaveLength(0)
    expect(calls.removes).toEqual(["/tmp/created-before-db-failure"])
  })
})

describe("admitUploadedKbFile", () => {
  test("marks text and markdown as non-OCR files", () => {
    expect(requiresOCR("text/plain")).toBe(false)
    expect(requiresOCR("text/plain; charset=utf-8")).toBe(false)
    expect(requiresOCR("text/markdown")).toBe(false)
  })

  test("marks PDF and Office documents as OCR files", () => {
    expect(requiresOCR("application/pdf")).toBe(true)
    expect(requiresOCR("application/msword")).toBe(true)
    expect(
      requiresOCR(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe(true)
    expect(requiresOCR("application/vnd.ms-powerpoint")).toBe(true)
    expect(
      requiresOCR(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ),
    ).toBe(true)
  })

  test("routes txt and markdown uploads to standard processing", async () => {
    for (const { fileId, mimeType } of [
      { fileId: "file-txt", mimeType: "text/plain" },
      { fileId: "file-md", mimeType: "text/markdown" },
    ]) {
      await admitUploadedKbFile({
        item: { ...admissionItem, id: fileId } as never,
        collectionName: "Collection",
        mimeType,
      })
    }

    expect(calls.doclingQueues).toHaveLength(0)
    expect(calls.standardQueues).toEqual(["file-txt", "file-md"])
  })

  test("routes OCR-required uploads to the Docling scheduler", async () => {
    await admitUploadedKbFile({
      item: { ...admissionItem, id: "file-pdf" } as never,
      collectionName: "Collection",
      mimeType: "application/pdf",
    })

    expect(calls.standardQueues).toHaveLength(0)
    expect(calls.doclingQueues).toHaveLength(1)
    expect(calls.doclingQueues[0]).toMatchObject({
      collectionName: "Collection",
      mimeType: "application/pdf",
    })
  })
})
