import { randomUUID } from "node:crypto"
import { db } from "@/platform/db/client"
import {
  type DoclingAsyncFile,
  type DoclingAsyncPart,
  collectionItems,
  doclingAsyncFiles,
  doclingAsyncParts,
} from "@/platform/db/schema"
import type { DoclingStagedParts } from "@/platform/common/pdf/pdfProcessor"
import { UploadStatus } from "@/platform/shared/types"
import { and, eq, sql } from "drizzle-orm"

export const DOCLING_FILE_STATUS = {
  PendingSplit: "pending_split",
  Splitting: "splitting",
  QueuedForOcr: "queued_for_ocr",
  OcrActive: "ocr_active",
  ReadyToWrite: "ready_to_write",
  Writing: "writing",
  Completed: "completed",
  Failed: "failed",
} as const

export const DOCLING_PART_STATUS = {
  Queued: "queued",
  Submitting: "submitting",
  Submitted: "submitted",
  Ready: "ready",
  Written: "written",
  Failed: "failed",
} as const

type RawFileRow = Record<string, unknown>
type RawPartRow = Record<string, unknown>

const dateOrNull = (value: unknown): Date | null =>
  value instanceof Date ? value : value ? new Date(String(value)) : null

const numberValue = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const objectValue = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const baseMimeType = (value: string | null | undefined): string => {
  if (!value) {
    return "application/pdf"
  }
  return value.split(";")[0]?.trim() || "application/pdf"
}

const fileFromRow = (row: RawFileRow): DoclingAsyncFile => ({
  fileId: String(row.file_id),
  vespaDocId: String(row.vespa_doc_id),
  collectionId: String(row.collection_id),
  parentId: row.parent_id ? String(row.parent_id) : null,
  collectionName: String(row.collection_name),
  fileName: String(row.file_name),
  originalName: row.original_name ? String(row.original_name) : null,
  sourcePath: String(row.source_path),
  sourceStorageKey: row.source_storage_key
    ? String(row.source_storage_key)
    : null,
  stageDir: row.stage_dir ? String(row.stage_dir) : null,
  partsDir: row.parts_dir ? String(row.parts_dir) : null,
  resultsDir: row.results_dir ? String(row.results_dir) : null,
  manifestPath: row.manifest_path ? String(row.manifest_path) : null,
  path: String(row.path ?? "/"),
  mimeType: String(row.mime_type ?? "application/pdf"),
  baseMimeType: String(row.base_mime_type ?? "application/pdf"),
  fileSize: numberValue(row.file_size),
  uploadedByEmail: row.uploaded_by_email ? String(row.uploaded_by_email) : null,
  pageTitle: String(row.page_title ?? ""),
  metadata: objectValue(row.metadata),
  sourceKind: String(row.source_kind ?? "ingestion"),
  basePriority: numberValue(row.base_priority),
  priorityOverride:
    row.priority_override === null || row.priority_override === undefined
      ? null
      : numberValue(row.priority_override),
  effectivePriority: numberValue(row.effective_priority, numberValue(row.base_priority)),
  status: String(row.status),
  totalPages: numberValue(row.total_pages),
  totalParts: numberValue(row.total_parts),
  pageChunkSize: numberValue(row.page_chunk_size),
  readyPartsCount: numberValue(row.ready_parts_count),
  submittedPartsCount: numberValue(row.submitted_parts_count),
  activePartsCount: numberValue(row.active_parts_count),
  splitAttemptCount: numberValue(row.split_attempt_count),
  writeAttemptCount: numberValue(row.write_attempt_count),
  availableAt: dateOrNull(row.available_at) || new Date(),
  leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
  leaseToken: row.lease_token ? String(row.lease_token) : null,
  leaseUntil: dateOrNull(row.lease_until),
  ocrActivatedAt: dateOrNull(row.ocr_activated_at),
  completedAt: dateOrNull(row.completed_at),
  errorMessage: row.error_message ? String(row.error_message) : null,
  createdAt: dateOrNull(row.created_at) || new Date(),
  updatedAt: dateOrNull(row.updated_at) || new Date(),
})

const partFromRow = (row: RawPartRow): DoclingAsyncPart => ({
  fileId: String(row.file_id),
  partIndex: numberValue(row.part_index),
  docId: String(row.doc_id),
  currentJobId: row.current_job_id ? String(row.current_job_id) : null,
  partPath: String(row.part_path),
  resultPath: row.result_path ? String(row.result_path) : null,
  startPage: numberValue(row.start_page),
  endPage: numberValue(row.end_page),
  pageCount: numberValue(
    row.page_count,
    Math.max(numberValue(row.end_page) - numberValue(row.start_page), 0),
  ),
  partSizeBytes: numberValue(row.part_size_bytes),
  status: String(row.status),
  attemptCount: numberValue(row.attempt_count),
  availableAt: dateOrNull(row.available_at) || new Date(),
  submittedAt: dateOrNull(row.submitted_at),
  readyAt: dateOrNull(row.ready_at),
  writtenAt: dateOrNull(row.written_at),
  leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
  leaseUntil: dateOrNull(row.lease_until),
  submitPermitId: row.submit_permit_id ? String(row.submit_permit_id) : null,
  errorMessage: row.error_message ? String(row.error_message) : null,
  createdAt: dateOrNull(row.created_at) || new Date(),
  updatedAt: dateOrNull(row.updated_at) || new Date(),
})

const firstRow = <T>(result: { rows?: T[] } | T[]): T | null => {
  const rows = Array.isArray(result) ? result : result.rows || []
  return rows[0] || null
}

const allRows = <T>(result: { rows?: T[] } | T[]): T[] =>
  Array.isArray(result) ? result : result.rows || []

const leaseInterval = (leaseMs: number) =>
  sql.raw(`(${Math.max(leaseMs, 1)} || ' milliseconds')::interval`)

const timestampParam = (date: Date) => sql`${date.toISOString()}::timestamptz`

const sqlStringList = (values: string[]) =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )

export const inferDoclingSourcePriority = (input: {
  collectionId: string
  parentId?: string | null
  metadata?: unknown
}) => {
  const metadata =
    typeof input.metadata === "object" && input.metadata !== null
      ? (input.metadata as Record<string, unknown>)
      : {}
  const explicitKind =
    typeof metadata.doclingSourceKind === "string"
      ? metadata.doclingSourceKind
      : null
  const sourceKind =
    explicitKind ||
    (input.collectionId.startsWith("attachments_") ? "attachment" : "ingestion")
  const basePriority = sourceKind === "attachment" ? 100 : 0

  return { sourceKind, basePriority }
}

export const upsertDoclingAsyncFileForSplit = async (input: {
  fileId: string
  vespaDocId: string
  collectionId: string
  parentId?: string | null | undefined
  collectionName: string
  fileName: string
  originalName?: string | null | undefined
  sourcePath: string
  sourceStorageKey?: string | null | undefined
  path?: string | null | undefined
  mimeType?: string | null | undefined
  fileSize?: number | null | undefined
  uploadedByEmail?: string | null | undefined
  pageTitle?: string | null | undefined
  metadata?: unknown
  sourceKind?: string | null | undefined
  basePriority?: number | undefined
  priorityOverride?: number | null | undefined
  totalPages?: number | undefined
  totalParts?: number | undefined
  pageChunkSize?: number | undefined
}) => {
  const basePriority = input.basePriority ?? 0
  const mimeType = input.mimeType || "application/pdf"

  const [row] = await db
    .insert(doclingAsyncFiles)
    .values({
      fileId: input.fileId,
      vespaDocId: input.vespaDocId,
      collectionId: input.collectionId,
      parentId: input.parentId ?? null,
      collectionName: input.collectionName,
      fileName: input.fileName,
      originalName: input.originalName ?? null,
      sourcePath: input.sourcePath,
      sourceStorageKey: input.sourceStorageKey || null,
      path: input.path || "/",
      mimeType,
      baseMimeType: baseMimeType(mimeType),
      fileSize: input.fileSize ?? 0,
      uploadedByEmail: input.uploadedByEmail ?? null,
      pageTitle: input.pageTitle ?? "",
      metadata: objectValue(input.metadata),
      sourceKind: input.sourceKind ?? "ingestion",
      basePriority,
      priorityOverride: input.priorityOverride ?? null,
      totalPages: input.totalPages ?? 0,
      totalParts: input.totalParts ?? 0,
      pageChunkSize: input.pageChunkSize ?? 0,
      status: DOCLING_FILE_STATUS.PendingSplit,
      availableAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing({
      target: doclingAsyncFiles.fileId,
    })
    .returning()

  return row || null
}

export const claimNextDoclingFileToSplit = async (
  workerId: string,
  leaseMs: number,
): Promise<DoclingAsyncFile | null> => {
  const leaseToken = randomUUID()
  const result = await db.execute(sql`
    UPDATE docling_async_files
    SET status = ${DOCLING_FILE_STATUS.Splitting},
        lease_owner = ${workerId},
        lease_token = ${leaseToken},
        lease_until = NOW() + ${leaseInterval(leaseMs)},
        updated_at = NOW(),
        error_message = NULL
    WHERE file_id = (
      SELECT file_id
      FROM docling_async_files
      WHERE status = ${DOCLING_FILE_STATUS.PendingSplit}
        AND available_at <= NOW()
      ORDER BY COALESCE(priority_override, base_priority) DESC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `)
  const row = firstRow<RawFileRow>(result)
  return row ? fileFromRow(row) : null
}

export const markDoclingFileSplitComplete = async (
  file: DoclingAsyncFile,
  stagedParts: DoclingStagedParts,
  resultsDir: string,
): Promise<boolean> => {
  return await db.transaction(async (tx) => {
    const [claimedFile] = await tx
      .update(doclingAsyncFiles)
      .set({
        status: DOCLING_FILE_STATUS.QueuedForOcr,
        totalPages: stagedParts.totalPages,
        totalParts: stagedParts.partsTotal,
        pageChunkSize: stagedParts.pageChunkSize,
        stageDir: stagedParts.stageDir,
        resultsDir,
        readyPartsCount: 0,
        leaseOwner: null,
        leaseToken: null,
        leaseUntil: null,
        availableAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(doclingAsyncFiles.fileId, file.fileId),
          eq(doclingAsyncFiles.status, DOCLING_FILE_STATUS.Splitting),
          sql`${doclingAsyncFiles.leaseOwner} = ${file.leaseOwner}`,
          sql`${doclingAsyncFiles.leaseToken} = ${file.leaseToken}`,
          sql`${doclingAsyncFiles.leaseUntil} IS NOT NULL AND ${doclingAsyncFiles.leaseUntil} >= NOW()`,
        ),
      )
      .returning({ fileId: doclingAsyncFiles.fileId })

    if (!claimedFile) {
      return false
    }

    await tx
      .delete(doclingAsyncParts)
      .where(eq(doclingAsyncParts.fileId, file.fileId))

    await tx.insert(doclingAsyncParts).values(
      stagedParts.parts.map((part) => ({
        fileId: file.fileId,
        partIndex: part.partIndex,
        docId: part.partDocId,
        partPath: part.partPath,
        startPage: part.startPage,
        endPage: part.endPage,
        pageCount: Math.max(part.endPage - part.startPage, 0),
        partSizeBytes: part.partSizeBytes,
        status: DOCLING_PART_STATUS.Queued,
        availableAt: new Date(),
      })),
    )

    return true
  })
}

export const markDoclingFileSplitRetry = async (
  file: DoclingAsyncFile,
  errorMessage: string,
  availableAt: Date,
) => {
  const [row] = await db
    .update(doclingAsyncFiles)
    .set({
      status: DOCLING_FILE_STATUS.PendingSplit,
      availableAt,
      splitAttemptCount: sql`${doclingAsyncFiles.splitAttemptCount} + 1`,
      leaseOwner: null,
      leaseToken: null,
      leaseUntil: null,
      errorMessage,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(doclingAsyncFiles.fileId, file.fileId),
        eq(doclingAsyncFiles.status, DOCLING_FILE_STATUS.Splitting),
        sql`${doclingAsyncFiles.leaseOwner} = ${file.leaseOwner}`,
        sql`${doclingAsyncFiles.leaseToken} = ${file.leaseToken}`,
        sql`${doclingAsyncFiles.leaseUntil} IS NOT NULL AND ${doclingAsyncFiles.leaseUntil} >= NOW()`,
      ),
    )
    .returning({ fileId: doclingAsyncFiles.fileId })
  return Boolean(row)
}

export type DoclingOcrPageCounters = {
  pendingOcrPages: number
  activeOcrPages: number
  activeOcrChunks: number
  admittedOcrPages: number
  completedOcrPagesPerMinute: number
}

export const getDoclingOcrPageCounters =
  async (): Promise<DoclingOcrPageCounters> => {
    const result = await db.execute(sql`
      SELECT
        COALESCE(SUM(
          CASE
            WHEN p.status = ${DOCLING_PART_STATUS.Queued}
              AND f.status IN (${DOCLING_FILE_STATUS.QueuedForOcr}, ${DOCLING_FILE_STATUS.OcrActive})
            THEN COALESCE(p.page_count, GREATEST(p.end_page - p.start_page, 0))
            ELSE 0
          END
        ), 0)::int AS pending_ocr_pages,
        COALESCE(SUM(
          CASE
            WHEN p.status IN (${DOCLING_PART_STATUS.Submitting}, ${DOCLING_PART_STATUS.Submitted})
            THEN COALESCE(p.page_count, GREATEST(p.end_page - p.start_page, 0))
            ELSE 0
          END
        ), 0)::int AS active_ocr_pages,
        COALESCE(COUNT(*) FILTER (
          WHERE p.status IN (${DOCLING_PART_STATUS.Submitting}, ${DOCLING_PART_STATUS.Submitted})
        ), 0)::int AS active_ocr_chunks,
        COALESCE(SUM(
          CASE
            WHEN f.status = ${DOCLING_FILE_STATUS.OcrActive}
              AND p.status IN (${DOCLING_PART_STATUS.Queued}, ${DOCLING_PART_STATUS.Submitting}, ${DOCLING_PART_STATUS.Submitted})
            THEN COALESCE(p.page_count, GREATEST(p.end_page - p.start_page, 0))
            ELSE 0
          END
        ), 0)::int AS admitted_ocr_pages,
        COALESCE(SUM(
          CASE
            WHEN p.ready_at IS NOT NULL
              AND p.ready_at >= NOW() - INTERVAL '1 minute'
            THEN COALESCE(p.page_count, GREATEST(p.end_page - p.start_page, 0))
            ELSE 0
          END
        ), 0)::int AS completed_ocr_pages_per_minute
      FROM docling_async_parts p
      JOIN docling_async_files f ON f.file_id = p.file_id
    `)

    const row = firstRow<RawPartRow>(result) || {}
    return {
      pendingOcrPages: numberValue(row.pending_ocr_pages),
      activeOcrPages: numberValue(row.active_ocr_pages),
      activeOcrChunks: numberValue(row.active_ocr_chunks),
      admittedOcrPages: numberValue(row.admitted_ocr_pages),
      completedOcrPagesPerMinute: numberValue(
        row.completed_ocr_pages_per_minute,
      ),
    }
  }

export const admitDoclingOcrFiles = async (input: {
  activeFileLimit: number
  admittedPageBudget: number
}): Promise<number> => {
  if (input.activeFileLimit <= 0 || input.admittedPageBudget <= 0) {
    return 0
  }

  const result = await db.execute(sql`
    WITH admit_lock AS (
      SELECT pg_try_advisory_xact_lock(hashtext('docling_ocr_file_admit')) AS locked
    ),
    active_state AS (
      SELECT
        COUNT(DISTINCT f.file_id)::int AS active_files,
        COALESCE(SUM(
          CASE
            WHEN p.status IN (${DOCLING_PART_STATUS.Queued}, ${DOCLING_PART_STATUS.Submitting}, ${DOCLING_PART_STATUS.Submitted})
            THEN COALESCE(p.page_count, GREATEST(p.end_page - p.start_page, 0))
            ELSE 0
          END
        ), 0)::int AS admitted_pages
      FROM docling_async_files f
      LEFT JOIN docling_async_parts p
        ON p.file_id = f.file_id
      WHERE f.status = ${DOCLING_FILE_STATUS.OcrActive}
    ),
    capacity AS (
      SELECT
        GREATEST(${input.activeFileLimit} - active_files, 0)::int AS slots,
        GREATEST(${input.admittedPageBudget} - admitted_pages, 0)::int AS pages,
        active_files,
        admitted_pages
      FROM active_state
    ),
    available_files AS (
      SELECT
        f.file_id,
        f.total_pages,
        COALESCE(f.priority_override, f.base_priority) AS file_priority,
        f.created_at
      FROM docling_async_files f
      CROSS JOIN capacity c
      CROSS JOIN admit_lock l
      JOIN collection_items ci
        ON ci.id = f.file_id
      WHERE f.status = ${DOCLING_FILE_STATUS.QueuedForOcr}
        AND f.available_at <= NOW()
        AND ci.deleted_at IS NULL
        AND l.locked
        AND c.slots > 0
      ORDER BY COALESCE(f.priority_override, f.base_priority) DESC, f.created_at ASC
      FOR UPDATE SKIP LOCKED
    ),
    ranked_files AS (
      SELECT
        file_id,
        total_pages,
        file_priority,
        created_at,
        ROW_NUMBER() OVER (
          ORDER BY file_priority DESC, created_at ASC, file_id ASC
        ) AS queued_rank
      FROM available_files
    ),
    eligible_files AS (
      SELECT r.*
      FROM ranked_files r, capacity cap
      WHERE GREATEST(r.total_pages, 0) <= cap.pages
        OR (
          cap.active_files = 0
          AND cap.admitted_pages = 0
          AND r.queued_rank = 1
        )
    ),
    candidates AS (
      SELECT
        file_id,
        total_pages,
        queued_rank AS rn,
        SUM(GREATEST(total_pages, 0)) OVER (
          ORDER BY file_priority DESC, created_at ASC, file_id ASC
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS cumulative_pages
      FROM eligible_files
    ),
    selected AS (
      SELECT c.file_id
      FROM candidates c, capacity cap
      WHERE c.cumulative_pages <= cap.pages
        OR (
          cap.active_files = 0
          AND cap.admitted_pages = 0
          AND c.rn = 1
        )
      ORDER BY c.rn
      LIMIT (SELECT slots FROM capacity)
    )
    UPDATE docling_async_files f
    SET status = ${DOCLING_FILE_STATUS.OcrActive},
        ocr_activated_at = COALESCE(f.ocr_activated_at, NOW()),
        updated_at = NOW()
    FROM selected
    WHERE f.file_id = selected.file_id
    RETURNING f.file_id
  `)

  return allRows(result).length
}

export const claimNextDoclingPartForSubmit = async (input: {
  workerId: string
  permitId: string
  leaseMs: number
  perFileInflightPages: number
  admittedPageBudget: number
}): Promise<DoclingAsyncPart | null> => {
  const parts = await claimDoclingPartsForSubmitBatch({
    workerId: input.workerId,
    permitIds: [input.permitId],
    leaseMs: input.leaseMs,
    perFileInflightPages: input.perFileInflightPages,
    admittedPageBudget: input.admittedPageBudget,
    maxParts: 1,
  })
  return parts[0] || null
}

export type ClaimDoclingPartsForSubmitBatchInput = {
  workerId: string
  permitIds: string[]
  leaseMs: number
  perFileInflightPages: number
  admittedPageBudget: number
  maxParts: number
}

export const claimDoclingPartsForSubmitBatch = async (
  input: ClaimDoclingPartsForSubmitBatchInput,
): Promise<DoclingAsyncPart[]> => {
  const permitIds = input.permitIds
    .filter((permitId) => permitId.length > 0)
    .slice(0, Math.max(Math.min(input.maxParts, 100), 1))

  if (
    permitIds.length === 0 ||
    input.perFileInflightPages <= 0 ||
    input.admittedPageBudget <= 0
  ) {
    return []
  }

  const attemptToken = randomUUID()
  const permits = sql.join(
    permitIds.map((permitId, index) => sql`(${index + 1}, ${permitId})`),
    sql`, `,
  )

  const result = await db.execute(sql`
    WITH ocr_page_budget_lock AS MATERIALIZED (
      SELECT pg_try_advisory_xact_lock(672945, 42001) AS locked
    ),
    active_pages_by_file AS MATERIALIZED (
      SELECT
        active.file_id,
        SUM(GREATEST(COALESCE(active.page_count, GREATEST(active.end_page - active.start_page, 0)), 1)) AS active_pages
      FROM docling_async_parts active
      WHERE active.status IN (${DOCLING_PART_STATUS.Submitting}, ${DOCLING_PART_STATUS.Submitted})
      GROUP BY active.file_id
    ),
    global_state AS (
      SELECT COALESCE(SUM(active_pages), 0) AS global_active_pages
      FROM active_pages_by_file
    ),
    candidate_files AS MATERIALIZED (
      SELECT
        f.file_id,
        COALESCE(ap.active_pages, 0) AS active_pages,
        gs.global_active_pages,
        COALESCE(f.priority_override, f.base_priority) AS file_priority,
        f.created_at
      FROM docling_async_files f
      CROSS JOIN ocr_page_budget_lock
      CROSS JOIN global_state gs
      LEFT JOIN active_pages_by_file ap ON ap.file_id = f.file_id
      JOIN collection_items ci ON ci.id = f.file_id
      WHERE f.status = ${DOCLING_FILE_STATUS.OcrActive}
        AND ocr_page_budget_lock.locked
        AND ci.deleted_at IS NULL
        AND (
          COALESCE(ap.active_pages, 0) < ${input.perFileInflightPages}
          OR COALESCE(ap.active_pages, 0) = 0
        )
        AND EXISTS (
          SELECT 1
          FROM docling_async_parts queued
          WHERE queued.file_id = f.file_id
            AND queued.status = ${DOCLING_PART_STATUS.Queued}
            AND queued.available_at <= NOW()
        )
      ORDER BY COALESCE(f.priority_override, f.base_priority) DESC, f.created_at ASC, f.file_id ASC
      FOR UPDATE OF f SKIP LOCKED
    ),
    candidate_parts AS (
      SELECT
        cf.file_id,
        next_part.part_index,
        next_part.page_count,
        cf.active_pages,
        cf.global_active_pages,
        cf.file_priority,
        cf.created_at
      FROM candidate_files cf
      JOIN LATERAL (
        SELECT
          p.part_index,
          GREATEST(COALESCE(p.page_count, GREATEST(p.end_page - p.start_page, 0)), 1) AS page_count
        FROM docling_async_parts p
        WHERE p.file_id = cf.file_id
          AND p.status = ${DOCLING_PART_STATUS.Queued}
          AND p.available_at <= NOW()
        ORDER BY p.part_index ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      ) next_part ON true
      WHERE (
        cf.active_pages + next_part.page_count <= ${input.perFileInflightPages}
        OR cf.active_pages = 0
      )
    ),
    eligible AS (
      SELECT *
      FROM candidate_parts
      WHERE (
        global_active_pages + page_count <= ${input.admittedPageBudget}
        OR global_active_pages = 0
      )
    ),
    ranked AS (
      SELECT
        file_id,
        part_index,
        page_count,
        global_active_pages,
        ROW_NUMBER() OVER (
          ORDER BY file_priority DESC, created_at ASC, file_id ASC, part_index ASC
        ) AS selected_rank,
        SUM(page_count) OVER (
          ORDER BY file_priority DESC, created_at ASC, file_id ASC, part_index ASC
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS cumulative_selected_pages
      FROM eligible
    ),
    selected AS (
      SELECT
        file_id,
        part_index,
        selected_rank
      FROM ranked
      WHERE (
          global_active_pages + cumulative_selected_pages <= ${input.admittedPageBudget}
          OR global_active_pages = 0
        )
      ORDER BY selected_rank
      LIMIT ${permitIds.length}
    ),
    selected_permits AS (
      SELECT
        permit_map.selected_rank::bigint AS selected_rank,
        permit_map.permit_id::text AS permit_id
      FROM (
        VALUES
          ${permits}
      ) AS permit_map(selected_rank, permit_id)
    ),
    claimed AS (
      UPDATE docling_async_parts p
      SET status = ${DOCLING_PART_STATUS.Submitting},
          attempt_count = p.attempt_count + 1,
          current_job_id = 'docling:' || p.file_id || ':part:' || p.part_index || ':attempt:' || ${attemptToken} || '-' || selected.selected_rank,
          lease_owner = ${input.workerId},
          lease_until = NOW() + ${leaseInterval(input.leaseMs)},
          submit_permit_id = selected_permits.permit_id,
          submitted_at = NULL,
          ready_at = NULL,
          result_path = NULL,
          error_message = NULL,
          updated_at = NOW()
      FROM selected
      JOIN selected_permits
        ON selected_permits.selected_rank = selected.selected_rank
      WHERE p.file_id = selected.file_id
        AND p.part_index = selected.part_index
        AND p.status = ${DOCLING_PART_STATUS.Queued}
      RETURNING p.*
    )
    SELECT * FROM claimed
    ORDER BY part_index ASC
  `)

  return allRows<RawPartRow>(result).map(partFromRow)
}

export const markDoclingPartSubmitted = async (
  fileId: string,
  partIndex: number,
  jobId: string,
) => {
  await db
    .update(doclingAsyncParts)
    .set({
      status: DOCLING_PART_STATUS.Submitted,
      submittedAt: new Date(),
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(doclingAsyncParts.fileId, fileId),
        eq(doclingAsyncParts.partIndex, partIndex),
        eq(doclingAsyncParts.currentJobId, jobId),
        eq(doclingAsyncParts.status, DOCLING_PART_STATUS.Submitting),
      ),
    )
}

export const markDoclingPartSubmitRetry = async (input: {
  fileId: string
  partIndex: number
  jobId: string
  errorMessage: string
  availableAt: Date
}) => {
  await db.execute(sql`
    UPDATE docling_async_parts
    SET status = ${DOCLING_PART_STATUS.Queued},
        available_at = ${timestampParam(input.availableAt)},
        lease_owner = NULL,
        lease_until = NULL,
        submit_permit_id = NULL,
        submitted_at = NULL,
        ready_at = NULL,
        result_path = NULL,
        error_message = ${input.errorMessage},
        updated_at = NOW()
    WHERE file_id = ${input.fileId}
      AND part_index = ${input.partIndex}
      AND current_job_id = ${input.jobId}
      AND status IN (${DOCLING_PART_STATUS.Submitting}, ${DOCLING_PART_STATUS.Submitted})
  `)
}

export const releaseClaimedDoclingPartForSubmitCapacity = async (input: {
  fileId: string
  partIndex: number
  jobId: string
  errorMessage: string
  availableAt: Date
}) => {
  await db.execute(sql`
    UPDATE docling_async_parts
    SET status = ${DOCLING_PART_STATUS.Queued},
        current_job_id = NULL,
        attempt_count = GREATEST(attempt_count - 1, 0),
        available_at = ${timestampParam(input.availableAt)},
        lease_owner = NULL,
        lease_until = NULL,
        submit_permit_id = NULL,
        error_message = ${input.errorMessage},
        updated_at = NOW()
    WHERE file_id = ${input.fileId}
      AND part_index = ${input.partIndex}
      AND current_job_id = ${input.jobId}
      AND status = ${DOCLING_PART_STATUS.Submitting}
      AND submitted_at IS NULL
  `)
}

export const getDoclingPartByJobId = async (
  jobId: string,
): Promise<DoclingAsyncPart | null> => {
  const result = await db.execute(sql`
    SELECT *
    FROM docling_async_parts
    WHERE current_job_id = ${jobId}
    LIMIT 1
  `)
  const row = firstRow<RawPartRow>(result)
  return row ? partFromRow(row) : null
}

export const getDoclingFile = async (
  fileId: string,
): Promise<DoclingAsyncFile | null> => {
  const result = await db.execute(sql`
    SELECT *
    FROM docling_async_files
    WHERE file_id = ${fileId}
    LIMIT 1
  `)
  const row = firstRow<RawFileRow>(result)
  return row ? fileFromRow(row) : null
}

export const listDeletedActiveDoclingFileIds = async (
  limit = 50,
): Promise<string[]> => {
  const result = await db.execute(sql`
    SELECT f.file_id
    FROM docling_async_files f
    JOIN collection_items ci
      ON ci.id = f.file_id
    WHERE ci.deleted_at IS NOT NULL
      AND f.status NOT IN (${DOCLING_FILE_STATUS.Completed}, ${DOCLING_FILE_STATUS.Failed})
    ORDER BY ci.deleted_at ASC, f.updated_at ASC
    LIMIT ${Math.max(limit, 1)}
  `)
  return allRows<RawFileRow>(result).map((row) => String(row.file_id))
}

export const getDoclingPartsForFile = async (
  fileId: string,
): Promise<DoclingAsyncPart[]> => {
  const result = await db.execute(sql`
    SELECT *
    FROM docling_async_parts
    WHERE file_id = ${fileId}
    ORDER BY part_index ASC
  `)
  return allRows<RawPartRow>(result).map(partFromRow)
}

export const markDoclingPartReady = async (input: {
  fileId: string
  partIndex: number
  jobId: string
  resultPath: string
}) => {
  await db.transaction(async (tx) => {
    const ready = await tx.execute(sql`
      UPDATE docling_async_parts
      SET status = ${DOCLING_PART_STATUS.Ready},
          result_path = ${input.resultPath},
          ready_at = NOW(),
          lease_owner = NULL,
          lease_until = NULL,
          submit_permit_id = NULL,
          updated_at = NOW()
      WHERE file_id = ${input.fileId}
        AND part_index = ${input.partIndex}
        AND current_job_id = ${input.jobId}
        AND status IN (${DOCLING_PART_STATUS.Submitting}, ${DOCLING_PART_STATUS.Submitted})
      RETURNING file_id
    `)

    if (!firstRow(ready)) {
      return
    }

    await tx.execute(sql`
      UPDATE docling_async_files
      SET ready_parts_count = ready_parts_count + 1,
          updated_at = NOW()
      WHERE file_id = ${input.fileId}
    `)

    await tx.execute(sql`
      UPDATE docling_async_files
      SET status = ${DOCLING_FILE_STATUS.ReadyToWrite},
          available_at = NOW(),
          updated_at = NOW()
      WHERE file_id = ${input.fileId}
        AND status = ${DOCLING_FILE_STATUS.OcrActive}
        AND ready_parts_count >= total_parts
    `)
  })
}

export const failDoclingFile = async (fileId: string, errorMessage: string) => {
  await db.transaction(async (tx) => {
    await tx
      .update(doclingAsyncFiles)
      .set({
        status: DOCLING_FILE_STATUS.Failed,
        leaseOwner: null,
        leaseToken: null,
        leaseUntil: null,
        errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(doclingAsyncFiles.fileId, fileId))

    await tx
      .update(doclingAsyncParts)
      .set({
        status: DOCLING_PART_STATUS.Failed,
        errorMessage,
        leaseOwner: null,
        leaseUntil: null,
        submitPermitId: null,
        updatedAt: new Date(),
      })
      .where(eq(doclingAsyncParts.fileId, fileId))

    await tx
      .update(collectionItems)
      .set({
        uploadStatus: UploadStatus.FAILED,
        statusMessage: errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(collectionItems.id, fileId))
  })
}

export const failDoclingFileIfOwned = async (
  file: DoclingAsyncFile,
  expectedStatus: string,
  errorMessage: string,
): Promise<boolean> => {
  return await db.transaction(async (tx) => {
    const [claimedFile] = await tx
      .update(doclingAsyncFiles)
      .set({
        status: DOCLING_FILE_STATUS.Failed,
        leaseOwner: null,
        leaseToken: null,
        leaseUntil: null,
        errorMessage,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(doclingAsyncFiles.fileId, file.fileId),
          eq(doclingAsyncFiles.status, expectedStatus),
          sql`${doclingAsyncFiles.leaseOwner} = ${file.leaseOwner}`,
          sql`${doclingAsyncFiles.leaseToken} = ${file.leaseToken}`,
          sql`${doclingAsyncFiles.leaseUntil} IS NOT NULL AND ${doclingAsyncFiles.leaseUntil} >= NOW()`,
        ),
      )
      .returning({ fileId: doclingAsyncFiles.fileId })

    if (!claimedFile) {
      return false
    }

    await tx
      .update(doclingAsyncParts)
      .set({
        status: DOCLING_PART_STATUS.Failed,
        errorMessage,
        leaseOwner: null,
        leaseUntil: null,
        submitPermitId: null,
        updatedAt: new Date(),
      })
      .where(eq(doclingAsyncParts.fileId, file.fileId))

    await tx
      .update(collectionItems)
      .set({
        uploadStatus: UploadStatus.FAILED,
        statusMessage: errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(collectionItems.id, file.fileId))

    return true
  })
}

export const claimNextDoclingFileToWrite = async (
  workerId: string,
  leaseMs: number,
): Promise<DoclingAsyncFile | null> => {
  const leaseToken = randomUUID()
  const result = await db.execute(sql`
    UPDATE docling_async_files
    SET status = ${DOCLING_FILE_STATUS.Writing},
        lease_owner = ${workerId},
        lease_token = ${leaseToken},
        lease_until = NOW() + ${leaseInterval(leaseMs)},
        write_attempt_count = write_attempt_count + 1,
        updated_at = NOW()
    WHERE file_id = (
      SELECT file_id
      FROM docling_async_files
      WHERE status = ${DOCLING_FILE_STATUS.ReadyToWrite}
        AND available_at <= NOW()
      ORDER BY COALESCE(priority_override, base_priority) DESC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `)
  const row = firstRow<RawFileRow>(result)
  return row ? fileFromRow(row) : null
}

export const markDoclingFileWriteRetry = async (
  file: DoclingAsyncFile,
  errorMessage: string,
  availableAt: Date,
) => {
  const [row] = await db
    .update(doclingAsyncFiles)
    .set({
      status: DOCLING_FILE_STATUS.ReadyToWrite,
      availableAt,
      leaseOwner: null,
      leaseToken: null,
      leaseUntil: null,
      errorMessage,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(doclingAsyncFiles.fileId, file.fileId),
        eq(doclingAsyncFiles.status, DOCLING_FILE_STATUS.Writing),
        sql`${doclingAsyncFiles.leaseOwner} = ${file.leaseOwner}`,
        sql`${doclingAsyncFiles.leaseToken} = ${file.leaseToken}`,
        sql`${doclingAsyncFiles.leaseUntil} IS NOT NULL AND ${doclingAsyncFiles.leaseUntil} >= NOW()`,
      ),
    )
    .returning({ fileId: doclingAsyncFiles.fileId })
  return Boolean(row)
}

export const markDoclingFileCompleted = async (input: {
  fileId: string
  vespaDocId: string
  statusMessage: string
  metadata: Record<string, unknown>
  leaseOwner?: string | null
  leaseToken?: string | null
}): Promise<boolean> => {
  return await db.transaction(async (tx) => {
    const [claimedFile] = await tx
      .update(doclingAsyncFiles)
      .set({
        status: DOCLING_FILE_STATUS.Completed,
        completedAt: new Date(),
        leaseOwner: null,
        leaseToken: null,
        leaseUntil: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(doclingAsyncFiles.fileId, input.fileId),
          eq(doclingAsyncFiles.status, DOCLING_FILE_STATUS.Writing),
          sql`${doclingAsyncFiles.leaseOwner} = ${input.leaseOwner}`,
          sql`${doclingAsyncFiles.leaseToken} = ${input.leaseToken}`,
          sql`${doclingAsyncFiles.leaseUntil} IS NOT NULL AND ${doclingAsyncFiles.leaseUntil} >= NOW()`,
        ),
      )
      .returning({ fileId: doclingAsyncFiles.fileId })

    if (!claimedFile) {
      return false
    }

    await tx
      .update(collectionItems)
      .set({
        vespaDocId: input.vespaDocId,
        uploadStatus: UploadStatus.COMPLETED,
        statusMessage: input.statusMessage,
        metadata: input.metadata,
        processedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(collectionItems.id, input.fileId))

    await tx
      .update(doclingAsyncParts)
      .set({
        status: DOCLING_PART_STATUS.Written,
        writtenAt: new Date(),
        submitPermitId: null,
        updatedAt: new Date(),
      })
      .where(eq(doclingAsyncParts.fileId, input.fileId))

    return true
  })
}

export const requeueExpiredDoclingLeases = async (now = new Date()) => {
  await db.execute(sql`
    UPDATE docling_async_files
    SET status = CASE
          WHEN status = ${DOCLING_FILE_STATUS.Splitting} THEN ${DOCLING_FILE_STATUS.PendingSplit}
          WHEN status = ${DOCLING_FILE_STATUS.Writing} THEN ${DOCLING_FILE_STATUS.ReadyToWrite}
          ELSE status
        END,
        lease_owner = NULL,
        lease_token = NULL,
        lease_until = NULL,
        available_at = ${timestampParam(now)},
        updated_at = NOW()
    WHERE status IN (${DOCLING_FILE_STATUS.Splitting}, ${DOCLING_FILE_STATUS.Writing})
      AND lease_until IS NOT NULL
      AND lease_until < NOW()
  `)

  await db.execute(sql`
    UPDATE docling_async_parts
    SET status = ${DOCLING_PART_STATUS.Queued},
        lease_owner = NULL,
        lease_until = NULL,
        submit_permit_id = NULL,
        available_at = ${timestampParam(now)},
        updated_at = NOW()
    WHERE status = ${DOCLING_PART_STATUS.Submitting}
      AND lease_until IS NOT NULL
      AND lease_until < NOW()
  `)
}

export const listExpiredSubmittingDoclingParts = async (
  limit: number,
): Promise<DoclingAsyncPart[]> => {
  const result = await db.execute(sql`
    SELECT *
    FROM docling_async_parts
    WHERE status = ${DOCLING_PART_STATUS.Submitting}
      AND lease_until IS NOT NULL
      AND lease_until < NOW()
      AND submit_permit_id IS NOT NULL
    ORDER BY lease_until ASC
    LIMIT ${Math.max(limit, 1)}
  `)
  return allRows<RawPartRow>(result).map(partFromRow)
}

export const listTimedOutSubmittedDoclingParts = async (
  timeoutMs: number,
  limit: number,
): Promise<DoclingAsyncPart[]> => {
  const result = await db.execute(sql`
    SELECT *
    FROM docling_async_parts
    WHERE status = ${DOCLING_PART_STATUS.Submitted}
      AND submitted_at IS NOT NULL
      AND submitted_at < NOW() - ${leaseInterval(timeoutMs)}
    ORDER BY submitted_at ASC
    LIMIT ${Math.max(limit, 1)}
  `)
  return allRows<RawPartRow>(result).map(partFromRow)
}

export const listLiveDoclingSubmitPermitIds = async (
  permitIds: string[],
): Promise<Set<string>> => {
  const uniquePermitIds = Array.from(new Set(permitIds.filter(Boolean)))
  if (uniquePermitIds.length === 0) {
    return new Set()
  }

  const result = await db.execute(sql`
    SELECT DISTINCT submit_permit_id
    FROM docling_async_parts
    WHERE submit_permit_id IN (${sqlStringList(uniquePermitIds)})
      AND status IN (${DOCLING_PART_STATUS.Submitting}, ${DOCLING_PART_STATUS.Submitted})
  `)
  return new Set(
    allRows<RawPartRow>(result)
      .map((row) => row.submit_permit_id)
      .filter((permitId): permitId is string => typeof permitId === "string"),
  )
}

export const listLiveDoclingCurrentJobIds = async (
  jobIds: string[],
): Promise<Set<string>> => {
  const uniqueJobIds = Array.from(new Set(jobIds.filter(Boolean)))
  if (uniqueJobIds.length === 0) {
    return new Set()
  }

  const result = await db.execute(sql`
    SELECT DISTINCT current_job_id
    FROM docling_async_parts
    WHERE current_job_id IN (${sqlStringList(uniqueJobIds)})
      AND status IN (${DOCLING_PART_STATUS.Submitting}, ${DOCLING_PART_STATUS.Submitted})
  `)
  return new Set(
    allRows<RawPartRow>(result)
      .map((row) => row.current_job_id)
      .filter((jobId): jobId is string => typeof jobId === "string"),
  )
}
