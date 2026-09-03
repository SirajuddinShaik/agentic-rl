import { beforeEach, describe, expect, mock, test } from "bun:test"

process.env.ENCRYPTION_KEY ??= "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

type MockState = {
  conflictDoNothingConfigs: Array<Record<string, unknown>>
  insertValuesPayloads: unknown[]
  dbReturningQueue: unknown[][]
  dbUpdateWhereClauses: unknown[]
  dbUpdateSetPayloads: unknown[]
  txReturningQueue: unknown[][]
  txUpdateWhereClauses: unknown[]
  txUpdateSetPayloads: unknown[]
  txDeleteWhereClauses: unknown[]
  txInsertValuesPayloads: unknown[]
  executeResultQueue: Array<{ rows: unknown[] }>
  executeQueries: unknown[]
}

const state: MockState = {
  conflictDoNothingConfigs: [],
  insertValuesPayloads: [],
  dbReturningQueue: [],
  dbUpdateWhereClauses: [],
  dbUpdateSetPayloads: [],
  txReturningQueue: [],
  txUpdateWhereClauses: [],
  txUpdateSetPayloads: [],
  txDeleteWhereClauses: [],
  txInsertValuesPayloads: [],
  executeResultQueue: [],
  executeQueries: [],
}

const resetState = () => {
  state.conflictDoNothingConfigs = []
  state.insertValuesPayloads = []
  state.dbReturningQueue = []
  state.dbUpdateWhereClauses = []
  state.dbUpdateSetPayloads = []
  state.txReturningQueue = []
  state.txUpdateWhereClauses = []
  state.txUpdateSetPayloads = []
  state.txDeleteWhereClauses = []
  state.txInsertValuesPayloads = []
  state.executeResultQueue = []
  state.executeQueries = []
}

const createUpdateWhereResult = (queue: unknown[][]) => ({
  returning: async () => queue.shift() || [],
  then: (
    resolve: (value: undefined) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(undefined).then(resolve, reject),
})

const db = {
  execute: async (query: unknown) => {
    state.executeQueries.push(query)
    return state.executeResultQueue.shift() || { rows: [] }
  },
  insert: (_table: unknown) => ({
    values: (payload: unknown) => {
      state.insertValuesPayloads.push(payload)
      return {
        onConflictDoNothing: (config: Record<string, unknown>) => {
          state.conflictDoNothingConfigs.push(config)
          return {
            returning: async () => state.dbReturningQueue.shift() || [],
          }
        },
      }
    },
  }),
  update: (_table: unknown) => ({
    set: (payload: unknown) => {
      state.dbUpdateSetPayloads.push(payload)
      return {
        where: (clause: unknown) => {
          state.dbUpdateWhereClauses.push(clause)
          return createUpdateWhereResult(state.dbReturningQueue)
        },
      }
    },
  }),
  transaction: async (
    callback: (tx: {
      update: (table: unknown) => {
        set: (payload: unknown) => {
          where: (clause: unknown) => {
            returning: () => Promise<unknown[]>
            then: (
              resolve: (value: undefined) => unknown,
              reject?: (reason: unknown) => unknown,
            ) => Promise<unknown>
          }
        }
      }
      delete: (table: unknown) => {
        where: (clause: unknown) => Promise<void>
      }
      insert: (table: unknown) => {
        values: (payload: unknown) => Promise<void>
      }
    }) => Promise<unknown>,
  ) =>
    callback({
      update: (_table: unknown) => ({
        set: (payload: unknown) => {
          state.txUpdateSetPayloads.push(payload)
          return {
            where: (clause: unknown) => {
              state.txUpdateWhereClauses.push(clause)
              return createUpdateWhereResult(state.txReturningQueue)
            },
          }
        },
      }),
      delete: (_table: unknown) => ({
        where: async (clause: unknown) => {
          state.txDeleteWhereClauses.push(clause)
        },
      }),
      insert: (_table: unknown) => ({
        values: async (payload: unknown) => {
          state.txInsertValuesPayloads.push(payload)
        },
      }),
    }),
}

mock.module("@/platform/db/client", () => ({ db }))

const {
  admitDoclingOcrFiles,
  claimDoclingPartsForSubmitBatch,
  claimNextDoclingPartForSubmit,
  getDoclingOcrPageCounters,
  listDeletedActiveDoclingFileIds,
  listLiveDoclingCurrentJobIds,
  listLiveDoclingSubmitPermitIds,
  markDoclingFileCompleted,
  markDoclingFileSplitComplete,
  markDoclingFileSplitRetry,
  markDoclingPartSubmitRetry,
  releaseClaimedDoclingPartForSubmitCapacity,
  upsertDoclingAsyncFileForSplit,
} = await import("@/ingestion/docling/scheduler/store")

const renderSql = (query: unknown) =>
  (
    query as {
      toQuery: (dialect: {
        escapeName: (name: string) => string
        escapeParam: (index: number, value: unknown) => string
        escapeString: (value: string) => string
        casing: { getColumnCasing: (column: { name: string }) => string }
      }) => { sql: string; params: unknown[] }
    }
  ).toQuery({
    escapeName: (name) => name,
    escapeParam: () => "?",
    escapeString: (value) => `'${value.replaceAll("'", "''")}'`,
    casing: {
      getColumnCasing: (column) => column.name,
    },
  })

beforeEach(() => {
  resetState()
})

describe("Docling scheduler store", () => {
  test("ignores duplicate file enqueues instead of rewriting active rows", async () => {
    await upsertDoclingAsyncFileForSplit({
      fileId: "file-1",
      vespaDocId: "vespa-file-1",
      collectionId: "collection-1",
      collectionName: "Collection One",
      fileName: "report.pdf",
      sourcePath: "workspace-1/collection-1/2026/05/report.pdf",
      sourceStorageKey: "workspace-1/collection-1/2026/05/report.pdf",
      path: "/Collection One/report.pdf",
      mimeType: "application/pdf",
      fileSize: 1024,
      totalPages: 0,
      totalParts: 0,
      pageChunkSize: 50,
    })

    expect(state.conflictDoNothingConfigs).toHaveLength(1)
    expect(state.insertValuesPayloads[0]).toMatchObject({
      fileId: "file-1",
      vespaDocId: "vespa-file-1",
      collectionId: "collection-1",
      collectionName: "Collection One",
      fileName: "report.pdf",
      sourcePath: "workspace-1/collection-1/2026/05/report.pdf",
      sourceStorageKey: "workspace-1/collection-1/2026/05/report.pdf",
      path: "/Collection One/report.pdf",
      mimeType: "application/pdf",
      baseMimeType: "application/pdf",
      fileSize: 1024,
      pageChunkSize: 50,
    })
    expect(state.insertValuesPayloads[0]).toMatchObject({
      metadata: {},
      sourceKind: "ingestion",
      pageTitle: "",
    })
  })

  test("split completion is fenced by an active lease", async () => {
    state.txReturningQueue.push([])

    const committed = await markDoclingFileSplitComplete(
      {
        fileId: "file-1",
        leaseOwner: "splitter-1",
      } as never,
      {
        fileId: "file-1",
        vespaDocId: "vespa-1",
        sourcePath: "workspace-1/collection-1/2026/05/report.pdf",
        sourceSize: 128,
        sourceMtimeMs: Date.now(),
        fileName: "report.pdf",
        totalPages: 10,
        pageChunkSize: 5,
        partsTotal: 2,
        stageDir: "/tmp/stage/file-1/run-1",
        partsDir: "/tmp/stage/file-1/run-1/parts",
        manifestPath: "/tmp/stage/file-1/run-1/manifest.json",
        parts: [],
      },
      "/tmp/stage/file-1/run-1/results",
    )

    expect(committed).toBe(false)
    expect(state.txDeleteWhereClauses).toHaveLength(0)
    expect(state.txInsertValuesPayloads).toHaveLength(0)

    const leaseGuard = renderSql(state.txUpdateWhereClauses[0]!)
    expect(leaseGuard.sql).toContain("lease_owner")
    expect(leaseGuard.sql).toContain("lease_until")
    expect(leaseGuard.sql).toContain("NOW()")
  })

  test("split completion stores explicit page counts for OCR parts", async () => {
    state.txReturningQueue.push([{ fileId: "file-1" }])

    const committed = await markDoclingFileSplitComplete(
      {
        fileId: "file-1",
        leaseOwner: "splitter-1",
      } as never,
      {
        fileId: "file-1",
        vespaDocId: "vespa-1",
        sourcePath: "workspace-1/collection-1/2026/05/report.pdf",
        sourceSize: 128,
        sourceMtimeMs: Date.now(),
        fileName: "report.pdf",
        totalPages: 10,
        pageChunkSize: 5,
        partsTotal: 1,
        stageDir: "/tmp/stage/file-1/run-1",
        partsDir: "/tmp/stage/file-1/run-1/parts",
        manifestPath: "/tmp/stage/file-1/run-1/manifest.json",
        parts: [
          {
            partIndex: 0,
            partDocId: "part-doc-1",
            partPath: "/tmp/stage/file-1/run-1/parts/00000.pdf",
            startPage: 0,
            endPage: 5,
            totalPages: 10,
            partFileName: "report.pdf.part-0.pdf",
            partSizeBytes: 100,
          },
        ],
      },
      "/tmp/stage/file-1/run-1/results",
    )

    expect(committed).toBe(true)
    expect(state.txInsertValuesPayloads[0]).toMatchObject([
      {
        pageCount: 5,
      },
    ])
  })

  test("split retry increments split attempt count", async () => {
    state.dbReturningQueue.push([{ fileId: "file-1" }])

    const retried = await markDoclingFileSplitRetry(
      {
        fileId: "file-1",
        leaseOwner: "splitter-1",
        leaseToken: "lease-token-1",
      } as never,
      "qpdf failed",
      new Date("2026-05-20T00:00:00.000Z"),
    )

    expect(retried).toBe(true)
    expect(state.dbUpdateSetPayloads[0]).toMatchObject({
      status: "pending_split",
      errorMessage: "qpdf failed",
      leaseOwner: null,
      leaseToken: null,
      leaseUntil: null,
    })
    expect(state.dbUpdateSetPayloads[0]).toHaveProperty("splitAttemptCount")
  })

  test("write completion is fenced by an active lease", async () => {
    state.txReturningQueue.push([])

    const committed = await markDoclingFileCompleted({
      fileId: "file-1",
      vespaDocId: "vespa-1",
      statusMessage: "done",
      metadata: {},
      leaseOwner: "writer-1",
    })

    expect(committed).toBe(false)

    const leaseGuard = renderSql(state.txUpdateWhereClauses[0]!)
    expect(leaseGuard.sql).toContain("lease_owner")
    expect(leaseGuard.sql).toContain("lease_until")
    expect(leaseGuard.sql).toContain("NOW()")
  })

  test("submit retry only requeues active submissions", async () => {
    await markDoclingPartSubmitRetry({
      fileId: "file-1",
      partIndex: 0,
      jobId: "docling:file-1:part:0:attempt:1",
      errorMessage: "submit failed",
      availableAt: new Date("2026-05-20T00:00:00.000Z"),
    })

    const query = renderSql(state.executeQueries[0]!)
    expect(query.sql).toContain("status IN (?, ?)")
    expect(query.sql).toContain("submitted_at = NULL")
    expect(query.sql).toContain("ready_at = NULL")
    expect(query.sql).toContain("result_path = NULL")
    expect(query.params).toContain("submitting")
    expect(query.params).toContain("submitted")
  })

  test("page counters use explicit part state mapping", async () => {
    await getDoclingOcrPageCounters()

    const query = renderSql(state.executeQueries[0]!)
    expect(query.sql).toContain("pending_ocr_pages")
    expect(query.sql).toContain("active_ocr_pages")
    expect(query.sql).toContain("admitted_ocr_pages")
    expect(query.sql).toContain("completed_ocr_pages_per_minute")
    expect(query.params).toContain("queued_for_ocr")
    expect(query.params).toContain("ocr_active")
    expect(query.params).toContain("submitting")
    expect(query.params).toContain("submitted")
  })

  test("OCR file admission is page-budget aware", async () => {
    await admitDoclingOcrFiles({
      activeFileLimit: 10,
      admittedPageBudget: 4000,
    })

    const query = renderSql(state.executeQueries[0]!)
    expect(query.sql).toContain("admitted_pages")
    expect(query.sql).toContain("cumulative_pages")
    expect(query.sql).toContain("deleted_at IS NULL")
    expect(query.sql).toContain("active_files = 0")
    expect(query.params).toContain(4000)
  })

  test("OCR part claim is global page-budget aware", async () => {
    await claimNextDoclingPartForSubmit({
      workerId: "submitter-test",
      permitId: "permit-test",
      leaseMs: 30000,
      perFileInflightPages: 5000,
      admittedPageBudget: 1000,
    })

    const query = renderSql(state.executeQueries[0]!)
    expect(query.sql).toContain("pg_try_advisory_xact_lock")
    expect(query.sql).toContain("ocr_page_budget_lock.locked")
    expect(query.sql).toContain("global_active_pages")
    expect(query.sql).toContain(
      "global_active_pages + cumulative_selected_pages <= ?",
    )
    expect(query.sql).toContain("deleted_at IS NULL")
    expect(query.sql).toContain("submitted_at = NULL")
    expect(query.sql).toContain("ready_at = NULL")
    expect(query.sql).toContain("result_path = NULL")
    expect(query.params).toContain(1000)
    expect(query.params).toContain(5000)
  })

  test("batched OCR part claim uses non-blocking advisory lock and assigns permit ids", async () => {
    await claimDoclingPartsForSubmitBatch({
      workerId: "submitter-batch",
      permitIds: ["permit-1", "permit-2", "permit-3"],
      leaseMs: 30000,
      perFileInflightPages: 5000,
      admittedPageBudget: 1000,
      maxParts: 3,
    })

    const query = renderSql(state.executeQueries[0]!)
    expect(query.sql).toContain("pg_try_advisory_xact_lock")
    expect(query.sql).toContain("ocr_page_budget_lock.locked")
    expect(query.sql).toContain("VALUES")
    expect(query.sql).toContain("permit_id")
    expect(query.sql).toContain("selected_permits")
    expect(query.params).toContain("permit-1")
    expect(query.params).toContain("permit-2")
    expect(query.params).toContain("permit-3")
  })

  test("batched OCR part claim excludes deleted collection items and enforces budgets", async () => {
    await claimDoclingPartsForSubmitBatch({
      workerId: "submitter-batch",
      permitIds: ["permit-1", "permit-2"],
      leaseMs: 30000,
      perFileInflightPages: 250,
      admittedPageBudget: 875,
      maxParts: 2,
    })

    const query = renderSql(state.executeQueries[0]!)
    expect(query.sql).toContain("deleted_at IS NULL")
    expect(query.sql).toContain("active_pages_by_file")
    expect(query.sql).toContain("candidate_files")
    expect(query.sql).toContain("JOIN LATERAL")
    expect(query.sql).toContain("ORDER BY p.part_index ASC")
    expect(query.sql).toContain("LIMIT 1")
    expect(query.sql).toContain("cumulative_selected_pages")
    expect(query.sql).toContain("cf.active_pages + next_part.page_count <= ?")
    expect(query.sql).toContain(
      "global_active_pages + cumulative_selected_pages <= ?",
    )
    expect(query.params).toContain(250)
    expect(query.params).toContain(875)
  })

  test("batched OCR part claim clears stale submit state like single claim", async () => {
    await claimDoclingPartsForSubmitBatch({
      workerId: "submitter-batch",
      permitIds: ["permit-1"],
      leaseMs: 30000,
      perFileInflightPages: 5000,
      admittedPageBudget: 1000,
      maxParts: 1,
    })

    const query = renderSql(state.executeQueries[0]!)
    expect(query.sql).toContain("submitted_at = NULL")
    expect(query.sql).toContain("ready_at = NULL")
    expect(query.sql).toContain("result_path = NULL")
    expect(query.sql).toContain("error_message = NULL")
  })

  test("deleted collection items can be listed for scheduler cleanup", async () => {
    await listDeletedActiveDoclingFileIds(25)

    const query = renderSql(state.executeQueries[0]!)
    expect(query.sql).toContain("deleted_at IS NOT NULL")
    expect(query.sql).toContain("status NOT IN (?, ?)")
    expect(query.params).toContain("completed")
    expect(query.params).toContain("failed")
  })

  test("capacity requeue clears claimed submit state without keeping attempt increment", async () => {
    await releaseClaimedDoclingPartForSubmitCapacity({
      fileId: "00000000-0000-0000-0000-000000000001",
      partIndex: 0,
      jobId: "docling:00000000-0000-0000-0000-000000000001:part:0:attempt:test",
      errorMessage: "OCR page admission budget is full",
      availableAt: new Date("2026-01-01T00:00:00Z"),
    })

    const query = renderSql(state.executeQueries[0]!)
    expect(query.sql).toContain(
      "attempt_count = GREATEST(attempt_count - 1, 0)",
    )
    expect(query.sql).toContain("current_job_id = NULL")
    expect(query.sql).toContain("submit_permit_id = NULL")
  })

  test("live submit permit lookup only counts active OCR submissions", async () => {
    state.executeResultQueue.push({
      rows: [{ submit_permit_id: "permit-live" }],
    })

    const livePermitIds = await listLiveDoclingSubmitPermitIds([
      "permit-live",
      "permit-orphan",
    ])

    expect(livePermitIds).toEqual(new Set(["permit-live"]))
    const query = renderSql(state.executeQueries[0]!)
    expect(query.sql).toContain("submit_permit_id IN")
    expect(query.sql).toContain("status IN (?, ?)")
    expect(query.params).toContain("permit-live")
    expect(query.params).toContain("permit-orphan")
    expect(query.params).toContain("submitting")
    expect(query.params).toContain("submitted")
  })

  test("live wrapper job lookup only counts active OCR submissions", async () => {
    state.executeResultQueue.push({
      rows: [{ current_job_id: "job-live" }],
    })

    const liveJobIds = await listLiveDoclingCurrentJobIds([
      "job-live",
      "job-stale",
    ])

    expect(liveJobIds).toEqual(new Set(["job-live"]))
    const query = renderSql(state.executeQueries[0]!)
    expect(query.sql).toContain("current_job_id IN")
    expect(query.sql).toContain("status IN (?, ?)")
    expect(query.params).toContain("job-live")
    expect(query.params).toContain("job-stale")
    expect(query.params).toContain("submitting")
    expect(query.params).toContain("submitted")
  })
})
