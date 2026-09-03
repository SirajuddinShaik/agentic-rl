import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import config, { IMAGE_CONTEXT_CONFIG } from "@/config"
import { db } from "@/platform/db/client"
import { updateParentStatus } from "@/platform/db/knowledgeBase"
import { collectionItems, collections } from "@/platform/db/schema"
import { getBaseMimeType } from "@/integrations/dataSource/config"
import { mergeCollectionItemMetadata } from "@/ingestion/domain/metadata"
import {
  buildVespaFileName,
  mapChunkMeta,
  offsetChunkMetadata,
} from "@/ingestion/indexing/kbDocumentBuilder"
import { recordWorkerPhase } from "@/ingestion/observability/diagnostics"
import { queuePdfForDoclingScheduler } from "@/ingestion/docling/scheduler/intake"
import {
  acquireDoclingActiveFile,
  releaseDoclingActiveFile,
} from "@/ingestion/docling/runtime/activeFiles"
import { submitDoclingAsyncJob } from "@/ingestion/docling/runtime/client"
import {
  type DoclingAsyncFileState,
  type DoclingAsyncPartState,
  getDoclingAsyncFileState,
  getDoclingAsyncPartState,
  numberFromRedis,
  patchDoclingAsyncFileState,
  patchDoclingAsyncPartState,
} from "@/ingestion/docling/runtime/state"
import {
  type DoclingStagedPart,
  type DoclingStagedParts,
  type ProcessingResult as PdfProcessingResult,
  PdfProcessor,
} from "@/platform/common/pdf/pdfProcessor"
import { getLogger } from "@/platform/logger"
import { UpdateDocument, insert } from "@/platform/search/vespa"
import {
  FileProcessorService,
  type SheetProcessingResult,
} from "@/ingestion/services/fileProcessor"
import { UploadStatus } from "@/platform/shared/types"
import { ProcessingJobType, Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"
import { Apps, KbItemsSchema, KnowledgeBaseEntity } from "@xyne/vespa-ts/types"
import { eq } from "drizzle-orm"

const Logger = getLogger(Subsystem.Queue)

export { mergeCollectionItemMetadata } from "@/ingestion/domain/metadata"
export { buildVespaFileName } from "@/ingestion/indexing/kbDocumentBuilder"

function resolveRuntimeStoragePath(storagePath: string): string {
  const runtimeServerRoot =
    process.env.XYNE_CONTAINER_SERVER_ROOT || process.cwd()
  const hostServerRoot = process.env.XYNE_HOST_SERVER_ROOT

  if (hostServerRoot && storagePath.startsWith(hostServerRoot + path.sep)) {
    return path.join(
      runtimeServerRoot,
      path.relative(hostServerRoot, storagePath),
    )
  }

  const marker = "/server/storage/"
  const markerIndex = storagePath.indexOf(marker)
  if (
    markerIndex >= 0 &&
    !storagePath.startsWith(runtimeServerRoot + path.sep)
  ) {
    return path.join(
      runtimeServerRoot,
      storagePath.slice(markerIndex + "/server/".length),
    )
  }

  return storagePath
}

function extractMarkdownTitle(content: string): string {
  const lines = content.split("\n")
  let inFrontmatter = false

  for (const line of lines) {
    const trimmedLine = line.trim()

    if (!trimmedLine) {
      continue
    }

    if (trimmedLine === "---") {
      inFrontmatter = !inFrontmatter
      continue
    }

    if (inFrontmatter) {
      if (trimmedLine.startsWith("page_title:")) {
        const title = trimmedLine.substring("page_title:".length).trim()
        if (title) {
          return title.replace(/^["']|["']$/g, "").trim()
        }
      }
      continue
    }

    break
  }

  return ""
}

export interface FileProcessingJob {
  fileId: string
  type?: typeof ProcessingJobType.FILE
  useOCR?: boolean // default true
}

export type ProcessingJob = FileProcessingJob

async function handleRetryFailure(
  fileId: string,
  currentRetryCount: number,
  errorMessage: string,
  parentId?: string | null,
  collectionId?: string,
) {
  const newRetryCount = currentRetryCount + 1
  const maxRetries = 3 // Match pg-boss retryLimit

  if (newRetryCount >= maxRetries) {
    const updateData = {
      uploadStatus: UploadStatus.FAILED,
      statusMessage: `Processing failed after ${newRetryCount} attempts: ${errorMessage}`,
      retryCount: newRetryCount,
      updatedAt: new Date(),
    }

    await db
      .update(collectionItems)
      .set(updateData)
      .where(eq(collectionItems.id, fileId))

    if (parentId !== undefined && collectionId) {
      if (parentId) {
        await updateParentStatus(db, parentId, false)
      } else {
        await updateParentStatus(db, collectionId, true)
      }
    }
  } else {
    // Keep status 'processing' so pg-boss retries.
    const updateData = {
      statusMessage: `Processing attempt ${newRetryCount} failed: ${errorMessage} (will retry)`,
      retryCount: newRetryCount,
      updatedAt: new Date(),
    }

    await db
      .update(collectionItems)
      .set(updateData)
      .where(eq(collectionItems.id, fileId))
  }
}

export async function processJob(job: { data: ProcessingJob }) {
  const startTime = Date.now()
  Logger.info(`Raw job data: ${JSON.stringify(job.data)}`)

  const jobData = job.data
  const jobType = jobData.type || ProcessingJobType.FILE
  const entityId = jobData.fileId

  recordWorkerPhase("process_job_dispatch", {
    jobType,
    entityId,
    jobData,
  })

  try {
    if (jobType !== ProcessingJobType.FILE) {
      throw new Error(`FileProcessingQueue only accepts file jobs: ${jobType}`)
    }
    return await processFileJob(jobData, startTime)
  } finally {
    recordWorkerPhase("process_job_finished", {
      jobType,
      entityId,
      elapsedMs: Date.now() - startTime,
    })
  }
}

export async function appendDoclingPartToKbItem(
  docId: string,
  result: PdfProcessingResult,
  metadata: Record<string, unknown>,
  textChunkOffset: number,
  imageChunkOffset: number,
  pageOffset: number,
) {
  const chunkPositions = result.chunks.map(
    (_, index) => textChunkOffset + index,
  )
  const imageChunkPositions = result.image_chunks.map(
    (_, index) => imageChunkOffset + index,
  )

  const fields: Parameters<typeof UpdateDocument>[2] = {
    metadata: { assign: JSON.stringify(metadata) },
    updatedAt: { assign: Date.now() },
  }

  if (result.chunks.length > 0) {
    fields.chunks = { add: result.chunks }
    fields.chunks_pos = { add: chunkPositions }
    fields.chunks_map = {
      add: result.chunks_map.map((meta, index) =>
        mapChunkMeta(
          offsetChunkMetadata(meta, chunkPositions[index] ?? index, pageOffset),
          true,
        ),
      ),
    }
  }

  if (result.image_chunks.length > 0) {
    fields.image_chunks = { add: result.image_chunks }
    fields.image_chunks_pos = { add: imageChunkPositions }
    fields.image_chunks_map = {
      add: result.image_chunks_map.map((meta, index) =>
        mapChunkMeta(
          offsetChunkMetadata(
            meta,
            imageChunkPositions[index] ?? index,
            pageOffset,
          ),
          false,
        ),
      ),
    }
  }

  if (result.toc_chunks.length > 0) {
    fields.toc_chunks = { add: result.toc_chunks }
  }

  await UpdateDocument(KbItemsSchema, docId, fields)
}



const isAsyncPartDone = (status?: string) =>
  status === "applied" || status === "completed"

const shouldSkipAsyncPartSubmit = (status?: string) =>
  status === "pending" ||
  status === "submitted" ||
  status === "ready" ||
  status === "applying" ||
  isAsyncPartDone(status)

const hashDoclingAsyncIdentity = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24)

export const buildDoclingAsyncRunId = (
  file: {
    id: string
    storagePath: string
    vespaDocId: string
    fileSize: number | null
  },
  stagedParts: DoclingStagedParts,
): string =>
  hashDoclingAsyncIdentity({
    fileId: file.id,
    vespaDocId: file.vespaDocId,
    storagePath: file.storagePath,
    fileSize: file.fileSize ?? stagedParts.sourceSize ?? null,
    sourceSize: stagedParts.sourceSize,
    totalPages: stagedParts.totalPages,
    pageChunkSize: stagedParts.pageChunkSize,
    partsTotal: stagedParts.partsTotal,
    parts: stagedParts.parts.map((part) => ({
      partIndex: part.partIndex,
      startPage: part.startPage,
      endPage: part.endPage,
      totalPages: part.totalPages,
      partSizeBytes: part.partSizeBytes,
    })),
  })

export const buildDoclingAsyncPartFingerprint = (
  runId: string,
  part: DoclingStagedPart,
): string =>
  hashDoclingAsyncIdentity({
    runId,
    partIndex: part.partIndex,
    startPage: part.startPage,
    endPage: part.endPage,
    totalPages: part.totalPages,
    partSizeBytes: part.partSizeBytes,
  })


const stagedPartFromState = (
  state: Partial<DoclingAsyncFileState>,
  partState: Partial<DoclingAsyncPartState>,
  partIndex: number,
): DoclingStagedPart => {
  const partPath = partState.partPath
  if (!partPath) {
    throw new Error(
      `Missing staged part path for file=${state.fileId} part=${partIndex}`,
    )
  }

  const vespaDocId = state.vespaDocId || partState.vespaDocId
  if (!vespaDocId) {
    throw new Error(
      `Missing vespaDocId for file=${state.fileId} part=${partIndex}`,
    )
  }

  return {
    partIndex,
    startPage: numberFromRedis(partState.startPage),
    endPage: numberFromRedis(partState.endPage),
    totalPages: numberFromRedis(
      partState.totalPages,
      numberFromRedis(state.totalPages),
    ),
    partDocId: partState.docId || `${vespaDocId}__docling_part_${partIndex}`,
    partFileName:
      partState.fileName ||
      `${state.fileName || state.fileId}.part-${partIndex}.pdf`,
    partPath,
    partSizeBytes: numberFromRedis(partState.partSizeBytes),
  }
}

export async function submitNextDoclingAsyncPart(
  fileId: string,
): Promise<boolean> {
  const state = await getDoclingAsyncFileState(fileId)
  if (!state) {
    throw new Error(`Missing Docling async file state for ${fileId}`)
  }

  const totalParts = numberFromRedis(state.totalParts)
  const nextPartToSubmit = numberFromRedis(
    state.nextPartToSubmit,
    numberFromRedis(state.nextPartToApply),
  )

  if (nextPartToSubmit >= totalParts) {
    return false
  }

  if (nextPartToSubmit > 0) {
    const previousPart = await getDoclingAsyncPartState(
      fileId,
      nextPartToSubmit - 1,
    )
    if (!isAsyncPartDone(previousPart?.status)) {
      Logger.info(
        {
          fileId,
          nextPartToSubmit,
          previousPartStatus: previousPart?.status,
        },
        "Skipping async Docling part submit until previous part is completed",
      )
      return false
    }
  }

  const partState = await getDoclingAsyncPartState(fileId, nextPartToSubmit)
  if (!partState) {
    throw new Error(
      `Missing Docling async part state for file=${fileId} part=${nextPartToSubmit}`,
    )
  }

  if (shouldSkipAsyncPartSubmit(partState.status)) {
    Logger.info(
      {
        fileId,
        partIndex: nextPartToSubmit,
        status: partState.status,
      },
      "Skipping async Docling part submit because part is already active or done",
    )
    return false
  }

  const stagedPart = stagedPartFromState(state, partState, nextPartToSubmit)
  const submitCount = numberFromRedis(partState.submitCount) + 1
  const vespaDocId = stagedPart.partDocId.split("__docling_part_")[0]
  const jobId =
    partState.jobId ||
    (state.runId
      ? `docling:${fileId}:${vespaDocId}:run:${state.runId}:part:${nextPartToSubmit}:v2`
      : `docling:${fileId}:${vespaDocId}:part:${nextPartToSubmit}:v1`)

  const isInitialPart = nextPartToSubmit === 0
  let activeFileSlotAcquired = false

  try {
    if (isInitialPart) {
      await acquireDoclingActiveFile({
        fileId,
        fileName: state.fileName || stagedPart.partFileName,
      })
      activeFileSlotAcquired = true
    }

    await patchDoclingAsyncPartState(fileId, nextPartToSubmit, {
      status: "pending",
      submitCount: String(submitCount),
      jobId,
      error: "",
    })

    const partBuffer = await PdfProcessor.readStagedPartBuffer(stagedPart)
    await submitDoclingAsyncJob({
      buffer: partBuffer,
      fileName: stagedPart.partFileName,
      mimeType: "application/pdf",
      jobId,
      fileId,
      docId: stagedPart.partDocId,
      vespaDocId: state.vespaDocId || partState.vespaDocId || "",
    })

    await patchDoclingAsyncPartState(fileId, nextPartToSubmit, {
      status: "submitted",
      submitCount: String(submitCount),
      error: "",
    })
    await patchDoclingAsyncFileState(fileId, {
      status: "submitted",
      nextPartToSubmit: String(nextPartToSubmit + 1),
    })

    recordWorkerPhase("async_docling_part_submitted", {
      fileId,
      fileName: state.fileName,
      jobId,
      partIndex: nextPartToSubmit,
      startPage: stagedPart.startPage,
      endPage: stagedPart.endPage,
      totalParts,
    })

    return true
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    await patchDoclingAsyncPartState(fileId, nextPartToSubmit, {
      status: "queued",
      submitCount: String(submitCount),
      jobId,
      error: errorMessage,
    }).catch((patchError) => {
      Logger.error(
        {
          fileId,
          partIndex: nextPartToSubmit,
          error: getErrorMessage(patchError),
        },
        "Failed to reset async Docling part after submit failure",
      )
    })

    if (activeFileSlotAcquired) {
      await releaseDoclingActiveFile(fileId).catch((releaseError) => {
        Logger.error(
          {
            fileId,
            error: getErrorMessage(releaseError),
          },
          "Failed to release async Docling active-file slot after submit failure",
        )
      })
    }

    throw error
  }
}


async function processFileJob(jobData: FileProcessingJob, startTime: number) {
  const { fileId } = jobData

  // Loaded outside the try so the catch can still read file details for error handling.
  const fileDetails = await db
    .select({
      id: collectionItems.id,
      type: collectionItems.type,
      storagePath: collectionItems.storagePath,
      vespaDocId: collectionItems.vespaDocId,
      uploadStatus: collectionItems.uploadStatus,
      fileName: collectionItems.name,
      path: collectionItems.path,
      parentId: collectionItems.parentId,
      mimeType: collectionItems.mimeType,
      fileSize: collectionItems.fileSize,
      originalName: collectionItems.originalName,
      collectionId: collectionItems.collectionId,
      uploadedByEmail: collectionItems.uploadedByEmail,
      uploadedById: collectionItems.uploadedById,
      retryCount: collectionItems.retryCount,
      collectionName: collections.name,
      metadata: collectionItems.metadata,
    })
    .from(collectionItems)
    .innerJoin(collections, eq(collectionItems.collectionId, collections.id))
    .where(eq(collectionItems.id, fileId))
    .limit(1)

  const file = fileDetails[0]
  if (!file) {
    Logger.warn(`File not found: ${fileId}`)
    return
  }
  recordWorkerPhase("file_details_loaded", {
    fileId,
    fileName: file.fileName,
    storagePath: file.storagePath,
    mimeType: file.mimeType,
    fileSize: file.fileSize,
    uploadStatus: file.uploadStatus,
    vespaDocId: file.vespaDocId,
  })

  if (file.type !== "file") {
    Logger.warn(`Item is not a file: ${fileId}`)
    return
  }

  try {
    Logger.info(`Processing file job: ${fileId}`)

    if (file.uploadStatus === UploadStatus.COMPLETED) {
      Logger.info(`File already processed: ${fileId}`)
      recordWorkerPhase("file_already_completed", {
        fileId,
        fileName: file.fileName,
      })
      return
    }

    recordWorkerPhase("file_status_update_start", {
      fileId,
      fileName: file.fileName,
    })
    await db
      .update(collectionItems)
      .set({
        uploadStatus: UploadStatus.PROCESSING,
        statusMessage: `Processing file: ${file.fileName}`,
        updatedAt: new Date(),
      })
      .where(eq(collectionItems.id, fileId))
    recordWorkerPhase("file_status_update_done", {
      fileId,
      fileName: file.fileName,
    })

    Logger.info(
      {
        fileId,
        fileName: file.fileName,
        storagePath: file.storagePath,
      },
      "File job status set to PROCESSING",
    )
    Logger.info(`Processing file: ${file.fileName} at ${file.storagePath}`)

    if (!file.storagePath) {
      throw new Error(`No storage path for file: ${fileId}`)
    }

    if (!file.vespaDocId) {
      throw new Error(`No vespaDocId for file: ${fileId}`)
    }

    const runtimeStoragePath = resolveRuntimeStoragePath(file.storagePath)
    if (runtimeStoragePath !== file.storagePath) {
      Logger.warn(
        {
          fileId,
          fileName: file.fileName,
          storagePath: file.storagePath,
          runtimeStoragePath,
        },
        "Remapped storage path for container runtime",
      )
    }
    const baseMimeType = getBaseMimeType(file.mimeType || "text/plain")
    const useOCR = jobData.useOCR !== false
    const asyncDoclingPdfPath =
      baseMimeType === "application/pdf" && useOCR

    let fileBuffer: Buffer | null = null
    if (asyncDoclingPdfPath) {
      recordWorkerPhase("read_file_skipped", {
        fileId,
        fileName: file.fileName,
        runtimeStoragePath,
        reason: "async_docling_qpdf_staging_uses_file_path",
      })
      Logger.info(
        {
          fileId,
          fileName: file.fileName,
          storagePath: file.storagePath,
          runtimeStoragePath,
          expectedSizeBytes: file.fileSize,
        },
        "Skipping full PDF read before async Docling qpdf staging",
      )
    } else {
      Logger.info(
        {
          fileId,
          fileName: file.fileName,
          storagePath: file.storagePath,
          expectedSizeBytes: file.fileSize,
        },
        "Reading file from disk for processing",
      )
      recordWorkerPhase("read_file_start", {
        fileId,
        fileName: file.fileName,
        storagePath: file.storagePath,
        runtimeStoragePath,
        expectedSizeBytes: file.fileSize,
      })
      fileBuffer = await readFile(runtimeStoragePath)
      recordWorkerPhase("read_file_done", {
        fileId,
        fileName: file.fileName,
        runtimeStoragePath,
        fileBufferBytes: fileBuffer.length,
      })
      Logger.info(
        {
          fileId,
          fileName: file.fileName,
          storagePath: file.storagePath,
          runtimeStoragePath,
          fileBufferBytes: fileBuffer.length,
        },
        "File read completed",
      )
    }

    let pageTitle: string = ""
    if (baseMimeType === "text/markdown" && fileBuffer) {
      try {
        const fileContent = fileBuffer.toString("utf-8")
        pageTitle = extractMarkdownTitle(fileContent)
      } catch (error) {
        Logger.warn(
          `Failed to extract title from markdown file ${file.fileName}: ${getErrorMessage(error)}`,
        )
      }

      if (!pageTitle) {
        pageTitle = ""
        Logger.info(
          `Using empty string as pageTitle for ${file.fileName}: ${pageTitle}`,
        )
      }
    }

    let fallbackUseOCR = useOCR
    Logger.info(
      {
        fileId,
        fileName: file.fileName,
        mimeType: file.mimeType,
        baseMimeType,
        useOCR,
        doclingSchedulerDefault: true,
        doclingPageChunkSize: config.doclingPageChunkSize,
        imageContextEnabled: IMAGE_CONTEXT_CONFIG.enabled,
      },
      "File processing mode selected",
    )
    if (baseMimeType === "application/pdf" && useOCR) {
      const { schedulerFile, sourceKind, basePriority } =
        await queuePdfForDoclingScheduler({
          fileId,
          vespaDocId: file.vespaDocId,
          collectionId: file.collectionId,
          parentId: file.parentId,
          collectionName: file.collectionName,
          fileName: file.fileName,
          originalName: file.originalName,
          storagePath: runtimeStoragePath,
          path: file.path,
          mimeType: file.mimeType || "application/pdf",
          fileSize: file.fileSize || 0,
          uploadedByEmail: file.uploadedByEmail,
          pageTitle,
          metadata:
            typeof file.metadata === "object" && file.metadata !== null
              ? (file.metadata as Record<string, unknown>)
              : {},
        })

      if (!schedulerFile) {
        recordWorkerPhase("async_docling_scheduler_duplicate_ignored", {
          fileId,
          fileName: file.fileName,
        })
        Logger.info(
          { fileId, fileName: file.fileName },
          "Skipped async Docling scheduler enqueue because file is already active or completed",
        )
        return
      }

      recordWorkerPhase("async_docling_scheduler_queued", {
        fileId,
        fileName: file.fileName,
        sourceKind,
        basePriority,
      })
      Logger.info(
        { fileId, fileName: file.fileName, sourceKind, basePriority },
        "Queued PDF for async Docling scheduler",
      )
      return
    }

    if (!fileBuffer) {
      Logger.info(
        {
          fileId,
          fileName: file.fileName,
          storagePath: file.storagePath,
          runtimeStoragePath,
        },
        "Re-reading file from disk for standard processing",
      )
      recordWorkerPhase("standard_read_file_start", {
        fileId,
        fileName: file.fileName,
        runtimeStoragePath,
      })
      fileBuffer = await readFile(runtimeStoragePath)
      recordWorkerPhase("standard_read_file_done", {
        fileId,
        fileName: file.fileName,
        fileBufferBytes: fileBuffer.length,
      })
      Logger.info(
        {
          fileId,
          fileName: file.fileName,
          fileBufferBytes: fileBuffer.length,
        },
        "Standard processing file read completed",
      )
    }

    Logger.info(
      {
        fileId,
        fileName: file.fileName,
        mimeType: file.mimeType,
        baseMimeType,
        fallbackUseOCR,
        extractImages: IMAGE_CONTEXT_CONFIG.enabled,
        describeImages: IMAGE_CONTEXT_CONFIG.enabled,
        fileBufferBytes: fileBuffer.length,
      },
      "Standard file processor starting",
    )
    recordWorkerPhase("standard_processor_start", {
      fileId,
      fileName: file.fileName,
      mimeType: file.mimeType,
      baseMimeType,
      fallbackUseOCR,
      fileBufferBytes: fileBuffer.length,
    })
    const processingResults = await FileProcessorService.processFile(
      fileBuffer,
      file.mimeType || "application/octet-stream",
      file.fileName,
      file.vespaDocId || "",
      runtimeStoragePath,
      IMAGE_CONTEXT_CONFIG.enabled, // extractImages
      IMAGE_CONTEXT_CONFIG.enabled, // describeImages
      fallbackUseOCR, // useOCR option
    )
    recordWorkerPhase("standard_processor_done", {
      fileId,
      fileName: file.fileName,
      resultsCount: processingResults.length,
    })
    Logger.info(
      {
        fileId,
        fileName: file.fileName,
        resultsCount: processingResults.length,
      },
      "Standard file processor completed",
    )

    // A single file can yield multiple results (e.g. one per spreadsheet sheet).
    let totalChunksCount = 0
    let newVespaDocId = ""
    const firstResult = processingResults[0]
    if (firstResult && "totalSheets" in firstResult) {
      newVespaDocId = `${file.vespaDocId}_sheet_${(firstResult as SheetProcessingResult).totalSheets}`
    } else {
      newVespaDocId = file.vespaDocId
    }
    for (const [resultIndex, processingResult] of processingResults.entries()) {
      let vespaFileName = buildVespaFileName(file)

      let docId = file.vespaDocId
      if ("sheetName" in processingResult) {
        const sheetResult = processingResult as SheetProcessingResult
        vespaFileName =
          processingResults.length > 1
            ? `${vespaFileName} / ${sheetResult.sheetName}`
            : vespaFileName
        docId = sheetResult.docId
      } else if (processingResults.length > 1) {
        vespaFileName = `${vespaFileName} (${resultIndex + 1})`
        docId = `${file.vespaDocId}_${resultIndex}`
      }

      const vespaDoc = {
        docId: docId,
        clId: file.collectionId,
        itemId: file.id,
        fileName: vespaFileName,
        app: Apps.KnowledgeBase as const,
        entity: KnowledgeBaseEntity.File,
        description: "",
        storagePath: file.storagePath,
        chunks: processingResult.chunks,
        chunks_pos: processingResult.chunks_pos,
        image_chunks: processingResult.image_chunks,
        image_chunks_pos: processingResult.image_chunks_pos,
        toc_chunks: processingResult.toc_chunks || [],
        chunks_map: processingResult.chunks_map?.map((meta) =>
          mapChunkMeta(meta, true),
        ),
        image_chunks_map: processingResult.image_chunks_map?.map((meta) =>
          mapChunkMeta(meta, false),
        ),
        pageTitle: pageTitle,
        documentOutline: processingResult.documentOutline,
        metadata: JSON.stringify(
          mergeCollectionItemMetadata(file.metadata, {
            originalFileName: file.originalName || file.fileName,
            uploadedBy: file.uploadedByEmail || "system",
            chunksCount:
              processingResult.chunks.length +
              processingResult.image_chunks.length,
            imageChunksCount: processingResult.image_chunks.length,
            tocChunksCount: (processingResult.toc_chunks || []).length,
            processingMethod: getBaseMimeType(file.mimeType || "text/plain"),
            ...(processingResult.processingMethod && {
              pdfProcessingMethod: processingResult.processingMethod,
            }),
            ...(pageTitle && { pageTitle }),
            lastModified: Date.now(),
            ...("sheetName" in processingResult && {
              sheetName: (processingResult as SheetProcessingResult).sheetName,
              sheetIndex: (processingResult as SheetProcessingResult)
                .sheetIndex,
              totalSheets: (processingResult as SheetProcessingResult)
                .totalSheets,
            }),
          }),
        ),
        createdBy: file.uploadedByEmail || "system",
        duration: 0,
        mimeType: getBaseMimeType(file.mimeType || "text/plain"),
        fileSize: file.fileSize || 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        clFd: file.parentId,
      }

      recordWorkerPhase("vespa_insert_start", {
        fileId,
        fileName: file.fileName,
        docId,
        resultIndex,
        chunksCount: processingResult.chunks.length,
        imageChunksCount: processingResult.image_chunks.length,
      })
      await insert(vespaDoc, KbItemsSchema)
      recordWorkerPhase("vespa_insert_done", {
        fileId,
        fileName: file.fileName,
        docId,
        resultIndex,
      })

      totalChunksCount +=
        processingResult.chunks.length + processingResult.image_chunks.length
    }

    const chunksCount = totalChunksCount

    // Last result carries the processing-method info for the DB record.
    const lastResult = processingResults[processingResults.length - 1]
    const dbMetadata = mergeCollectionItemMetadata(file.metadata, {
      chunksCount,
      imageChunksCount: processingResults.reduce(
        (sum, r) => sum + r.image_chunks.length,
        0,
      ),
      ...(lastResult?.processingMethod && {
        pdfProcessingMethod: lastResult.processingMethod,
      }),
    })

    recordWorkerPhase("file_completion_update_start", {
      fileId,
      fileName: file.fileName,
      chunksCount,
      newVespaDocId,
    })
    await db
      .update(collectionItems)
      .set({
        vespaDocId: newVespaDocId,
        uploadStatus: UploadStatus.COMPLETED,
        statusMessage: `Successfully processed: ${chunksCount} chunks extracted from ${file.fileName}`,
        metadata: dbMetadata,
        processedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(collectionItems.id, fileId))
    recordWorkerPhase("file_completion_update_done", {
      fileId,
      fileName: file.fileName,
      chunksCount,
      newVespaDocId,
    })

    if (file.parentId) {
      await updateParentStatus(db, file.parentId, false)
    } else {
      await updateParentStatus(db, file.collectionId, true)
    }

    const endTime = Date.now()
    Logger.info(
      `Successfully processed file: ${fileId} in ${endTime - startTime}ms`,
    )
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    recordWorkerPhase("file_processing_failed", {
      fileId,
      fileName: file.fileName,
      error,
      errorMessage,
      elapsedMs: Date.now() - startTime,
    })
    Logger.error(error, `Failed to process file: ${fileId} - ${errorMessage}`)

    await handleRetryFailure(
      fileId,
      file.retryCount || 0,
      errorMessage,
      file.parentId,
      file.collectionId,
    )

    throw error // Let pg-boss handle retries
  }
}
