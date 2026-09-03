import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm"
import { db } from "@/platform/db/client"
import {
  sdkCredentials,
  sdkExecutionStates,
  sdkExecutions,
  sdkFolders,
  sdkResumePayloads,
  sdkStaticData,
  sdkStepEvents,
  sdkStepRecords,
  sdkWebhooks,
  sdkWorkflowCallbacks,
  sdkWorkflows,
} from "@/platform/db/schema/workflowSdk"
import {
  getUserAccessibleWorkflows,
  getUserAccessibleFolders,
  getAccessibleWorkflowCounts,
  grantSdkPermission,
} from "@/platform/db/sdkResourcePermission"
import { SdkResourceRole } from "@/platform/shared/types"
import type {
  ExecutionPauseType,
  ExecutionRecord,
  ExecutionStateRecord,
  FolderRecord,
  PersistenceAdapter,
  ResourceAttributes,
  CredentialRecord,
  StepRecord,
  WebhookRecord,
  WorkflowCallbackRecord,
  WorkflowRecord,
} from "@xyne/workflow-sdk"
import type { AnalyticsSummaryResult } from "@xyne/workflow-sdk/client"
import type { ResumePayload } from "@xyne/workflow-sdk/common"
import { createId } from "@paralleldrive/cuid2"
import type { XyneFilter, XyneResourceAttrs } from "@/app/workflows/acl"

// Credentials have no id column (PK is (workspace_id, name)); the SDK addresses
// them by a single `id`, so we synthesize one and split it back on read.
const credId = (workspaceId: string, name: string): string => `${workspaceId}::${name}`
const splitCredId = (id: string): { workspaceId: string; name: string } => {
  const i = id.indexOf("::")
  return i < 0
    ? { workspaceId: "", name: id }
    : { workspaceId: id.slice(0, i), name: id.slice(i + 2) }
}

// Encode/decode bigint timestamps as base64 strings for cursor pagination.
const encodeCursor = (ms: number): string =>
  Buffer.from(String(ms)).toString("base64")
const decodeCursor = (cursor: string): number =>
  Number(Buffer.from(cursor, "base64").toString())

// Attributes are DERIVED from columns, not stored: workspaceId is the tenant/
// execution scope, isPublic lets the authorizer synthesize a viewer for public
// resources without a second query. createdByUserId is create-time-only and
// deliberately absent here.
const toWorkflowRecord = (r: {
  id: string
  status: string
  config: string | null
  metadata: string | null
  eventType: string
  summary: string | null
  folderId: string
  workspaceId: string
  isPublic: boolean
}): WorkflowRecord => ({
  id: r.id,
  status: r.status,
  config: r.config,
  metadata: r.metadata,
  eventType: r.eventType,
  summary: r.summary,
  folderId: r.folderId,
  attributes: {
    workspaceId: r.workspaceId,
    isPublic: r.isPublic,
  } satisfies XyneResourceAttrs,
})

const toFolderRecord = (r: {
  id: string
  name: string
  metadata: string | null
  parentId: string | null
  workspaceId: string
  isPublic: boolean
}): FolderRecord => ({
  id: r.id,
  name: r.name,
  metadata: r.metadata,
  parentId: r.parentId,
  attributes: {
    workspaceId: r.workspaceId,
    isPublic: r.isPublic,
  } satisfies XyneResourceAttrs,
})

export class DrizzlePersistenceAdapter implements PersistenceAdapter<XyneFilter> {
  // ── Workflow definitions ──────────────────────────────────────────────────

  async getWorkflow(id: string): Promise<WorkflowRecord | null> {
    const rows = await db
      .select()
      .from(sdkWorkflows)
      .where(eq(sdkWorkflows.id, id))
      .limit(1)
    return rows[0] ? toWorkflowRecord(rows[0]) : null
  }

  async listWorkflows(
    filter: XyneFilter,
    page?: { folderId?: string; limit?: number; offset?: number },
  ): Promise<WorkflowRecord[]> {
    const rows = await getUserAccessibleWorkflows(
      db,
      filter.userId,
      filter.workspaceExternalId,
      page,
    )
    return rows.map(toWorkflowRecord)
  }

  async countWorkflowsByFolder(
    filter: XyneFilter,
  ): Promise<{ total: number; byFolder: Record<string, { total: number; active: number }> }> {
    return getAccessibleWorkflowCounts(db, filter.userId, filter.workspaceExternalId)
  }

  // Internal — used at boot to re-register cron jobs; bypasses workspace filter.
  async listAllActiveWorkflows(): Promise<WorkflowRecord[]> {
    const rows = await db
      .select()
      .from(sdkWorkflows)
      .where(eq(sdkWorkflows.status, "ACTIVE"))
    return rows.map(toWorkflowRecord)
  }

  async findActiveWorkflows(
    eventType: string,
    eventScope: Record<string, unknown>,
  ): Promise<WorkflowRecord[]> {
    // System event routing (no caller): eventScope is the event's own origin
    // scope, used to route to workflows in the same workspace — not an ACL check.
    const workspaceId = eventScope["workspaceId"] as string | undefined
    const conditions = [
      eq(sdkWorkflows.eventType, eventType),
      eq(sdkWorkflows.status, "ACTIVE"),
    ]
    if (workspaceId) {
      conditions.push(eq(sdkWorkflows.workspaceId, workspaceId))
    }
    const rows = await db
      .select()
      .from(sdkWorkflows)
      .where(and(...conditions))
    return rows.map(toWorkflowRecord)
  }

  async createWorkflow(data: {
    id?: string
    status: string
    config: string
    metadata: string
    eventType: string
    summary?: string | null
    folderId: string
    attributes?: ResourceAttributes<"workflow">
  }): Promise<string> {
    const id = data.id ?? createId()
    // Scope + creator arrive via attributes (set from ctx by the router, never
    // trusted from the client). Insert the workflow AND stamp the creator's
    // owner permission row atomically — a failed grant must not orphan a row.
    const attrs = (data.attributes ?? {}) as XyneResourceAttrs
    const workspaceId = attrs.workspaceId ?? ""
    await db.transaction(async (tx) => {
      await tx.insert(sdkWorkflows).values({
        id,
        workspaceId,
        status: data.status,
        config: data.config,
        metadata: data.metadata,
        eventType: data.eventType,
        summary: data.summary ?? null,
        folderId: data.folderId,
      })
      if (attrs.createdByUserId !== undefined) {
        await grantSdkPermission(tx, attrs.createdByUserId, "workflow", id, SdkResourceRole.Owner)
      }
    })
    return id
  }

  async updateWorkflow(
    id: string,
    data: {
      status?: string
      config?: string
      metadata?: string
      eventType?: string
      summary?: string | null
      folderId?: string
    },
  ): Promise<void> {
    await db
      .update(sdkWorkflows)
      .set({
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.config !== undefined ? { config: data.config } : {}),
        ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
        ...(data.eventType !== undefined ? { eventType: data.eventType } : {}),
        ...(data.summary !== undefined ? { summary: data.summary } : {}),
        ...(data.folderId !== undefined ? { folderId: data.folderId } : {}),
        updatedAt: Date.now(),
      })
      .where(eq(sdkWorkflows.id, id))
  }

  // ── Folders ───────────────────────────────────────────────────────────────

  async listFolders(filter: XyneFilter): Promise<FolderRecord[]> {
    const rows = await getUserAccessibleFolders(
      db,
      filter.userId,
      filter.workspaceExternalId,
    )
    return rows.map(toFolderRecord)
  }

  async getFolder(id: string): Promise<FolderRecord | null> {
    const rows = await db
      .select()
      .from(sdkFolders)
      .where(eq(sdkFolders.id, id))
      .limit(1)
    return rows[0] ? toFolderRecord(rows[0]) : null
  }

  // System integrity read — deliberately unfiltered. The SDK's reparent cycle
  // check must see folders the caller cannot, or a hidden descendant slips a
  // cycle through. Never surfaced to a caller.
  async listAllFolders(): Promise<FolderRecord[]> {
    const rows = await db.select().from(sdkFolders)
    return rows.map(toFolderRecord)
  }

  // System integrity read — deliberately unfiltered. Folder deletion is blocked
  // while it holds ANY workflow, including ones the caller cannot see.
  async countWorkflowsInFolder(folderId: string): Promise<number> {
    const rows = await db
      .select({ n: sql<string>`count(*)` })
      .from(sdkWorkflows)
      .where(eq(sdkWorkflows.folderId, folderId))
    return Number(rows[0]?.n ?? 0)
  }

  async createFolder(data: {
    id?: string
    name: string
    metadata: string
    parentId?: string | null
    attributes?: ResourceAttributes<"folder">
  }): Promise<string> {
    const id = data.id ?? createId()
    const attrs = (data.attributes ?? {}) as XyneResourceAttrs
    const workspaceId = attrs.workspaceId ?? ""
    await db.transaction(async (tx) => {
      await tx.insert(sdkFolders).values({
        id,
        workspaceId,
        name: data.name,
        metadata: data.metadata,
        parentId: data.parentId ?? null,
        createdAt: Date.now(),
      })
      if (attrs.createdByUserId !== undefined) {
        await grantSdkPermission(tx, attrs.createdByUserId, "folder", id, SdkResourceRole.Owner)
      }
    })
    return id
  }

  async updateFolder(id: string, data: { name?: string; parentId?: string | null }): Promise<void> {
    const patch: Record<string, unknown> = {}
    if (data.name !== undefined) patch.name = data.name
    if ("parentId" in data) patch.parentId = data.parentId ?? null
    if (Object.keys(patch).length > 0) {
      await db
        .update(sdkFolders)
        .set(patch)
        .where(eq(sdkFolders.id, id))
    }
  }

  async deleteFolder(id: string): Promise<void> {
    await db.delete(sdkFolders).where(eq(sdkFolders.id, id))
  }

  // ── Execution lifecycle ───────────────────────────────────────────────────

  async createExecution(data: {
    workflowId: string
    status: string
    context: string
    sourceExecutionId?: string
  }): Promise<string> {
    const id = createId()
    const now = Date.now()
    await db.transaction(async (tx) => {
      await tx.insert(sdkExecutions).values({
        id,
        workflowId: data.workflowId,
        status: data.status,
        sourceExecutionId: data.sourceExecutionId,
        createdAt: now,
        updatedAt: now,
      })
      await tx.insert(sdkExecutionStates).values({
        executionId: id,
        context: data.context,
        currentStepIndex: 0,
        updatedAt: now,
      })
    })
    return id
  }

  async updateExecutionStatus(
    executionId: string,
    status: string,
  ): Promise<void> {
    await db
      .update(sdkExecutions)
      .set({ status, updatedAt: Date.now() })
      .where(eq(sdkExecutions.id, executionId))
  }

  async getExecution(executionId: string): Promise<ExecutionRecord | null> {
    const rows = await db
      .select()
      .from(sdkExecutions)
      .where(eq(sdkExecutions.id, executionId))
      .limit(1)
    const r = rows[0]
    if (!r) return null
    return {
      id: r.id,
      workflowId: r.workflowId,
      status: r.status,
      createdAt: new Date(r.createdAt),
      ...(r.sourceExecutionId != null
        ? { sourceExecutionId: r.sourceExecutionId }
        : {}),
    }
  }

  // The ids of workflows the caller may see — analytics/executions inherit a
  // workflow's visibility, so they scope to this set. Bounded by a workspace's
  // workflow count (dashboard aggregates, not a hot paginated path).
  private async visibleWorkflowIds(filter: XyneFilter): Promise<string[]> {
    const rows = await getUserAccessibleWorkflows(
      db,
      filter.userId,
      filter.workspaceExternalId,
    )
    return rows.map((r) => r.id)
  }

  async getTopErrors(
    filter: XyneFilter,
    params: { since?: Date; limit?: number; folderId?: string },
  ): Promise<Array<{ message: string; count: number; runs: Array<{ id: string; workflowId: string }> }>> {
    const limit = params.limit ?? 10
    const sinceMs = params.since ? params.since.getTime() : 0

    const visibleIds = await this.visibleWorkflowIds(filter)
    if (visibleIds.length === 0) return []

    const conditions = [
      eq(sdkStepRecords.status, "FAILED"),
      eq(sdkExecutions.status, "FAILED"),
      inArray(sdkExecutions.workflowId, visibleIds),
    ]
    if (sinceMs > 0) conditions.push(gte(sdkExecutions.createdAt, sinceMs))
    if (params.folderId) conditions.push(eq(sdkWorkflows.folderId, params.folderId))

    const errQuery = db
      .select({
        executionId: sdkStepRecords.executionId,
        data: sdkStepRecords.data,
        workflowId: sdkExecutions.workflowId,
      })
      .from(sdkStepRecords)
      .innerJoin(sdkExecutions, eq(sdkStepRecords.executionId, sdkExecutions.id))
      .innerJoin(sdkWorkflows, eq(sdkExecutions.workflowId, sdkWorkflows.id))
      .where(and(...conditions))
      .orderBy(desc(sdkExecutions.createdAt))
    const rows = await errQuery

    const byMessage = new Map<string, Array<{ id: string; workflowId: string }>>()
    for (const r of rows) {
      let message = "Unknown error"
      if (r.data) {
        try {
          const parsed = JSON.parse(r.data) as Record<string, unknown>
          message =
            (typeof parsed["error"] === "string" ? parsed["error"] : null) ??
            (typeof parsed["message"] === "string" ? parsed["message"] : null) ??
            message
        } catch {}
      }
      const runs = byMessage.get(message) ?? []
      runs.push({ id: r.executionId, workflowId: r.workflowId })
      byMessage.set(message, runs)
    }

    return Array.from(byMessage.entries())
      .map(([message, runs]) => ({ message, count: runs.length, runs }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
  }

  async getAnalyticsSummary(
    filter: XyneFilter,
    params: { since: Date; rangeDays: number; folderId?: string },
  ): Promise<AnalyticsSummaryResult> {
    const sinceMs = params.since.getTime()

    // Visible workflows are the analytics universe — same JOIN as the list.
    const workflows = await getUserAccessibleWorkflows(
      db,
      filter.userId,
      filter.workspaceExternalId,
      params.folderId ? { folderId: params.folderId } : undefined,
    )

    const workflowIds = workflows.map((w) => w.id)

    const execConditions = [gte(sdkExecutions.createdAt, sinceMs), inArray(sdkExecutions.workflowId, workflowIds.length > 0 ? workflowIds : [""])]
    const executions = workflowIds.length === 0 ? [] : await db
      .select()
      .from(sdkExecutions)
      .where(and(...execConditions))
      .orderBy(desc(sdkExecutions.createdAt))

    const byStatus: Record<string, number> = {}
    for (const e of executions) {
      byStatus[e.status] = (byStatus[e.status] ?? 0) + 1
    }

    const completed = byStatus["COMPLETED"] ?? 0
    const failed = byStatus["FAILED"] ?? 0
    const terminal = completed + failed
    const successRate = terminal > 0
      ? Math.round((completed / terminal) * 100)
      : 0

    const dayBuckets = new Map<string, { COMPLETED: number; FAILED: number; RUNNING: number; CANCELLED: number }>()
    for (let i = params.rangeDays - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
      dayBuckets.set(d.toISOString().slice(0, 10), { COMPLETED: 0, FAILED: 0, RUNNING: 0, CANCELLED: 0 })
    }
    for (const e of executions) {
      const key = new Date(e.createdAt).toISOString().slice(0, 10)
      const bucket = dayBuckets.get(key)
      if (bucket && e.status in bucket) {
        bucket[e.status as keyof typeof bucket]++
      }
    }
    const runsByDay = Array.from(dayBuckets.entries()).map(([date, counts]) => ({ date, ...counts }))

    const nameMap = new Map(workflows.map((w) => {
      let name = w.id
      try { name = (JSON.parse(w.metadata ?? "{}") as { name?: string }).name ?? w.id } catch {}
      return [w.id, name]
    }))
    const wfStats = new Map<string, { totalRuns: number; failed: number; lastRunAt: number | null }>()
    for (const e of executions) {
      const s = wfStats.get(e.workflowId) ?? { totalRuns: 0, failed: 0, lastRunAt: null }
      s.totalRuns++
      if (e.status === "FAILED") s.failed++
      if (!s.lastRunAt || e.createdAt > s.lastRunAt) s.lastRunAt = e.createdAt
      wfStats.set(e.workflowId, s)
    }
    const byWorkflow = workflows.map((wf) => {
      const s = wfStats.get(wf.id) ?? { totalRuns: 0, failed: 0, lastRunAt: null }
      return {
        workflowId: wf.id,
        name: nameMap.get(wf.id) ?? wf.id,
        status: wf.status,
        eventType: wf.eventType,
        totalRuns: s.totalRuns,
        failedRuns: s.failed,
        failureRate: s.totalRuns > 0 ? Math.round((s.failed / s.totalRuns) * 100) : 0,
        lastRunAt: s.lastRunAt ? new Date(s.lastRunAt).toISOString() : null,
      }
    }).sort((a, b) => b.totalRuns - a.totalRuns)

    const recentFailures = executions
      .filter((e) => e.status === "FAILED")
      .slice(0, 10)
      .map((e) => ({
        executionId: e.id,
        workflowId: e.workflowId,
        workflowName: nameMap.get(e.workflowId) ?? e.workflowId,
        createdAt: new Date(e.createdAt).toISOString(),
      }))

    return {
      totalRuns: executions.length,
      successRate,
      byStatus,
      runsByDay,
      byWorkflow,
      recentFailures,
      activeWorkflows: workflows.filter((w) => w.status === "ACTIVE").length,
      totalWorkflows: workflows.length,
    }
  }

  async listExecutions(
    filter: XyneFilter,
    params: {
      workflowId?: string
      status?: string
      limit?: number
      cursor?: string
      folderId?: string
    },
  ): Promise<{ items: ExecutionRecord[]; nextCursor?: string }> {
    const limit = params.limit
    // Executions inherit their workflow's visibility.
    const visibleIds = await this.visibleWorkflowIds(filter)
    if (visibleIds.length === 0) return { items: [] }

    const conditions = [inArray(sdkExecutions.workflowId, visibleIds)]
    if (params.workflowId) {
      conditions.push(eq(sdkExecutions.workflowId, params.workflowId))
    }
    if (params.status) {
      conditions.push(eq(sdkExecutions.status, params.status))
    }
    if (params.cursor) {
      conditions.push(lt(sdkExecutions.createdAt, decodeCursor(params.cursor)))
    }
    if (params.folderId) {
      conditions.push(eq(sdkWorkflows.folderId, params.folderId))
    }

    let q = db
      .select({
        id: sdkExecutions.id,
        workflowId: sdkExecutions.workflowId,
        status: sdkExecutions.status,
        createdAt: sdkExecutions.createdAt,
        updatedAt: sdkExecutions.updatedAt,
        sourceExecutionId: sdkExecutions.sourceExecutionId,
        // Joined so the list can show the workflow name without a second round-trip.
        workflowMetadata: sdkWorkflows.metadata,
      })
      .from(sdkExecutions)
      .innerJoin(sdkWorkflows, eq(sdkExecutions.workflowId, sdkWorkflows.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(sdkExecutions.createdAt))
      .$dynamic()

    if (limit !== undefined) q = q.limit(limit + 1)

    const rows = await q
    const hasMore = limit !== undefined && rows.length > limit
    const items = (hasMore ? rows.slice(0, limit) : rows).map((r) => {
      let workflowName = r.workflowId
      try {
        workflowName =
          (JSON.parse(r.workflowMetadata ?? "{}") as { name?: string }).name ??
          r.workflowId
      } catch {}
      return {
        id: r.id,
        workflowId: r.workflowId,
        status: r.status,
        createdAt: new Date(r.createdAt),
        updatedAt: new Date(r.updatedAt),
        workflowName,
        ...(r.sourceExecutionId != null
          ? { sourceExecutionId: r.sourceExecutionId }
          : {}),
      }
    })
    const nextCursor =
      hasMore && items.length > 0
        ? encodeCursor(items[items.length - 1]!.createdAt.getTime())
        : undefined
    return {
      items,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    }
  }

  // ── Execution state ───────────────────────────────────────────────────────

  async getExecutionState(
    executionId: string,
  ): Promise<ExecutionStateRecord | null> {
    const rows = await db
      .select()
      .from(sdkExecutionStates)
      .where(eq(sdkExecutionStates.executionId, executionId))
      .limit(1)
    const r = rows[0]
    if (!r) return null
    return {
      context: r.context,
      currentStepIndex: r.currentStepIndex,
      pausePath: r.pausePath,
      ...(r.pauseType != null
        ? { pauseType: r.pauseType as ExecutionPauseType }
        : {}),
    }
  }

  /**
   * Cross-run read used by the LOAD_LAST_RESULT host step: the most recent prior
   * COMPLETED execution of `workflowId` (excluding `excludeExecutionId`), with its
   * full stored WorkflowContext. Composes listExecutions (already desc by
   * createdAt) + getExecutionState. Null when no prior run or no/invalid state.
   */
  async getPreviousExecution(
    workflowId: string,
    opts?: { status?: string; excludeExecutionId?: string },
  ): Promise<
    { executionId: string; runAt: string; context: Record<string, unknown> } | null
  > {
    // System path (runs inside a step, no caller) — query executions directly,
    // NOT through the ACL-filtered listExecutions.
    const items = await db
      .select({ id: sdkExecutions.id, createdAt: sdkExecutions.createdAt })
      .from(sdkExecutions)
      .where(
        and(
          eq(sdkExecutions.workflowId, workflowId),
          eq(sdkExecutions.status, opts?.status ?? "COMPLETED"),
        ),
      )
      .orderBy(desc(sdkExecutions.createdAt))
      .limit(5)
    const prevRow = items.find((e) => e.id !== opts?.excludeExecutionId)
    if (!prevRow) return null
    const prev = { id: prevRow.id, createdAt: new Date(prevRow.createdAt) }
    const state = await this.getExecutionState(prev.id)
    if (!state?.context) return null
    let context: Record<string, unknown>
    try {
      context = JSON.parse(state.context) as Record<string, unknown>
    } catch {
      return null
    }
    return {
      executionId: prev.id,
      runAt: prev.createdAt.toISOString(),
      context,
    }
  }

  async persistState(
    executionId: string,
    data: {
      context: string
      currentStepIndex?: number
      pausePath?: string
      pauseType?: ExecutionPauseType
    },
  ): Promise<void> {
    await db
      .insert(sdkExecutionStates)
      .values({
        executionId,
        context: data.context,
        currentStepIndex: data.currentStepIndex ?? 0,
        pausePath: data.pausePath ?? null,
        pauseType: data.pauseType ?? null,
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: sdkExecutionStates.executionId,
        set: {
          context: data.context,
          ...(data.currentStepIndex !== undefined
            ? { currentStepIndex: data.currentStepIndex }
            : {}),
          pausePath: data.pausePath ?? null,
          pauseType: data.pauseType ?? null,
          updatedAt: Date.now(),
        },
      })
  }

  // ── Step tracking ─────────────────────────────────────────────────────────

  async upsertStep(
    executionId: string,
    stepName: string,
    data: { status: string; executorType: string; data?: string },
  ): Promise<void> {
    await db
      .insert(sdkStepRecords)
      .values({
        executionId,
        stepName,
        status: data.status,
        executorType: data.executorType,
        data: data.data ?? null,
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: [sdkStepRecords.executionId, sdkStepRecords.stepName],
        set: {
          status: data.status,
          executorType: data.executorType,
          ...(data.data !== undefined ? { data: data.data } : {}),
          updatedAt: Date.now(),
        },
      })
  }

  async getStepRows(executionId: string): Promise<StepRecord[]> {
    const rows = await db
      .select()
      .from(sdkStepRecords)
      .where(eq(sdkStepRecords.executionId, executionId))
    return rows.map((r) => ({
      stepName: r.stepName,
      status: r.status,
      executorType: r.executorType,
      data: r.data,
    }))
  }

  async getStep(
    executionId: string,
    stepName: string,
  ): Promise<StepRecord | null> {
    const rows = await db
      .select()
      .from(sdkStepRecords)
      .where(
        and(
          eq(sdkStepRecords.executionId, executionId),
          eq(sdkStepRecords.stepName, stepName),
        ),
      )
      .limit(1)
    const r = rows[0]
    if (!r) return null
    return {
      stepName: r.stepName,
      status: r.status,
      executorType: r.executorType,
      data: r.data,
    }
  }

  // ── Failure handling ──────────────────────────────────────────────────────

  async markFailed(
    executionId: string,
    _error: string,
  ): Promise<"marked" | "skipped-terminal" | "not-found"> {
    const result = await db
      .update(sdkExecutions)
      .set({ status: "FAILED", updatedAt: Date.now() })
      .where(
        and(
          eq(sdkExecutions.id, executionId),
          sql`${sdkExecutions.status} NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')`,
        ),
      )
      .returning({ id: sdkExecutions.id })

    if (result.length > 0) return "marked"

    const existing = await db
      .select({ id: sdkExecutions.id })
      .from(sdkExecutions)
      .where(eq(sdkExecutions.id, executionId))
      .limit(1)
    return existing.length > 0 ? "skipped-terminal" : "not-found"
  }

  // ── Static data ───────────────────────────────────────────────────────────

  async getStaticData(workflowId: string, key: string): Promise<unknown> {
    const rows = await db
      .select()
      .from(sdkStaticData)
      .where(
        and(
          eq(sdkStaticData.workflowId, workflowId),
          eq(sdkStaticData.key, key),
        ),
      )
      .limit(1)
    return rows[0]?.value ?? null
  }

  async setStaticData(
    workflowId: string,
    key: string,
    value: unknown,
  ): Promise<void> {
    await db
      .insert(sdkStaticData)
      .values({
        workflowId,
        key,
        value: value as Record<string, unknown>,
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: [sdkStaticData.workflowId, sdkStaticData.key],
        set: { value: value as Record<string, unknown>, updatedAt: Date.now() },
      })
  }

  async deleteStaticData(workflowId: string, key: string): Promise<void> {
    await db
      .delete(sdkStaticData)
      .where(
        and(
          eq(sdkStaticData.workflowId, workflowId),
          eq(sdkStaticData.key, key),
        ),
      )
  }

  // ── Step events ───────────────────────────────────────────────────────────

  async appendStepEvent(
    executionId: string,
    stepName: string,
    event: { type: string; data: string },
  ): Promise<void> {
    await db.insert(sdkStepEvents).values({
      id: createId(),
      executionId,
      stepName,
      type: event.type,
      data: event.data,
      createdAt: Date.now(),
    })
  }

  async getStepEvents(
    executionId: string,
    stepName: string,
    after?: Date,
  ): Promise<Array<{ id: string; type: string; data: string; createdAt: Date }>> {
    const conditions = [
      eq(sdkStepEvents.executionId, executionId),
      eq(sdkStepEvents.stepName, stepName),
    ]
    if (after) {
      conditions.push(sql`${sdkStepEvents.createdAt} > ${after.getTime()}`)
    }
    const rows = await db
      .select()
      .from(sdkStepEvents)
      .where(and(...conditions))
      .orderBy(asc(sdkStepEvents.createdAt))
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      data: r.data,
      createdAt: new Date(r.createdAt),
    }))
  }

  // ── Credentials ───────────────────────────────────────────────────────────

  // Resolution (execution path, no caller): scope is the running workflow's own
  // attributes; workspaceId is the tenant. Returns the secret.
  async resolveCredential(
    scope: ResourceAttributes<"workflow">,
    name: string,
  ): Promise<{ type: string; data: Record<string, unknown> } | null> {
    const workspaceId = scope.workspaceId
    const rows = await db
      .select()
      .from(sdkCredentials)
      .where(
        and(
          eq(sdkCredentials.workspaceId, workspaceId),
          eq(sdkCredentials.name, name),
        ),
      )
      .limit(1)
    const r = rows[0]
    if (!r) return null
    return { type: r.credType, data: r.data as Record<string, unknown> }
  }

  // Resolution (execution path): the running workflow's credentials (redacted).
  async listTenantCredentials(
    scope: ResourceAttributes<"workflow">,
  ): Promise<Array<{ name: string; type: string }>> {
    const workspaceId = scope.workspaceId
    const rows = await db
      .select({ name: sdkCredentials.name, credType: sdkCredentials.credType })
      .from(sdkCredentials)
      .where(eq(sdkCredentials.workspaceId, workspaceId))
    return rows.map((r) => ({ name: r.name, type: r.credType }))
  }

  // Management (caller path): create/list/get/delete addressed by a synthetic
  // `${workspaceId}::${name}` id, since credentials are keyed by (workspace, name).
  async createCredential(data: {
    id?: string
    name: string
    type: string
    data: Record<string, unknown>
    attributes?: ResourceAttributes<"credential">
  }): Promise<string> {
    const workspaceId = data.attributes?.workspaceId ?? ""
    await db
      .insert(sdkCredentials)
      .values({
        workspaceId,
        name: data.name,
        credType: data.type,
        data: data.data,
        createdAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: [sdkCredentials.workspaceId, sdkCredentials.name],
        set: { credType: data.type, data: data.data },
      })
    return credId(workspaceId, data.name)
  }

  async getCredential(id: string): Promise<CredentialRecord | null> {
    const { workspaceId, name } = splitCredId(id)
    const rows = await db
      .select({ name: sdkCredentials.name, credType: sdkCredentials.credType })
      .from(sdkCredentials)
      .where(
        and(
          eq(sdkCredentials.workspaceId, workspaceId),
          eq(sdkCredentials.name, name),
        ),
      )
      .limit(1)
    const r = rows[0]
    if (!r) return null
    return {
      id,
      name: r.name,
      type: r.credType,
      attributes: { workspaceId } satisfies XyneResourceAttrs,
    }
  }

  async listCredentials(filter: XyneFilter): Promise<CredentialRecord[]> {
    const rows = await db
      .select({ name: sdkCredentials.name, credType: sdkCredentials.credType })
      .from(sdkCredentials)
      .where(eq(sdkCredentials.workspaceId, filter.workspaceExternalId))
    return rows.map((r) => ({
      id: credId(filter.workspaceExternalId, r.name),
      name: r.name,
      type: r.credType,
      attributes: {
        workspaceId: filter.workspaceExternalId,
      } satisfies XyneResourceAttrs,
    }))
  }

  async deleteCredential(id: string): Promise<void> {
    const { workspaceId, name } = splitCredId(id)
    await db
      .delete(sdkCredentials)
      .where(
        and(
          eq(sdkCredentials.workspaceId, workspaceId),
          eq(sdkCredentials.name, name),
        ),
      )
  }

  // ── Webhook registration ──────────────────────────────────────────────────

  async storeWebhookPath(
    workflowId: string,
    path: string,
    secret: string,
  ): Promise<void> {
    await db
      .insert(sdkWebhooks)
      .values({ workflowId, path, secret, createdAt: Date.now() })
      .onConflictDoUpdate({
        target: sdkWebhooks.workflowId,
        set: { path, secret },
      })
  }

  async removeWebhookPath(workflowId: string): Promise<void> {
    await db
      .delete(sdkWebhooks)
      .where(eq(sdkWebhooks.workflowId, workflowId))
  }

  async getWebhookByPath(path: string): Promise<WebhookRecord | null> {
    const rows = await db
      .select()
      .from(sdkWebhooks)
      .where(eq(sdkWebhooks.path, path))
      .limit(1)
    const r = rows[0]
    return r ? { workflowId: r.workflowId, path: r.path, secret: r.secret } : null
  }

  // ── Resume payload ────────────────────────────────────────────────────────

  async persistResumePayload(
    executionId: string,
    payload: ResumePayload,
  ): Promise<void> {
    await db
      .insert(sdkResumePayloads)
      .values({
        executionId,
        payload: JSON.stringify(payload),
        createdAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: sdkResumePayloads.executionId,
        set: { payload: JSON.stringify(payload) },
      })
  }

  async getResumePayload(executionId: string): Promise<ResumePayload | null> {
    return await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(sdkResumePayloads)
        .where(eq(sdkResumePayloads.executionId, executionId))
        .limit(1)
      const r = rows[0]
      if (!r) return null
      await tx
        .delete(sdkResumePayloads)
        .where(eq(sdkResumePayloads.executionId, executionId))
      return JSON.parse(r.payload) as ResumePayload
    })
  }

  // ── Workflow callbacks ────────────────────────────────────────────────────

  async storeWorkflowCallback(record: WorkflowCallbackRecord): Promise<void> {
    await db
      .insert(sdkWorkflowCallbacks)
      .values({
        workflowId: record.workflowId,
        secret: record.secret,
        createdAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: sdkWorkflowCallbacks.workflowId,
        set: { secret: record.secret },
      })
  }

  async getWorkflowCallbackBySecret(
    secret: string,
  ): Promise<WorkflowCallbackRecord | null> {
    const rows = await db
      .select()
      .from(sdkWorkflowCallbacks)
      .where(eq(sdkWorkflowCallbacks.secret, secret))
      .limit(1)
    const r = rows[0]
    return r
      ? {
          workflowId: r.workflowId,
          secret: r.secret,
          createdAt: new Date(r.createdAt),
        }
      : null
  }

  async getWorkflowCallback(
    workflowId: string,
  ): Promise<WorkflowCallbackRecord | null> {
    const rows = await db
      .select()
      .from(sdkWorkflowCallbacks)
      .where(eq(sdkWorkflowCallbacks.workflowId, workflowId))
      .limit(1)
    const r = rows[0]
    return r
      ? {
          workflowId: r.workflowId,
          secret: r.secret,
          createdAt: new Date(r.createdAt),
        }
      : null
  }

  async rotateWorkflowCallback(
    workflowId: string,
    newSecret: string,
  ): Promise<WorkflowCallbackRecord> {
    const now = Date.now()
    await db
      .update(sdkWorkflowCallbacks)
      .set({ secret: newSecret })
      .where(eq(sdkWorkflowCallbacks.workflowId, workflowId))
    return {
      workflowId,
      secret: newSecret,
      createdAt: new Date(now),
    }
  }

  async removeWorkflowCallback(workflowId: string): Promise<void> {
    await db
      .delete(sdkWorkflowCallbacks)
      .where(eq(sdkWorkflowCallbacks.workflowId, workflowId))
  }
}
