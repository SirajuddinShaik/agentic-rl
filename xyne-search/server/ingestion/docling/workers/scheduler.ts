import { randomUUID } from "node:crypto"
import { access, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import config, { NAMESPACE } from "@/config"
import { db } from "@/platform/db/client"
import { updateParentStatus } from "@/platform/db/knowledgeBase"
import {
  type DoclingAsyncPart,
  collectionItems,
  collections,
} from "@/platform/db/schema"
import { getBaseMimeType, isTextFile } from "@/integrations/dataSource/config"
import {
  processTextPageContent,
  virtualTextPages,
} from "@/ingestion/chunking/textChunks"
import { buildVespaFileName } from "@/ingestion/indexing/kbDocumentBuilder"
import {
  type DoclingResponse,
  processingResultFromDoclingResponse,
} from "@/platform/lib/chunkByDocling"
import { submitDoclingAsyncJob } from "@/ingestion/docling/runtime/client"
import { getDoclingRuntimeConfig } from "@/ingestion/docling/runtime/config"
import { createConcurrencyGate } from "@/ingestion/docling/workers/concurrencyGate"
import {
  type DoclingSchedulerPermit,
  listActiveDoclingSchedulerPermitIds,
  releaseDoclingOcrSubmitPermit,
  releaseDoclingSchedulerPermit,
  tryAcquireDoclingSchedulerPermit,
  tryAcquireDoclingSchedulerWeightedPermit,
} from "@/ingestion/docling/scheduler/permits"
import {
  cleanupDoclingSchedulerStageDir,
  getDoclingSchedulerResultPath,
  getDoclingSchedulerResultsDir,
  getDoclingSchedulerStorageRoot,
  readDoclingSchedulerJson,
  resolveDoclingSchedulerSourcePath,
  writeDoclingSchedulerJson,
} from "@/ingestion/docling/scheduler/storage"
import { repairKbMetadataSyncBatch } from "@/ingestion/indexing/kbMetadataSync"
import {
  DOCLING_FILE_STATUS,
  DOCLING_PART_STATUS,
  admitDoclingOcrFiles,
  claimDoclingPartsForSubmitBatch,
  claimNextDoclingFileToSplit,
  claimNextDoclingFileToWrite,
  failDoclingFile,
  failDoclingFileIfOwned,
  getDoclingFile,
  getDoclingPartByJobId,
  getDoclingPartsForFile,
  listDeletedActiveDoclingFileIds,
  listExpiredSubmittingDoclingParts,
  listLiveDoclingCurrentJobIds,
  listLiveDoclingSubmitPermitIds,
  listTimedOutSubmittedDoclingParts,
  markDoclingFileCompleted,
  markDoclingFileSplitComplete,
  markDoclingFileSplitRetry,
  markDoclingFileWriteRetry,
  markDoclingPartReady,
  markDoclingPartSubmitRetry,
  markDoclingPartSubmitted,
  releaseClaimedDoclingPartForSubmitCapacity,
  requeueExpiredDoclingLeases,
} from "@/ingestion/docling/scheduler/store"
import {
  PDF_PROCESSING_METHOD,
  type DoclingStagedPart,
  type DoclingStagedParts,
  type ProcessingResult as PdfProcessingResult,
  PdfProcessor,
} from "@/platform/common/pdf/pdfProcessor"
import { getRedisClient } from "@/platform/lib/redisClient"
import { getLogger } from "@/platform/logger"
import { type ChunkMetadata, Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"
import { Apps, KbItemsSchema, KnowledgeBaseEntity } from "@xyne/vespa-ts/types"
import { eq } from "drizzle-orm"

const Logger = getLogger(Subsystem.Queue).child({
  module: "doclingSchedulerWorkers",
})

type RedisStreamEntry = {
  id: string
  fields: Record<string, string>
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const retryDelay = (attempt: number) =>
  Math.min(
    config.doclingSchedulerRetryMaxMs,
    config.doclingSchedulerRetryBaseMs * Math.max(attempt, 1),
  )

const OFFICE_OCR_MIME_TYPES = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
])

const isOfficeDocument = (mimeType: string) =>
  OFFICE_OCR_MIME_TYPES.has(getBaseMimeType(mimeType))

const findSoffice = async (): Promise<string | null> => {
  const candidates = [
    "soffice",
    "libreoffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    os.homedir() + "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/usr/bin/soffice",
    "/usr/bin/libreoffice",
  ]
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      if (existsSync(candidate)) return candidate
      continue
    }
    const proc = Bun.spawn(["which", candidate], {
      stdout: "pipe",
      stderr: "pipe",
    })
    if ((await proc.exited) === 0) {
      const resolved = (await new Response(proc.stdout).text()).trim()
      return resolved || candidate
    }
  }
  return null
}

const OFFICE_CONVERT_TIMEOUT_MS = 120000
const officeConversionGate = createConcurrencyGate(
  config.doclingOfficeConversionConcurrency,
)

const cleanupOfficeTempDir = async (dir: string, message: string) => {
  await rm(dir, { recursive: true, force: true }).catch((err) => {
    Logger.warn({ dir, error: getErrorMessage(err) }, message)
  })
}

const convertOfficeToPdf = async (
  sourcePath: string,
  fileName: string,
): Promise<string> => {
  const soffice = await findSoffice()
  if (!soffice) {
    throw new TerminalDoclingSchedulerError(
      `LibreOffice (soffice) not found - cannot convert ${fileName} to PDF. Install libreoffice-writer and libreoffice-impress.`,
    )
  }

  const tmpDir = path.join(os.tmpdir(), `xyne-office-${randomUUID()}`)
  const profileDir = path.join(
    os.tmpdir(),
    `xyne-office-profile-${randomUUID()}`,
  )
  let keepOutputDir = false

  try {
    await mkdir(tmpDir, { recursive: true })
    await mkdir(profileDir, { recursive: true })

    const userInstallation = pathToFileURL(profileDir).href
    const cmd = [
      soffice,
      `-env:UserInstallation=${userInstallation}`,
      "--headless",
      "--nologo",
      "--nodefault",
      "--nofirststartwizard",
      "--convert-to",
      "pdf",
      "--outdir",
      tmpDir,
      sourcePath,
    ]

    Logger.info(
      {
        sourcePath,
        fileName,
        tmpDir,
        profileDir,
        userInstallation,
        cmd: cmd.join(" "),
      },
      "Converting Office document to PDF via LibreOffice",
    )

    const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill("SIGKILL")
    }, OFFICE_CONVERT_TIMEOUT_MS)

    try {
      const exitCode = await proc.exited
      if (timedOut) {
        throw new Error(
          `LibreOffice conversion timed out after ${OFFICE_CONVERT_TIMEOUT_MS}ms`,
        )
      }
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text().catch(() => "")
        throw new Error(
          `LibreOffice exited with code ${exitCode}: ${stderr.slice(0, 500)}`,
        )
      }
    } catch (error) {
      if (timedOut) {
        throw new Error(
          `LibreOffice conversion timed out after ${OFFICE_CONVERT_TIMEOUT_MS}ms`,
        )
      }
      throw error
    } finally {
      clearTimeout(timer)
    }

    const outputFiles = await readdir(tmpDir)
    const outputPdf = outputFiles.find(
      (name) => path.extname(name).toLowerCase() === ".pdf",
    )
    const pdfPath = outputPdf ? path.join(tmpDir, outputPdf) : ""
    if (!existsSync(pdfPath)) {
      throw new Error(
        `LibreOffice conversion produced no PDF output for ${fileName}`,
      )
    }

    Logger.info(
      { sourcePath, pdfPath, fileName, profileDir },
      "Office document converted to PDF",
    )

    keepOutputDir = true
    return pdfPath
  } finally {
    await cleanupOfficeTempDir(
      profileDir,
      "Failed to clean up temporary LibreOffice profile directory",
    )
    if (!keepOutputDir) {
      await cleanupOfficeTempDir(
        tmpDir,
        "Failed to clean up failed LibreOffice conversion directory",
      )
    }
  }
}

const stageTextFileParts = async (options: {
  fileId: string
  sourcePath: string
  fileName: string
  vespaDocId: string
  stageRootPath: string
}): Promise<DoclingStagedParts> => {
  const sourceStats = await stat(options.sourcePath).catch(() => null)
  const { readFile } = await import("node:fs/promises")
  const content = await readFile(options.sourcePath, "utf-8")
  const pages = virtualTextPages(content)
  const totalPages = pages.length || 1
  const effectivePages = pages.length ? pages : [content.trim() || content]

  const stageDir = path.join(
    options.stageRootPath,
    options.fileId,
    randomUUID(),
  )
  const partsDir = path.join(stageDir, "parts")
  const manifestPath = path.join(stageDir, "manifest.json")
  await mkdir(partsDir, { recursive: true })

  const parts: DoclingStagedPart[] = []
  for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
    const pageText = effectivePages[pageIndex] ?? ""
    const partFileStem = String(pageIndex).padStart(5, "0")
    const partPath = path.join(partsDir, `${partFileStem}.txt`)
    await writeFile(partPath, pageText)
    parts.push({
      partIndex: pageIndex,
      startPage: pageIndex,
      endPage: pageIndex + 1,
      totalPages,
      partDocId: `${options.vespaDocId}__docling_part_${pageIndex}`,
      partFileName: `${options.fileName}.page-${pageIndex + 1}.txt`,
      partPath,
      partSizeBytes: Buffer.byteLength(pageText, "utf-8"),
    })
  }

  const stagedParts: DoclingStagedParts = {
    fileId: options.fileId,
    vespaDocId: options.vespaDocId,
    sourcePath: options.sourcePath,
    sourceSize: sourceStats?.size ?? Buffer.byteLength(content, "utf-8"),
    sourceMtimeMs: sourceStats?.mtimeMs ?? null,
    fileName: options.fileName,
    totalPages,
    pageChunkSize: 1,
    partsTotal: parts.length,
    stageDir,
    partsDir,
    manifestPath,
    parts,
  }

  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        fileId: stagedParts.fileId,
        vespaDocId: stagedParts.vespaDocId,
        sourcePath: stagedParts.sourcePath,
        sourceSize: stagedParts.sourceSize,
        sourceMtimeMs: stagedParts.sourceMtimeMs,
        fileName: stagedParts.fileName,
        totalPages: stagedParts.totalPages,
        pageChunkSize: stagedParts.pageChunkSize,
        partsTotal: stagedParts.partsTotal,
        stageDir: stagedParts.stageDir,
        partsDir: stagedParts.partsDir,
        parts: stagedParts.parts.map((part) => ({
          partIndex: part.partIndex,
          startPage: part.startPage,
          endPage: part.endPage,
          totalPages: part.totalPages,
          partDocId: part.partDocId,
          partFileName: part.partFileName,
          partPath: part.partPath,
          partSizeBytes: part.partSizeBytes,
        })),
      },
      null,
      2,
    )}\n`,
  )

  Logger.info(
    {
      fileId: options.fileId,
      fileName: options.fileName,
      vespaDocId: options.vespaDocId,
      totalPages,
      partsTotal: parts.length,
      stageDir,
    },
    "Text file virtual page staging completed",
  )

  return stagedParts
}

const processTextPartLocally = async (options: {
  partPath: string
  partIndex: number
  startPage: number
  resultPath: string
  fileName: string
}): Promise<void> => {
  const { readFile } = await import("node:fs/promises")
  const text = await readFile(options.partPath, "utf-8")
  const textResult = processTextPageContent(text, 0)

  const result: PdfProcessingResult = {
    chunks: textResult.chunks,
    chunks_pos: textResult.chunks_pos,
    image_chunks: [],
    image_chunks_pos: [],
    toc_chunks: [],
    chunks_map: textResult.chunks_map,
    image_chunks_map: [],
    processingMethod: PDF_PROCESSING_METHOD.PDFJS,
  }

  await writeDoclingSchedulerJson(options.resultPath, result)
}

class TerminalDoclingSchedulerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TerminalDoclingSchedulerError"
  }
}

const isTerminalDoclingSchedulerError = (
  error: unknown,
): error is TerminalDoclingSchedulerError =>
  error instanceof TerminalDoclingSchedulerError ||
  (error instanceof Error && error.name === "TerminalDoclingSchedulerError")

const isMissingSourceFileError = (message: string) =>
  message.includes("No such file or directory") || message.includes("ENOENT")

const submittedPartTimeoutMs = () => config.doclingSchedulerSubmittedTimeoutMs

const workerId = (role: string) =>
  `${role}:${process.env.HOSTNAME || "local"}:${process.pid}:${randomUUID()}`

const wrapperGlobalActiveKey =
  process.env.DOCLING_WRAPPER_GLOBAL_ACTIVE_KEY || "docling:async:global:active"

type WorkerPoolControl = {
  stopRequested: boolean
  promise: Promise<void>
}

const startDynamicRolePool = async (input: {
  role: string
  getDesiredConcurrency: () => number
  runWorker: (workerName: string, shouldStop: () => boolean) => Promise<void>
  shouldStop?: () => boolean
}) => {
  const workers = new Map<string, WorkerPoolControl>()
  let nextIndex = 0

  const activeWorkers = () =>
    Array.from(workers.values()).filter((worker) => !worker.stopRequested)

  const launchWorker = () => {
    const workerName = workerId(`${input.role}-${nextIndex}`)
    nextIndex += 1

    const control: WorkerPoolControl = {
      stopRequested: false,
      promise: Promise.resolve(),
    }
    workers.set(workerName, control)
    control.promise = input
      .runWorker(workerName, () => control.stopRequested)
      .catch((error) => {
        Logger.error(
          {
            role: input.role,
            workerName,
            error: getErrorMessage(error),
          },
          "Dynamic Docling worker exited unexpectedly",
        )
      })
      .finally(() => {
        workers.delete(workerName)
      })
  }

  while (true) {
    if (input.shouldStop?.()) {
      for (const worker of workers.values()) {
        worker.stopRequested = true
      }
      await Promise.allSettled(
        Array.from(workers.values()).map((worker) => worker.promise),
      )
      return
    }

    const desiredConcurrency = Math.max(input.getDesiredConcurrency(), 1)

    while (activeWorkers().length < desiredConcurrency) {
      launchWorker()
    }

    if (activeWorkers().length > desiredConcurrency) {
      for (const worker of workers.values()) {
        if (activeWorkers().length <= desiredConcurrency) {
          break
        }
        if (!worker.stopRequested) {
          worker.stopRequested = true
        }
      }
    }

    await sleep(config.doclingSchedulerPollMs)
  }
}

type ClaimedSubmitWork = {
  part: DoclingAsyncPart
  requestPermit: DoclingSchedulerPermit
  claimedAt: number
  pagePermitAcquiredAt: number
}

class AsyncWorkQueue<T> {
  private items: T[] = []
  private waiters: Array<(value: T | null) => void> = []

  size() {
    return this.items.length
  }

  push(item: T) {
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter(item)
      return
    }
    this.items.push(item)
  }

  pushFront(item: T) {
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter(item)
      return
    }
    this.items.unshift(item)
  }

  popNewest() {
    return this.items.pop() || null
  }

  async take(timeoutMs: number) {
    const existing = this.items.shift()
    if (existing) {
      return existing
    }

    return await new Promise<T | null>((resolve) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) {
          this.waiters.splice(index, 1)
        }
        resolve(null)
      }, timeoutMs)

      const waiter = (value: T | null) => {
        clearTimeout(timer)
        resolve(value)
      }

      this.waiters.push(waiter)
    })
  }
}

type SubmitterTimingBucket = {
  count: number
  totalMs: number
  maxMs: number
}

const createTimingBucket = (): SubmitterTimingBucket => ({
  count: 0,
  totalMs: 0,
  maxMs: 0,
})

class SubmitterTelemetry {
  private lastInfoLogAt = 0
  private loops = 0
  private emptyClaims = 0
  private claimedParts = 0
  private claimedPages = 0
  private releasedUnusedPermits = 0
  private queueTrimmed = 0
  private timings = {
    admitMs: createTimingBucket(),
    requestPermitAcquireMs: createTimingBucket(),
    claimMs: createTimingBucket(),
    pagePermitAcquireMs: createTimingBucket(),
    queueWaitMs: createTimingBucket(),
    readPartMs: createTimingBucket(),
    submitMs: createTimingBucket(),
    markSubmittedMs: createTimingBucket(),
    totalProcessMs: createTimingBucket(),
  }

  recordTiming(name: keyof SubmitterTelemetry["timings"], valueMs: number) {
    const bucket = this.timings[name]
    bucket.count += 1
    bucket.totalMs += valueMs
    bucket.maxMs = Math.max(bucket.maxMs, valueMs)
  }

  recordClaimed(parts: DoclingAsyncPart[]) {
    this.claimedParts += parts.length
    this.claimedPages += parts.reduce((sum, part) => sum + part.pageCount, 0)
  }

  recordUnusedPermits(count: number) {
    this.releasedUnusedPermits += Math.max(count, 0)
  }

  recordEmptyClaim() {
    this.emptyClaims += 1
  }

  recordQueueTrimmed(count: number) {
    this.queueTrimmed += Math.max(count, 0)
  }

  recordLoop() {
    this.loops += 1
  }

  maybeLogSnapshot(input: {
    supervisorId: string
    desiredInnerConcurrency: number
    activeProcessing: number
    queueLength: number
    localCapacity: number
  }) {
    const now = Date.now()
    if (now - this.lastInfoLogAt < 10_000) {
      return
    }
    this.lastInfoLogAt = now

    const avg = (bucket: SubmitterTimingBucket) =>
      bucket.count > 0 ? Math.round(bucket.totalMs / bucket.count) : 0

    Logger.info(
      {
        role: "submitter",
        workerId: input.supervisorId,
        runtimeVersion: getDoclingRuntimeConfig().version,
        desiredInnerConcurrency: input.desiredInnerConcurrency,
        activeProcessing: input.activeProcessing,
        queueLength: input.queueLength,
        localCapacity: input.localCapacity,
        configuredClaimBatchSize: config.doclingSchedulerSubmitClaimBatchSize,
        maxConcurrentClaimers: config.doclingSchedulerMaxConcurrentClaimers,
        loops: this.loops,
        emptyClaims: this.emptyClaims,
        claimedParts: this.claimedParts,
        claimedPages: this.claimedPages,
        releasedUnusedPermits: this.releasedUnusedPermits,
        queueTrimmed: this.queueTrimmed,
        admitMsAvg: avg(this.timings.admitMs),
        requestPermitAcquireMsAvg: avg(this.timings.requestPermitAcquireMs),
        claimMsAvg: avg(this.timings.claimMs),
        pagePermitAcquireMsAvg: avg(this.timings.pagePermitAcquireMs),
        queueWaitMsAvg: avg(this.timings.queueWaitMs),
        readPartMsAvg: avg(this.timings.readPartMs),
        submitMsAvg: avg(this.timings.submitMs),
        markSubmittedMsAvg: avg(this.timings.markSubmittedMs),
        totalProcessMsAvg: avg(this.timings.totalProcessMs),
        claimMsMax: this.timings.claimMs.maxMs,
        readPartMsMax: this.timings.readPartMs.maxMs,
        submitMsMax: this.timings.submitMs.maxMs,
      },
      "Docling submitter timing snapshot",
    )
  }
}

const timed = async <T>(fn: () => Promise<T>) => {
  const startedAt = Date.now()
  const value = await fn()
  return { value, elapsedMs: Date.now() - startedAt }
}

const parseStreamFields = (rawFields: unknown): Record<string, string> => {
  if (Array.isArray(rawFields)) {
    const fields: Record<string, string> = {}
    for (let index = 0; index < rawFields.length; index += 2) {
      const key = rawFields[index]
      const value = rawFields[index + 1]
      if (typeof key === "string") {
        fields[key] = typeof value === "string" ? value : String(value ?? "")
      }
    }
    return fields
  }

  if (rawFields && typeof rawFields === "object") {
    return Object.fromEntries(
      Object.entries(rawFields as Record<string, unknown>).map(
        ([key, value]) => [
          key,
          typeof value === "string" ? value : String(value ?? ""),
        ],
      ),
    )
  }

  return {}
}

const parseXReadResponse = (response: unknown): RedisStreamEntry[] => {
  if (!Array.isArray(response)) {
    return []
  }

  const entries: RedisStreamEntry[] = []
  for (const stream of response) {
    if (!Array.isArray(stream)) {
      continue
    }
    const messages = stream[1]
    if (!Array.isArray(messages)) {
      continue
    }
    for (const message of messages) {
      if (!Array.isArray(message) || typeof message[0] !== "string") {
        continue
      }
      entries.push({ id: message[0], fields: parseStreamFields(message[1]) })
    }
  }
  return entries
}

const parseXAutoClaimResponse = (response: unknown): RedisStreamEntry[] => {
  if (!Array.isArray(response)) {
    return []
  }
  const messages = response[1]
  if (!Array.isArray(messages)) {
    return []
  }
  return messages
    .filter(
      (message) => Array.isArray(message) && typeof message[0] === "string",
    )
    .map((message) => ({
      id: message[0] as string,
      fields: parseStreamFields(message[1]),
    }))
}

const ensureSchedulerConsumerGroup = async () => {
  const redis = await getRedisClient()
  try {
    await redis.sendCommand([
      "XGROUP",
      "CREATE",
      config.doclingResultsStream,
      config.doclingSchedulerResultGroup,
      "0",
      "MKSTREAM",
    ])
  } catch (error) {
    if (!getErrorMessage(error).includes("BUSYGROUP")) {
      throw error
    }
  }
}

const ackSchedulerMessage = async (messageId: string) => {
  const redis = await getRedisClient()
  await redis.sendCommand([
    "XACK",
    config.doclingResultsStream,
    config.doclingSchedulerResultGroup,
    messageId,
  ])
}

const offsetChunkMetadata = (
  meta: ChunkMetadata,
  chunkIndex: number,
  pageOffset: number,
): ChunkMetadata => ({
  ...meta,
  chunk_index: chunkIndex,
  page_numbers: (meta.page_numbers || []).map((page) => page + pageOffset),
  bboxes: meta.bboxes?.map((bbox) =>
    typeof bbox.page_no === "number"
      ? { ...bbox, page_no: bbox.page_no + pageOffset }
      : bbox,
  ),
})

const mapChunkMeta = (
  meta: ChunkMetadata,
  includeHeadings = false,
): Record<string, unknown> => {
  const mapped: Record<string, unknown> = {
    chunk_index: meta.chunk_index,
    page_numbers: meta.page_numbers || [],
    block_labels: meta.block_labels || [],
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    bbox_l: null,
    bbox_t: null,
    bbox_r: null,
    bbox_b: null,
    bboxes_json: null,
  }

  if (
    meta.bbox &&
    typeof meta.bbox.l === "number" &&
    typeof meta.bbox.t === "number" &&
    typeof meta.bbox.r === "number" &&
    typeof meta.bbox.b === "number"
  ) {
    mapped.bbox_l = meta.bbox.l
    mapped.bbox_t = meta.bbox.t
    mapped.bbox_r = meta.bbox.r
    mapped.bbox_b = meta.bbox.b
  }

  if (Array.isArray(meta.bboxes) && meta.bboxes.length > 0) {
    mapped.bboxes_json = JSON.stringify(meta.bboxes)
  }

  if (includeHeadings) {
    mapped.headings = meta.headings || []
  }

  return mapped
}

const mergeMetadata = (
  existingMetadata: unknown,
  updates: Record<string, unknown>,
) => ({
  ...(typeof existingMetadata === "object" && existingMetadata !== null
    ? (existingMetadata as Record<string, unknown>)
    : {}),
  ...updates,
})

type SchedulerKbFileContext = {
  fileId: string
  vespaDocId: string
  collectionId: string
  parentId: string | null
  collectionName: string
  fileName: string
  originalName: string | null
  path: string
  baseMimeType: string
  fileSize: number
  uploadedByEmail: string | null
  metadata: Record<string, unknown>
}

const getSchedulerKbFileContext = async (
  fileId: string,
): Promise<SchedulerKbFileContext> => {
  const rows = await db
    .select({
      fileId: collectionItems.id,
      type: collectionItems.type,
      vespaDocId: collectionItems.vespaDocId,
      collectionId: collectionItems.collectionId,
      parentId: collectionItems.parentId,
      collectionName: collections.name,
      fileName: collectionItems.name,
      originalName: collectionItems.originalName,
      path: collectionItems.path,
      mimeType: collectionItems.mimeType,
      fileSize: collectionItems.fileSize,
      uploadedByEmail: collectionItems.uploadedByEmail,
      metadata: collectionItems.metadata,
      deletedAt: collectionItems.deletedAt,
    })
    .from(collectionItems)
    .innerJoin(collections, eq(collectionItems.collectionId, collections.id))
    .where(eq(collectionItems.id, fileId))
    .limit(1)

  const file = rows[0]
  if (!file) {
    throw new TerminalDoclingSchedulerError(
      `Missing collection item for scheduler file ${fileId}`,
    )
  }
  if (file.type !== "file") {
    throw new TerminalDoclingSchedulerError(
      `Scheduler item is not a file: ${fileId}`,
    )
  }
  if (file.deletedAt) {
    throw new TerminalDoclingSchedulerError(
      `Collection item was deleted before Docling scheduler processing: ${fileId}`,
    )
  }
  if (!file.vespaDocId) {
    throw new TerminalDoclingSchedulerError(
      `Missing Vespa doc id for scheduler file ${fileId}`,
    )
  }

  return {
    fileId: file.fileId,
    vespaDocId: file.vespaDocId,
    collectionId: file.collectionId,
    parentId: file.parentId,
    collectionName: file.collectionName,
    fileName: file.fileName,
    originalName: file.originalName,
    path: file.path,
    baseMimeType: getBaseMimeType(file.mimeType || "application/pdf"),
    fileSize: file.fileSize || 0,
    uploadedByEmail: file.uploadedByEmail,
    metadata:
      typeof file.metadata === "object" && file.metadata !== null
        ? (file.metadata as Record<string, unknown>)
        : {},
  }
}

const aggregatePartResults = async (
  parts: Awaited<ReturnType<typeof getDoclingPartsForFile>>,
) => {
  const chunks: string[] = []
  const imageChunks: string[] = []
  const tocChunks: string[] = []
  const chunksMap: Record<string, unknown>[] = []
  const imageChunksMap: Record<string, unknown>[] = []

  for (const part of parts) {
    if (!part.resultPath) {
      throw new Error(
        `Missing result path for file=${part.fileId} part=${part.partIndex}`,
      )
    }

    const result = await readDoclingSchedulerJson<PdfProcessingResult>(
      part.resultPath,
    )
    const textOffset = chunks.length
    const imageOffset = imageChunks.length

    chunks.push(...result.chunks)
    imageChunks.push(...result.image_chunks)
    tocChunks.push(...(result.toc_chunks || []))
    chunksMap.push(
      ...(result.chunks_map || []).map((meta, index) =>
        mapChunkMeta(
          offsetChunkMetadata(meta, textOffset + index, part.startPage),
          true,
        ),
      ),
    )
    imageChunksMap.push(
      ...(result.image_chunks_map || []).map((meta, index) =>
        mapChunkMeta(
          offsetChunkMetadata(meta, imageOffset + index, part.startPage),
          false,
        ),
      ),
    )
  }

  return {
    chunks,
    chunks_pos: chunks.map((_, index) => index),
    image_chunks: imageChunks,
    image_chunks_pos: imageChunks.map((_, index) => index),
    toc_chunks: tocChunks,
    chunks_map: chunksMap,
    image_chunks_map: imageChunksMap,
  }
}

const isRetryableVespaError = (error: unknown) => {
  const message = getErrorMessage(error).toLowerCase()
  return (
    message.includes("429") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econnreset") ||
    message.includes("503") ||
    message.includes("502") ||
    message.includes("504")
  )
}

const putKbItemInVespa = async (vespaDoc: Record<string, unknown>) => {
  const docId = String(vespaDoc.docId || "")
  if (!docId) {
    throw new Error("Missing Vespa docId for scheduler write")
  }

  const url = `${config.vespaEndpoint.feedEndpoint}/document/v1/${NAMESPACE}/${KbItemsSchema}/docid/${encodeURIComponent(docId)}?timeout=${encodeURIComponent(config.vespaDocumentUpdateTimeout)}`
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(config.doclingSchedulerVespaWriteTimeoutMs),
    body: JSON.stringify({ fields: vespaDoc }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText)
    throw new Error(
      `Vespa write failed: ${response.status} ${response.statusText} ${body.slice(0, 500)}`,
    )
  }
}

const releaseOcrPermitsForFile = async (fileId: string) => {
  const parts = await getDoclingPartsForFile(fileId)
  const permitIds = new Set(
    parts
      .map((part) => part.submitPermitId)
      .filter((permitId): permitId is string => Boolean(permitId)),
  )

  for (const permitId of permitIds) {
    await releaseDoclingOcrSubmitPermit({ permitId })
  }
}

const failDoclingSchedulerFile = async (
  fileId: string,
  errorMessage: string,
) => {
  await releaseOcrPermitsForFile(fileId)
  await failDoclingFile(fileId, errorMessage)
}

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string | number => {
          return typeof item === "string" || typeof item === "number"
        })
        .map(String)
    : []

const isSchedulerDoclingJobId = (jobId: string) =>
  /^docling:[^:]+:part:\d+:attempt:[^:]+$/.test(jobId)

const reconcileSchedulerOcrSubmitPermits = async () => {
  const submitPermitIds = await listActiveDoclingSchedulerPermitIds(
    "ocr-submit",
    config.doclingSchedulerPermitReconcileBatch,
  )
  const pagePermitIds = await listActiveDoclingSchedulerPermitIds(
    "ocr-submit-pages",
    config.doclingSchedulerPermitReconcileBatch,
  )
  const permitIds = Array.from(new Set([...submitPermitIds, ...pagePermitIds]))
  if (permitIds.length === 0) {
    return 0
  }

  const livePermitIds = await listLiveDoclingSubmitPermitIds(permitIds)
  const orphanPermitIds = permitIds.filter(
    (permitId) => !livePermitIds.has(permitId),
  )

  for (const permitId of orphanPermitIds) {
    await releaseDoclingOcrSubmitPermit({ permitId })
  }

  if (orphanPermitIds.length > 0) {
    Logger.warn(
      {
        releasedPermits: orphanPermitIds.length,
      },
      "Released orphaned Docling scheduler OCR submit permits",
    )
  }

  return orphanPermitIds.length
}

const reconcileWrapperGlobalActiveKeys = async () => {
  if (!wrapperGlobalActiveKey) {
    return 0
  }

  const redis = await getRedisClient()
  await redis.sendCommand([
    "ZREMRANGEBYSCORE",
    wrapperGlobalActiveKey,
    "-inf",
    String(Date.now()),
  ])
  const jobIds = stringArray(
    await redis.sendCommand([
      "ZRANGE",
      wrapperGlobalActiveKey,
      "0",
      String(config.doclingSchedulerPermitReconcileBatch - 1),
    ]),
  )
  if (jobIds.length === 0) {
    return 0
  }

  const schedulerJobIds = jobIds.filter(isSchedulerDoclingJobId)
  if (schedulerJobIds.length === 0) {
    return 0
  }

  const liveJobIds = await listLiveDoclingCurrentJobIds(schedulerJobIds)
  const staleJobIds = schedulerJobIds.filter((jobId) => !liveJobIds.has(jobId))
  if (staleJobIds.length === 0) {
    return 0
  }

  await redis.sendCommand(["ZREM", wrapperGlobalActiveKey, ...staleJobIds])
  Logger.warn(
    {
      key: wrapperGlobalActiveKey,
      removedJobs: staleJobIds.length,
    },
    "Removed stale wrapper global admission entries not backed by scheduler DB state",
  )
  return staleJobIds.length
}

const runDoclingSchedulerSplitterWorker = async (
  id: string,
  shouldStop: () => boolean,
) => {
  while (true) {
    if (shouldStop()) {
      return
    }

    const file = await claimNextDoclingFileToSplit(
      id,
      config.doclingSchedulerLeaseMs,
    )
    if (!file) {
      await sleep(config.doclingSchedulerPollMs)
      continue
    }

    try {
      const runtimeConfig = getDoclingRuntimeConfig()
      const kbFile = await getSchedulerKbFileContext(file.fileId)
      const sourcePath = resolveDoclingSchedulerSourcePath(
        file.sourcePath,
        file.sourceStorageKey,
      )

      const isTxt = isTextFile(kbFile.baseMimeType)
      let pdfPath = sourcePath
      let convertedPdfDir: string | null = null

      if (!isTxt && isOfficeDocument(kbFile.baseMimeType)) {
        const officeGateSnapshot = officeConversionGate.snapshot()
        Logger.info(
          {
            fileId: file.fileId,
            fileName: kbFile.fileName,
            mimeType: kbFile.baseMimeType,
            activeOfficeConversions: officeGateSnapshot.active,
            queuedOfficeConversions: officeGateSnapshot.queued,
            officeConversionConcurrency: officeGateSnapshot.limit,
          },
          "Office document detected; waiting for LibreOffice conversion permit",
        )
        const convertedPdf = await officeConversionGate.run(() =>
          convertOfficeToPdf(sourcePath, kbFile.fileName),
        )
        pdfPath = convertedPdf
        convertedPdfDir = path.dirname(convertedPdf)
      }

      const stagedParts = isTxt
        ? await stageTextFileParts({
            fileId: file.fileId,
            sourcePath,
            fileName: kbFile.fileName,
            vespaDocId: kbFile.vespaDocId,
            stageRootPath: getDoclingSchedulerStorageRoot(),
          })
        : await PdfProcessor.stageDoclingPagePartsFromFile({
            fileId: file.fileId,
            sourcePath: pdfPath,
            fileName: kbFile.fileName,
            vespaDocId: kbFile.vespaDocId,
            pageChunkSize: runtimeConfig.pageChunkSize,
            stageRootPath: getDoclingSchedulerStorageRoot(),
          }).finally(async () => {
            if (convertedPdfDir) {
              await rm(convertedPdfDir, { recursive: true, force: true }).catch(
                (err) => {
                  Logger.warn(
                    { convertedPdfDir, error: getErrorMessage(err) },
                    "Failed to clean up temporary LibreOffice conversion directory",
                  )
                },
              )
            }
          })
      const committed = await markDoclingFileSplitComplete(
        file,
        stagedParts,
        getDoclingSchedulerResultsDir(
          file.fileId,
          path.basename(stagedParts.stageDir),
        ),
      )
      if (!committed) {
        Logger.warn(
          {
            fileId: file.fileId,
            leaseOwner: file.leaseOwner,
            leaseToken: file.leaseToken,
          },
          "Ignoring stale Docling split completion after lease changed",
        )
      }
    } catch (error) {
      const message = getErrorMessage(error)
      Logger.error(
        { fileId: file.fileId, error: message },
        "Docling scheduler split failed",
      )
      const nextAttempt = file.splitAttemptCount + 1
      if (
        isTerminalDoclingSchedulerError(error) ||
        isMissingSourceFileError(message) ||
        nextAttempt >= config.doclingSchedulerMaxSplitAttempts
      ) {
        await failDoclingFileIfOwned(
          file,
          DOCLING_FILE_STATUS.Splitting,
          `Docling split failed after ${nextAttempt} attempts: ${message}`,
        )
      } else {
        await markDoclingFileSplitRetry(
          file,
          message,
          new Date(Date.now() + retryDelay(nextAttempt)),
        )
      }
    }
  }
}

export const startDoclingSchedulerSplitter = async () =>
  startDynamicRolePool({
    role: "splitter",
    getDesiredConcurrency: () => getDoclingRuntimeConfig().splitterConcurrency,
    runWorker: runDoclingSchedulerSplitterWorker,
  })

type SubmitterSupervisorState = {
  supervisorId: string
  queue: AsyncWorkQueue<ClaimedSubmitWork>
  telemetry: SubmitterTelemetry
  activeProcessing: number
  reservedProcessing: number
}

const getSubmitterDesiredConcurrency = () =>
  Math.max(getDoclingRuntimeConfig().submitterConcurrencyPerContainer, 1)

const getSubmitterPrefetchCapacity = (desiredInnerConcurrency: number) =>
  Math.floor(
    desiredInnerConcurrency * config.doclingSchedulerSubmitPrefetchMultiplier,
  )

const getSubmitterLocalCapacity = (desiredInnerConcurrency: number) =>
  desiredInnerConcurrency + getSubmitterPrefetchCapacity(desiredInnerConcurrency)

const logSlowSubmitterOperation = (
  operation: "admit" | "claim" | "read_part" | "submit",
  elapsedMs: number,
  fields: Record<string, unknown>,
) => {
  const thresholdMs =
    operation === "admit"
      ? config.doclingSchedulerSlowAdmitMs
      : operation === "claim"
        ? config.doclingSchedulerSlowClaimMs
        : operation === "read_part"
          ? config.doclingSchedulerSlowReadPartMs
          : config.doclingSchedulerSlowSubmitMs

  if (elapsedMs <= thresholdMs) {
    return
  }

  Logger.warn(
    {
      ...fields,
      role: "submitter",
      operation,
      elapsedMs,
      thresholdMs,
      runtimeVersion: getDoclingRuntimeConfig().version,
    },
    "Slow Docling submitter operation",
  )
}

const releaseQueuedSubmitWork = async (
  work: ClaimedSubmitWork,
  errorMessage: string,
) => {
  await releaseDoclingOcrSubmitPermit(work.requestPermit)
  if (!work.part.currentJobId) {
    await failDoclingSchedulerFile(
      work.part.fileId,
      "Queued claimed OCR part lost current job id",
    )
    return
  }
  await releaseClaimedDoclingPartForSubmitCapacity({
    fileId: work.part.fileId,
    partIndex: work.part.partIndex,
    jobId: work.part.currentJobId,
    errorMessage,
    availableAt: new Date(Date.now() + config.doclingSchedulerPollMs),
  })
}

const trimSubmitterQueueToCapacity = async (state: SubmitterSupervisorState) => {
  const desiredInnerConcurrency = getSubmitterDesiredConcurrency()
  const localCapacity = getSubmitterLocalCapacity(desiredInnerConcurrency)
  const allowedQueueLength = Math.max(localCapacity - state.activeProcessing, 0)
  let trimmed = 0

  while (state.queue.size() > allowedQueueLength) {
    const work = state.queue.popNewest()
    if (!work) {
      break
    }
    trimmed += 1
    await releaseQueuedSubmitWork(
      work,
      "Submitter runtime downscaled before queued OCR submit started",
    )
  }

  if (trimmed > 0) {
    state.telemetry.recordQueueTrimmed(trimmed)
    Logger.warn(
      {
        role: "submitter",
        workerId: state.supervisorId,
        desiredInnerConcurrency,
        localCapacity,
        activeProcessing: state.activeProcessing,
        queueLength: state.queue.size(),
        trimmed,
      },
      "Trimmed queued Docling submit work after runtime downscale",
    )
  }
}

const runDoclingSchedulerAdmissionCoordinator = async (
  state: SubmitterSupervisorState,
  shouldStop: () => boolean,
) => {
  while (true) {
    if (shouldStop()) {
      return
    }

    try {
      const runtimeConfig = getDoclingRuntimeConfig()
      if (
        runtimeConfig.activeOcrFiles > 0 &&
        runtimeConfig.admittedPageBudget > 0
      ) {
        const { elapsedMs } = await timed(() =>
          admitDoclingOcrFiles({
            activeFileLimit: runtimeConfig.activeOcrFiles,
            admittedPageBudget: runtimeConfig.admittedPageBudget,
          }),
        )
        state.telemetry.recordTiming("admitMs", elapsedMs)
        logSlowSubmitterOperation("admit", elapsedMs, {
          workerId: state.supervisorId,
        })
      }

      state.telemetry.maybeLogSnapshot({
        supervisorId: state.supervisorId,
        desiredInnerConcurrency: getSubmitterDesiredConcurrency(),
        activeProcessing: state.activeProcessing,
        queueLength: state.queue.size(),
        localCapacity: getSubmitterLocalCapacity(
          getSubmitterDesiredConcurrency(),
        ),
      })
    } catch (error) {
      Logger.error(
        {
          role: "submitter",
          workerId: state.supervisorId,
          error: getErrorMessage(error),
        },
        "Docling submitter admission coordinator failed",
      )
    }

    await sleep(config.doclingSchedulerAdmissionPollMs)
  }
}

const acquireRequestPermitBatch = async (
  owner: string,
  capacity: number,
  desiredCount: number,
) => {
  const permits: DoclingSchedulerPermit[] = []
  for (let index = 0; index < desiredCount; index += 1) {
    const permit = await tryAcquireDoclingSchedulerPermit({
      kind: "ocr-submit",
      capacity,
      ttlMs: config.doclingAsyncSubmitPermitLeaseTtlMs,
      owner,
      metadata: {
        role: "submitter",
        batchIndex: index,
      },
    })
    if (!permit) {
      break
    }
    permits.push(permit)
  }
  return permits
}

const runDoclingSchedulerSubmitClaimer = async (
  id: string,
  state: SubmitterSupervisorState,
  shouldStop: () => boolean,
) => {
  while (true) {
    if (shouldStop()) {
      return
    }

    try {
      await trimSubmitterQueueToCapacity(state)

      const runtimeConfig = getDoclingRuntimeConfig()
      const desiredInnerConcurrency = Math.max(
        runtimeConfig.submitterConcurrencyPerContainer,
        1,
      )
      const localCapacity = getSubmitterLocalCapacity(desiredInnerConcurrency)
      const freeLocalCapacity = Math.max(
        localCapacity - state.activeProcessing - state.queue.size(),
        0,
      )

      if (freeLocalCapacity <= 0) {
        await sleep(config.doclingSchedulerPollMs)
        continue
      }

      const effectiveClaimBatchSize = Math.max(
        1,
        Math.min(
          config.doclingSchedulerSubmitClaimBatchSize,
          freeLocalCapacity,
          100,
        ),
      )

      const requestPermitTimed = await timed(() =>
        acquireRequestPermitBatch(
          id,
          runtimeConfig.submitPermits,
          effectiveClaimBatchSize,
        ),
      )
      state.telemetry.recordTiming(
        "requestPermitAcquireMs",
        requestPermitTimed.elapsedMs,
      )
      const permits = requestPermitTimed.value
      if (permits.length === 0) {
        await sleep(config.doclingSchedulerPollMs)
        continue
      }

      const claimTimed = await timed(() =>
        claimDoclingPartsForSubmitBatch({
          workerId: id,
          permitIds: permits.map((permit) => permit.permitId),
          leaseMs: config.doclingSchedulerLeaseMs,
          perFileInflightPages: runtimeConfig.perFileInflightPages,
          admittedPageBudget: runtimeConfig.admittedPageBudget,
          maxParts: effectiveClaimBatchSize,
        }),
      )
      state.telemetry.recordTiming("claimMs", claimTimed.elapsedMs)
      logSlowSubmitterOperation("claim", claimTimed.elapsedMs, {
        workerId: id,
        batchSizeRequested: effectiveClaimBatchSize,
        batchSizeClaimed: claimTimed.value.length,
      })
      state.telemetry.recordLoop()

      const claimedParts = claimTimed.value
      const claimedPermitIds = new Set(
        claimedParts
          .map((part) => part.submitPermitId)
          .filter((permitId): permitId is string => Boolean(permitId)),
      )
      const unusedPermits = permits.filter(
        (permit) => !claimedPermitIds.has(permit.permitId),
      )
      if (unusedPermits.length > 0) {
        await Promise.all(
          unusedPermits.map((permit) => releaseDoclingOcrSubmitPermit(permit)),
        )
        state.telemetry.recordUnusedPermits(unusedPermits.length)
      }

      if (claimedParts.length === 0) {
        state.telemetry.recordEmptyClaim()
        await sleep(config.doclingSchedulerPollMs)
        continue
      }

      state.telemetry.recordClaimed(claimedParts)

      const permitById = new Map(
        permits.map((permit) => [permit.permitId, permit]),
      )
      for (const part of claimedParts) {
        const permitId = part.submitPermitId
        if (!permitId || !part.currentJobId) {
          if (permitId) {
            const orphanPermit = permitById.get(permitId)
            if (orphanPermit) {
              await releaseDoclingOcrSubmitPermit(orphanPermit)
            }
          }
          await failDoclingSchedulerFile(
            part.fileId,
            "Claimed OCR part without submit permit id or job id",
          )
          continue
        }

        const requestPermit = permitById.get(permitId)
        if (!requestPermit) {
          await failDoclingSchedulerFile(
            part.fileId,
            `Claimed OCR part ${part.partIndex} without matching request permit`,
          )
          continue
        }

        const pagePermitTimed = await timed(() =>
          tryAcquireDoclingSchedulerWeightedPermit({
            kind: "ocr-submit-pages",
            permitId,
            capacity: runtimeConfig.admittedPageBudget,
            weight: part.pageCount,
            ttlMs: config.doclingAsyncSubmitPermitLeaseTtlMs,
            owner: id,
            allowOversizeWhenEmpty: true,
            metadata: {
              fileId: part.fileId,
              partIndex: part.partIndex,
              pageCount: part.pageCount,
            },
          }),
        )
        state.telemetry.recordTiming(
          "pagePermitAcquireMs",
          pagePermitTimed.elapsedMs,
        )

        if (!pagePermitTimed.value) {
          await releaseDoclingOcrSubmitPermit(requestPermit)
          await releaseClaimedDoclingPartForSubmitCapacity({
            fileId: part.fileId,
            partIndex: part.partIndex,
            jobId: part.currentJobId,
            errorMessage: "OCR page admission budget is full",
            availableAt: new Date(Date.now() + config.doclingSchedulerPollMs),
          })
          continue
        }

        const currentDesiredInnerConcurrency = getSubmitterDesiredConcurrency()
        const currentLocalCapacity = getSubmitterLocalCapacity(
          currentDesiredInnerConcurrency,
        )
        if (state.activeProcessing + state.queue.size() >= currentLocalCapacity) {
          await releaseDoclingOcrSubmitPermit(requestPermit)
          await releaseClaimedDoclingPartForSubmitCapacity({
            fileId: part.fileId,
            partIndex: part.partIndex,
            jobId: part.currentJobId,
            errorMessage:
              "Submitter local queue capacity changed before OCR submit started",
            availableAt: new Date(Date.now() + config.doclingSchedulerPollMs),
          })
          continue
        }

        state.queue.push({
          part,
          requestPermit,
          claimedAt: Date.now(),
          pagePermitAcquiredAt: Date.now(),
        })
      }

      state.telemetry.maybeLogSnapshot({
        supervisorId: state.supervisorId,
        desiredInnerConcurrency,
        activeProcessing: state.activeProcessing,
        queueLength: state.queue.size(),
        localCapacity,
      })
    } catch (error) {
      Logger.error(
        {
          role: "submitter",
          workerId: id,
          error: getErrorMessage(error),
        },
        "Docling submit claimer failed",
      )
      await sleep(config.doclingSchedulerPollMs)
    }
  }
}

const runDoclingSchedulerSubmitProcessor = async (
  id: string,
  state: SubmitterSupervisorState,
  shouldStop: () => boolean,
) => {
  while (true) {
    if (shouldStop()) {
      return
    }

    if (
      state.activeProcessing + state.reservedProcessing >=
      getSubmitterDesiredConcurrency()
    ) {
      await sleep(config.doclingSchedulerPollMs)
      continue
    }

    state.reservedProcessing += 1
    const queueTimedStartedAt = Date.now()
    const work = await state.queue.take(config.doclingSchedulerPollMs)
    state.telemetry.recordTiming(
      "queueWaitMs",
      Date.now() - queueTimedStartedAt,
    )
    state.reservedProcessing = Math.max(state.reservedProcessing - 1, 0)

    if (!work) {
      continue
    }

    if (state.activeProcessing >= getSubmitterDesiredConcurrency()) {
      state.queue.pushFront(work)
      await sleep(config.doclingSchedulerPollMs)
      continue
    }

    state.activeProcessing += 1

    const startedAt = Date.now()
    const jobId = work.part.currentJobId
    if (!jobId) {
      state.activeProcessing = Math.max(state.activeProcessing - 1, 0)
      await releaseQueuedSubmitWork(
        work,
        "Queued claimed OCR part lost job id before processing",
      )
      continue
    }

    try {
      const file = await getDoclingFile(work.part.fileId)
      if (!file) {
        throw new Error(`Missing scheduler file for ${work.part.fileId}`)
      }
      const kbFile = await getSchedulerKbFileContext(work.part.fileId)

      const isTxt = isTextFile(kbFile.baseMimeType)

      if (isTxt) {
        const resultPath = getDoclingSchedulerResultPath(
          work.part.fileId,
          path.basename(path.dirname(work.part.partPath)),
          work.part.partIndex,
        )

        const processTimed = await timed(() =>
          processTextPartLocally({
            partPath: work.part.partPath,
            partIndex: work.part.partIndex,
            startPage: work.part.startPage,
            resultPath,
            fileName: kbFile.fileName,
          }),
        )
        state.telemetry.recordTiming("submitMs", processTimed.elapsedMs)

        const markReadyTimed = await timed(() =>
          markDoclingPartReady({
            fileId: work.part.fileId,
            partIndex: work.part.partIndex,
            jobId,
            resultPath,
          }),
        )
        state.telemetry.recordTiming(
          "markSubmittedMs",
          markReadyTimed.elapsedMs,
        )
        // Text is processed locally, so no result-stream worker will run the
        // normal OCR permit cleanup. Release both request and page permits
        // here, including for text jobs queued before text moved back to the
        // standard processor.
        await releaseDoclingOcrSubmitPermit(work.requestPermit)
        continue
      }

      const partFileName = `${kbFile.fileName}.part-${work.part.partIndex}.pdf`

      const readTimed = await timed(() =>
        PdfProcessor.readStagedPartBuffer({
          partIndex: work.part.partIndex,
          startPage: work.part.startPage,
          endPage: work.part.endPage,
          totalPages: file.totalPages,
          partDocId: work.part.docId,
          partFileName,
          partPath: work.part.partPath,
          partSizeBytes: work.part.partSizeBytes,
        }),
      )
      state.telemetry.recordTiming("readPartMs", readTimed.elapsedMs)
      logSlowSubmitterOperation("read_part", readTimed.elapsedMs, {
        workerId: id,
        fileId: work.part.fileId,
        partIndex: work.part.partIndex,
      })

      const submitTimed = await timed(() =>
        submitDoclingAsyncJob({
          buffer: readTimed.value,
          fileName: partFileName,
          mimeType: "application/pdf",
          jobId,
          fileId: work.part.fileId,
          docId: work.part.docId,
          vespaDocId: kbFile.vespaDocId,
          skipInternalPermit: true,
        }),
      )
      state.telemetry.recordTiming("submitMs", submitTimed.elapsedMs)
      logSlowSubmitterOperation("submit", submitTimed.elapsedMs, {
        workerId: id,
        fileId: work.part.fileId,
        partIndex: work.part.partIndex,
        jobId,
      })

      const markSubmittedTimed = await timed(() =>
        markDoclingPartSubmitted(work.part.fileId, work.part.partIndex, jobId),
      )
      state.telemetry.recordTiming(
        "markSubmittedMs",
        markSubmittedTimed.elapsedMs,
      )
    } catch (error) {
      await releaseDoclingOcrSubmitPermit(work.requestPermit)
      const message = getErrorMessage(error)
      let partPathExists: boolean | null = null
      if (message.includes("ENOENT")) {
        try {
          await access(work.part.partPath)
          partPathExists = true
        } catch {
          partPathExists = false
        }
      }
      Logger.error(
        {
          role: "submitter",
          workerId: id,
          fileId: work.part.fileId,
          partIndex: work.part.partIndex,
          attemptCount: work.part.attemptCount,
          jobId,
          partPath: work.part.partPath,
          partPathExists,
          error: message,
        },
        "Docling submit processor failed",
      )
      if (work.part.attemptCount >= config.doclingSchedulerMaxPartAttempts) {
        await failDoclingSchedulerFile(
          work.part.fileId,
          `OCR submit failed for part ${work.part.partIndex} after ${work.part.attemptCount} attempts: ${message}`,
        )
      } else {
        await markDoclingPartSubmitRetry({
          fileId: work.part.fileId,
          partIndex: work.part.partIndex,
          jobId,
          errorMessage: message,
          availableAt: new Date(
            Date.now() + retryDelay(work.part.attemptCount),
          ),
        })
      }
    } finally {
      state.telemetry.recordTiming("totalProcessMs", Date.now() - startedAt)
      state.activeProcessing = Math.max(state.activeProcessing - 1, 0)
      state.telemetry.maybeLogSnapshot({
        supervisorId: state.supervisorId,
        desiredInnerConcurrency: getSubmitterDesiredConcurrency(),
        activeProcessing: state.activeProcessing,
        queueLength: state.queue.size(),
        localCapacity: getSubmitterLocalCapacity(
          getSubmitterDesiredConcurrency(),
        ),
      })
    }
  }
}

export const startDoclingSchedulerSubmitter = async () => {
  const supervisorId = workerId("submitter-supervisor")
  let stopRequested = false
  const shouldStop = () => stopRequested
  const state: SubmitterSupervisorState = {
    supervisorId,
    queue: new AsyncWorkQueue<ClaimedSubmitWork>(),
    telemetry: new SubmitterTelemetry(),
    activeProcessing: 0,
    reservedProcessing: 0,
  }

  const requestStop = () => {
    stopRequested = true
  }

  process.once("SIGTERM", requestStop)
  process.once("SIGINT", requestStop)

  const capacityManager = (async () => {
    while (!shouldStop()) {
      try {
        await trimSubmitterQueueToCapacity(state)
      } catch (error) {
        Logger.error(
          {
            role: "submitter",
            workerId: supervisorId,
            error: getErrorMessage(error),
          },
          "Docling submitter capacity manager failed",
        )
      }
      await sleep(config.doclingSchedulerPollMs)
    }
  })()

  const claimers = Array.from(
    { length: config.doclingSchedulerMaxConcurrentClaimers },
    (_, index) =>
      runDoclingSchedulerSubmitClaimer(
        workerId(`submitter-claimer-${index}`),
        state,
        shouldStop,
      ),
  )

  try {
    await Promise.all([
      runDoclingSchedulerAdmissionCoordinator(state, shouldStop),
      capacityManager,
      startDynamicRolePool({
        role: "submitter-processor",
        getDesiredConcurrency: getSubmitterDesiredConcurrency,
        shouldStop,
        runWorker: (workerName, workerShouldStop) =>
          runDoclingSchedulerSubmitProcessor(workerName, state, workerShouldStop),
      }),
      ...claimers,
    ])
  } finally {
    process.off("SIGTERM", requestStop)
    process.off("SIGINT", requestStop)

    Logger.info(
      {
        role: "submitter",
        workerId: supervisorId,
        activeProcessing: state.activeProcessing,
        queuedWork: state.queue.size(),
        drainMs: config.doclingSchedulerSubmitterShutdownDrainMs,
      },
      "Docling submitter shutdown drain started",
    )

    let releasedQueuedWork = 0
    while (state.queue.size() > 0) {
      const work = state.queue.popNewest()
      if (!work) {
        break
      }
      await releaseQueuedSubmitWork(
        work,
        "Submitter supervisor stopped before queued OCR submit started",
      )
      releasedQueuedWork += 1
    }

    const drainDeadline =
      Date.now() + config.doclingSchedulerSubmitterShutdownDrainMs
    while (state.activeProcessing > 0 && Date.now() < drainDeadline) {
      await sleep(100)
    }

    if (state.activeProcessing > 0) {
      Logger.warn(
        {
          role: "submitter",
          workerId: supervisorId,
          activeProcessing: state.activeProcessing,
          releasedQueuedWork,
          drainMs: config.doclingSchedulerSubmitterShutdownDrainMs,
        },
        "Docling submitter shutdown drain timed out with active submit work",
      )
    } else {
      Logger.info(
        {
          role: "submitter",
          workerId: supervisorId,
          releasedQueuedWork,
        },
        "Docling submitter shutdown drain completed",
      )
    }
  }
}

const handleSchedulerResultEvent = async (message: RedisStreamEntry) => {
  const jobId = message.fields.job_id
  const status = message.fields.status
  if (!jobId) {
    return
  }

  const part = await getDoclingPartByJobId(jobId)
  if (!part) {
    return
  }

  if (
    part.status !== DOCLING_PART_STATUS.Submitting &&
    part.status !== DOCLING_PART_STATUS.Submitted
  ) {
    if (part.submitPermitId) {
      await releaseDoclingOcrSubmitPermit({ permitId: part.submitPermitId })
    }
    Logger.info(
      {
        jobId,
        fileId: part.fileId,
        partIndex: part.partIndex,
        status: part.status,
        messageId: message.id,
      },
      "Ignoring duplicate or stale scheduler Docling result event",
    )
    return
  }

  if (status === "failed") {
    if (part.submitPermitId) {
      await releaseDoclingOcrSubmitPermit({ permitId: part.submitPermitId })
    }
    const errorMessage = message.fields.error || "unknown OCR failure"
    if (part.attemptCount >= config.doclingSchedulerMaxPartAttempts) {
      await failDoclingSchedulerFile(
        part.fileId,
        `OCR failed for part ${part.partIndex} after ${part.attemptCount} attempts: ${errorMessage}`,
      )
    } else {
      await markDoclingPartSubmitRetry({
        fileId: part.fileId,
        partIndex: part.partIndex,
        jobId,
        errorMessage,
        availableAt: new Date(Date.now() + retryDelay(part.attemptCount)),
      })
    }
    return
  }

  if (status !== "ok") {
    throw new Error(`Unsupported Docling result status=${status}`)
  }

  const resultKey = message.fields.result_key
  if (!resultKey) {
    throw new Error(`Missing result_key for Docling event ${message.id}`)
  }

  const redis = await getRedisClient()
  const payload = await redis.get(resultKey)
  if (!payload) {
    throw new Error(`Missing Docling result payload at ${resultKey}`)
  }

  const file = await getDoclingFile(part.fileId)
  if (!file) {
    throw new Error(`Missing scheduler file for ${part.fileId}`)
  }

  const doclingResponse = JSON.parse(payload) as DoclingResponse
  const kbFile = await getSchedulerKbFileContext(part.fileId)
  const result = await processingResultFromDoclingResponse(
    doclingResponse,
    part.docId,
    { fileName: kbFile.fileName },
  )
  const resultPath = file.resultsDir
    ? path.join(
        file.resultsDir,
        `${String(part.partIndex).padStart(5, "0")}.json`,
      )
    : getDoclingSchedulerResultPath(
        part.fileId,
        path.basename(file.stageDir || ""),
        part.partIndex,
      )
  await writeDoclingSchedulerJson(resultPath, {
    ...result,
    processingMethod: result.processingMethod || PDF_PROCESSING_METHOD.DOCLING,
  })
  await markDoclingPartReady({
    fileId: part.fileId,
    partIndex: part.partIndex,
    jobId,
    resultPath,
  })
  await redis.del(resultKey).catch((error) => {
    Logger.warn(
      {
        resultKey,
        jobId,
        fileId: part.fileId,
        partIndex: part.partIndex,
        error: getErrorMessage(error),
      },
      "Failed to delete raw Docling result from Redis after durable store",
    )
  })
  if (part.submitPermitId) {
    await releaseDoclingOcrSubmitPermit({ permitId: part.submitPermitId })
  }
}

export const startDoclingSchedulerResultWorker = async () => {
  await ensureSchedulerConsumerGroup()
  const redis = await getRedisClient()
  const consumerName = workerId("result")

  while (true) {
    const claimed = parseXAutoClaimResponse(
      await redis.sendCommand([
        "XAUTOCLAIM",
        config.doclingResultsStream,
        config.doclingSchedulerResultGroup,
        consumerName,
        String(config.doclingResultMinIdleMs),
        "0-0",
        "COUNT",
        String(config.doclingResultReadCount),
      ]),
    )

    const messages =
      claimed.length > 0
        ? claimed
        : parseXReadResponse(
            await redis.sendCommand([
              "XREADGROUP",
              "GROUP",
              config.doclingSchedulerResultGroup,
              consumerName,
              "COUNT",
              String(config.doclingResultReadCount),
              "BLOCK",
              String(config.doclingResultBlockMs),
              "STREAMS",
              config.doclingResultsStream,
              ">",
            ]),
          )

    for (const message of messages) {
      try {
        await handleSchedulerResultEvent(message)
        await ackSchedulerMessage(message.id)
      } catch (error) {
        Logger.error(
          {
            messageId: message.id,
            fields: message.fields,
            error: getErrorMessage(error),
          },
          "Failed to process scheduler Docling result event",
        )
      }
    }
  }
}

const runDoclingSchedulerWriterWorker = async (
  id: string,
  shouldStop: () => boolean,
) => {
  while (true) {
    if (shouldStop()) {
      return
    }

    const runtimeConfig = getDoclingRuntimeConfig()
    let permit: Awaited<
      ReturnType<typeof tryAcquireDoclingSchedulerPermit>
    > | null = await tryAcquireDoclingSchedulerPermit({
      kind: "vespa-write",
      capacity: runtimeConfig.vespaWritePermits,
      ttlMs: config.doclingSchedulerVespaWritePermitTtlMs,
      owner: id,
      metadata: { phase: "claim" },
    })
    if (!permit) {
      await sleep(config.doclingSchedulerPollMs)
      continue
    }

    const file = await claimNextDoclingFileToWrite(
      id,
      config.doclingSchedulerLeaseMs,
    )
    if (!file) {
      await releaseDoclingSchedulerPermit(permit)
      await sleep(config.doclingSchedulerPollMs)
      continue
    }

    let fileNameForError = file.fileId
    try {
      const kbFile = await getSchedulerKbFileContext(file.fileId)
      fileNameForError = kbFile.fileName
      const parts = await getDoclingPartsForFile(file.fileId)
      if (parts.length !== file.totalParts) {
        throw new Error(
          `Expected ${file.totalParts} parts, found ${parts.length}`,
        )
      }
      const aggregate = await aggregatePartResults(parts)
      const sourcePath = resolveDoclingSchedulerSourcePath(
        file.sourcePath,
        file.sourceStorageKey,
      )
      const metadata = mergeMetadata(kbFile.metadata, {
        originalFileName: kbFile.originalName || kbFile.fileName,
        uploadedBy: kbFile.uploadedByEmail || "system",
        chunksCount: aggregate.chunks.length + aggregate.image_chunks.length,
        imageChunksCount: aggregate.image_chunks.length,
        tocChunksCount: aggregate.toc_chunks.length,
        processingMethod: kbFile.baseMimeType,
        pdfProcessingMethod: PDF_PROCESSING_METHOD.DOCLING,
        doclingAsyncScheduler: true,
        doclingPageChunkSize: file.pageChunkSize,
        doclingTotalPages: file.totalPages,
        doclingTotalParts: file.totalParts,
        lastModified: Date.now(),
      })
      const vespaDoc = {
        docId: kbFile.vespaDocId,
        clId: kbFile.collectionId,
        itemId: file.fileId,
        fileName: buildVespaFileName(kbFile),
        app: Apps.KnowledgeBase as const,
        entity: KnowledgeBaseEntity.File,
        description: "",
        storagePath: sourcePath,
        chunks: aggregate.chunks,
        chunks_pos: aggregate.chunks_pos,
        image_chunks: aggregate.image_chunks,
        image_chunks_pos: aggregate.image_chunks_pos,
        toc_chunks: aggregate.toc_chunks,
        chunks_map: aggregate.chunks_map,
        image_chunks_map: aggregate.image_chunks_map,
        pageTitle: "",
        metadata: JSON.stringify(metadata),
        createdBy: kbFile.uploadedByEmail || "system",
        duration: 0,
        mimeType: kbFile.baseMimeType,
        fileSize: kbFile.fileSize,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        clFd: kbFile.parentId,
      }

      const payloadBytes = Buffer.byteLength(
        JSON.stringify({ fields: vespaDoc }),
        "utf8",
      )
      if (payloadBytes > config.doclingSchedulerMaxVespaPayloadBytes) {
        await failDoclingFileIfOwned(
          file,
          DOCLING_FILE_STATUS.Writing,
          `Vespa payload for ${kbFile.fileName} is ${payloadBytes} bytes, exceeding limit ${config.doclingSchedulerMaxVespaPayloadBytes}`,
        )
        await releaseDoclingSchedulerPermit(permit)
        permit = null
        continue
      }

      await putKbItemInVespa(vespaDoc)
      await releaseDoclingSchedulerPermit(permit)
      permit = null

      const completed = await markDoclingFileCompleted({
        fileId: file.fileId,
        vespaDocId: kbFile.vespaDocId,
        metadata,
        statusMessage: `Successfully processed: ${aggregate.chunks.length + aggregate.image_chunks.length} chunks extracted from ${kbFile.fileName}`,
        leaseOwner: file.leaseOwner,
        leaseToken: file.leaseToken,
      })
      if (!completed) {
        Logger.warn(
          {
            fileId: file.fileId,
            leaseOwner: file.leaseOwner,
            leaseToken: file.leaseToken,
          },
          "Ignoring stale Docling write completion after lease changed",
        )
        continue
      }

      try {
        if (kbFile.collectionId) {
          if (kbFile.parentId) {
            await updateParentStatus(db, kbFile.parentId, false)
          } else {
            await updateParentStatus(db, kbFile.collectionId, true)
          }
        }
      } catch (error) {
        Logger.error(
          {
            fileId: file.fileId,
            collectionId: kbFile.collectionId,
            parentId: kbFile.parentId,
            error: getErrorMessage(error),
          },
          "Docling scheduler completed file but failed to update parent status",
        )
      }

      if (!config.doclingKeepTempResults) {
        await cleanupDoclingSchedulerStageDir(file.stageDir).catch((error) => {
          Logger.warn(
            {
              fileId: file.fileId,
              stageDir: file.stageDir,
              error: getErrorMessage(error),
            },
            "Docling scheduler completed file but failed to clean staged storage",
          )
        })
      }
    } catch (error) {
      if (permit) {
        await releaseDoclingSchedulerPermit(permit)
      }
      const message = getErrorMessage(error)
      if (isTerminalDoclingSchedulerError(error)) {
        await failDoclingFileIfOwned(file, DOCLING_FILE_STATUS.Writing, message)
      } else if (
        !isRetryableVespaError(error) ||
        file.writeAttemptCount >= config.doclingSchedulerMaxWriteAttempts
      ) {
        await failDoclingFileIfOwned(
          file,
          DOCLING_FILE_STATUS.Writing,
          `Vespa write failed for ${fileNameForError} after ${file.writeAttemptCount} attempts: ${message}`,
        )
      } else {
        await markDoclingFileWriteRetry(
          file,
          message,
          new Date(Date.now() + retryDelay(file.writeAttemptCount)),
        )
      }
    }
  }
}

export const startDoclingSchedulerWriter = async () =>
  startDynamicRolePool({
    role: "writer",
    getDesiredConcurrency: () => getDoclingRuntimeConfig().vespaWritePermits,
    runWorker: runDoclingSchedulerWriterWorker,
  })

export const startDoclingSchedulerReaper = async () => {
  while (true) {
    try {
      const deletedFileIds = await listDeletedActiveDoclingFileIds(50)
      for (const fileId of deletedFileIds) {
        await failDoclingSchedulerFile(
          fileId,
          "Collection item was deleted before Docling scheduler completion",
        )
      }
      if (deletedFileIds.length > 0) {
        Logger.warn(
          { failedFiles: deletedFileIds.length },
          "Failed Docling scheduler files whose collection items were deleted",
        )
      }

      const expiredSubmittingParts = await listExpiredSubmittingDoclingParts(50)
      for (const part of expiredSubmittingParts) {
        if (part.submitPermitId) {
          await releaseDoclingOcrSubmitPermit({ permitId: part.submitPermitId })
        }
      }
      await requeueExpiredDoclingLeases()
      await repairKbMetadataSyncBatch()
      const timedOutParts = await listTimedOutSubmittedDoclingParts(
        submittedPartTimeoutMs(),
        50,
      )
      for (const part of timedOutParts) {
        if (part.submitPermitId) {
          await releaseDoclingOcrSubmitPermit({ permitId: part.submitPermitId })
        }
        if (
          part.currentJobId &&
          part.attemptCount >= config.doclingSchedulerMaxPartAttempts
        ) {
          await failDoclingSchedulerFile(
            part.fileId,
            `OCR timed out for part ${part.partIndex} after ${part.attemptCount} attempts`,
          )
        } else if (part.currentJobId) {
          await markDoclingPartSubmitRetry({
            fileId: part.fileId,
            partIndex: part.partIndex,
            jobId: part.currentJobId,
            errorMessage: `OCR timed out after ${submittedPartTimeoutMs()}ms`,
            availableAt: new Date(Date.now() + retryDelay(part.attemptCount)),
          })
        }
      }
      await reconcileSchedulerOcrSubmitPermits()
      await reconcileWrapperGlobalActiveKeys()
    } catch (error) {
      Logger.error(
        { error: getErrorMessage(error) },
        "Docling scheduler reaper failed",
      )
    }
    await sleep(config.doclingSchedulerPollMs)
  }
}

export const startDoclingSchedulerRole = async (role: string) => {
  if (role === "splitter") return startDoclingSchedulerSplitter()
  if (role === "submitter") return startDoclingSchedulerSubmitter()
  if (role === "result") return startDoclingSchedulerResultWorker()
  if (role === "writer") return startDoclingSchedulerWriter()
  if (role === "reaper") return startDoclingSchedulerReaper()

  throw new Error(
    `Unknown DOCLING_SCHEDULER_ROLE=${role}. Expected splitter, submitter, result, writer, or reaper.`,
  )
}
