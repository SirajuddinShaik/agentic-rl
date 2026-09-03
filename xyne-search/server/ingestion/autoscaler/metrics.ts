import type { DoclingRuntimeConfig } from "@/ingestion/docling/runtime/config"
import type { DoclingOcrPageCounters } from "@/ingestion/docling/scheduler/store"
import type { OcrAutoscalerDecision } from "@/ingestion/autoscaler/decision"
import { readFile } from "node:fs/promises"
import { Gauge, Registry } from "prom-client"

export const OCR_AUTOSCALER_METRICS_CONTENT_TYPE =
  "text/plain; version=0.0.4; charset=utf-8"

export type OcrAutoscalerFleetMetrics = {
  currentNodes: number
  backendHealthyNodes?: number
  healthyNodes: number
  scrapeTargets?: string[]
  discoveryError?: boolean
}

export type OcrAutoscalerA100Metrics = OcrAutoscalerFleetMetrics & {
  runningRequestsTotal: number
  capacityWaitingTotal: number
  capacityWaitingNodes: number
  capacityWaitingSustained: boolean
}

export type OcrAutoscalerRedisMetrics = {
  permitActive: Record<
    "ocr-submit" | "ocr-submit-pages" | "vespa-write",
    number
  >
  resultsStreamLength: number
  resultsStreamPending: Record<string, number>
}

export type DoclingStatusCounter = {
  status: string
  count: number
  pages: number
}

export type DoclingStatusMetrics = {
  files: DoclingStatusCounter[]
  parts: DoclingStatusCounter[]
  partsMissingPageCount: number
}

export type OcrAutoscalerMetricsSnapshot = {
  collectedAt: Date
  counters: DoclingOcrPageCounters
  runtimeConfig: DoclingRuntimeConfig
  rawDecision: OcrAutoscalerDecision
  effectiveDecision: OcrAutoscalerDecision
  wrapperFleet: OcrAutoscalerFleetMetrics
  a100Fleet: OcrAutoscalerA100Metrics
  currentSubmitterContainers: number
  redis: OcrAutoscalerRedisMetrics
  docling: DoclingStatusMetrics
}

export type OcrCostConfig = {
  currency: string
  a100CostPerHour: number
  wrapperCostPerHour: number
}

const DEFAULT_COST_CONFIG: OcrCostConfig = Object.freeze({
  currency: "USD",
  a100CostPerHour: 0,
  wrapperCostPerHour: 0,
})

const numberValue = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const allRows = <T>(result: { rows?: T[] } | T[]): T[] =>
  Array.isArray(result) ? result : result.rows || []

const firstRow = <T>(result: { rows?: T[] } | T[]): T | null =>
  allRows<T>(result)[0] || null

const normalizeStatusCounterRows = (
  rows: Array<Record<string, unknown>>,
): DoclingStatusCounter[] =>
  rows
    .map((row) => ({
      status: String(row.status || "unknown"),
      count: numberValue(row.count),
      pages: numberValue(row.pages),
    }))
    .filter((row) => row.status.length > 0)

const positiveNumberFromUnknown = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

const costConfigFromEnv = (): OcrCostConfig => ({
  currency: process.env.OCR_COST_CURRENCY || DEFAULT_COST_CONFIG.currency,
  a100CostPerHour: positiveNumberFromUnknown(
    process.env.OCR_A100_COST_PER_HOUR ??
      process.env.OCR_COST_A100_PER_HOUR ??
      process.env.OCR_COST_PER_A100_HOUR,
    DEFAULT_COST_CONFIG.a100CostPerHour,
  ),
  wrapperCostPerHour: positiveNumberFromUnknown(
    process.env.OCR_WRAPPER_COST_PER_HOUR ??
      process.env.OCR_COST_WRAPPER_PER_HOUR ??
      process.env.OCR_COST_PER_WRAPPER_HOUR,
    DEFAULT_COST_CONFIG.wrapperCostPerHour,
  ),
})

export const loadOcrCostConfig = async (): Promise<OcrCostConfig> => {
  const envConfig = costConfigFromEnv()
  const path = process.env.OCR_COST_CONFIG_PATH
  if (!path) {
    return envConfig
  }

  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >
    return {
      currency: String(
        parsed.currency || parsed.unit || envConfig.currency,
      ).slice(0, 16),
      a100CostPerHour: positiveNumberFromUnknown(
        parsed.a100CostPerHour ??
          parsed.a100_cost_per_hour ??
          parsed.ocrMachineCostPerHour ??
          parsed.ocr_machine_cost_per_hour,
        envConfig.a100CostPerHour,
      ),
      wrapperCostPerHour: positiveNumberFromUnknown(
        parsed.wrapperCostPerHour ??
          parsed.wrapper_cost_per_hour ??
          parsed.ocrServerWrapperCostPerHour ??
          parsed.ocr_server_wrapper_cost_per_hour,
        envConfig.wrapperCostPerHour,
      ),
    }
  } catch {
    return envConfig
  }
}

export const runtimeConfigAgeSeconds = (
  runtimeConfig: Pick<DoclingRuntimeConfig, "updatedAt">,
  nowMs = Date.now(),
) => {
  if (!runtimeConfig.updatedAt) {
    return -1
  }

  const updatedAtMs = Date.parse(runtimeConfig.updatedAt)
  if (!Number.isFinite(updatedAtMs)) {
    return -1
  }

  return Math.max(0, (nowMs - updatedAtMs) / 1000)
}

export const runtimeConfigWriter = (
  runtimeConfig: Pick<DoclingRuntimeConfig, "version">,
) => {
  if (!runtimeConfig.version) {
    return "none"
  }
  return runtimeConfig.version.startsWith("ocr-autoscaler-")
    ? "ocr-autoscaler"
    : "other"
}

const redisNumber = async (command: string[]) => {
  const { getRedisClient } = await import("@/platform/lib/redisClient")
  const redis = await getRedisClient()
  try {
    const value = await redis.sendCommand(command)
    return numberValue(value)
  } catch {
    return 0
  }
}

const redisPendingCount = async (stream: string, group: string) => {
  const { getRedisClient } = await import("@/platform/lib/redisClient")
  const redis = await getRedisClient()
  try {
    const pending = await redis.sendCommand(["XPENDING", stream, group])
    if (Array.isArray(pending)) {
      return numberValue(pending[0])
    }
    if (pending && typeof pending === "object") {
      return numberValue((pending as { pending?: unknown }).pending)
    }
    return numberValue(pending)
  } catch {
    return 0
  }
}

export const collectOcrAutoscalerRedisMetrics =
  async (): Promise<OcrAutoscalerRedisMetrics> => {
    const { default: config } = await import("@/config")
    const stream = config.doclingResultsStream
    const resultGroups = [
      config.doclingResultGroup,
      config.doclingSchedulerResultGroup,
    ].filter((group, index, groups) => group && groups.indexOf(group) === index)

    const pendingEntries = await Promise.all(
      resultGroups.map(
        async (group) =>
          [group, await redisPendingCount(stream, group)] as const,
      ),
    )

    return {
      permitActive: {
        "ocr-submit": await redisNumber([
          "ZCARD",
          "docling:scheduler:permit:ocr-submit:active",
        ]),
        "ocr-submit-pages": await redisNumber([
          "ZCARD",
          "docling:scheduler:permit:ocr-submit-pages:active",
        ]),
        "vespa-write": await redisNumber([
          "ZCARD",
          "docling:scheduler:permit:vespa-write:active",
        ]),
      },
      resultsStreamLength: await redisNumber(["XLEN", stream]),
      resultsStreamPending: Object.fromEntries(pendingEntries),
    }
  }

export const collectDoclingStatusMetrics =
  async (): Promise<DoclingStatusMetrics> => {
    const [{ sql }, { db }] = await Promise.all([
      import("drizzle-orm"),
      import("@/platform/db/client"),
    ])
    const [filesResult, partsResult, missingResult] = await Promise.all([
      db.execute(sql`
        SELECT
          status,
          COUNT(*)::int AS count,
          COALESCE(SUM(GREATEST(total_pages, 0)), 0)::int AS pages
        FROM docling_async_files
        GROUP BY status
        ORDER BY status
      `),
      db.execute(sql`
        SELECT
          status,
          COUNT(*)::int AS count,
          COALESCE(SUM(
            CASE
              WHEN page_count > 0 THEN page_count
              WHEN end_page > start_page THEN end_page - start_page
              ELSE 0
            END
          ), 0)::int AS pages
        FROM docling_async_parts
        GROUP BY status
        ORDER BY status
      `),
      db.execute(sql`
        SELECT COUNT(*)::int AS missing_page_count
        FROM docling_async_parts
        WHERE page_count IS NULL
           OR page_count <= 0
           OR end_page <= start_page
      `),
    ])

    return {
      files: normalizeStatusCounterRows(
        allRows<Record<string, unknown>>(filesResult),
      ),
      parts: normalizeStatusCounterRows(
        allRows<Record<string, unknown>>(partsResult),
      ),
      partsMissingPageCount: numberValue(
        firstRow<Record<string, unknown>>(missingResult)?.missing_page_count,
      ),
    }
  }

const setGauge = (
  gauge: Gauge<string>,
  value: number | boolean,
  labels?: Record<string, string>,
) => {
  const numericValue =
    typeof value === "boolean" ? (value ? 1 : 0) : Number(value)
  const safeValue = Number.isFinite(numericValue) ? numericValue : 0
  if (labels) {
    gauge.set(labels, safeValue)
    return
  }
  gauge.set(safeValue)
}

const addGauge = (
  registry: Registry,
  name: string,
  help: string,
  labelNames: string[] = [],
) =>
  new Gauge({
    name,
    help,
    labelNames,
    registers: [registry],
  })

export const renderOcrAutoscalerMetrics = async (
  snapshot: OcrAutoscalerMetricsSnapshot | null,
  nowMs = Date.now(),
) => {
  const registry = new Registry()

  const ready = addGauge(
    registry,
    "xyne_ocr_autoscaler_snapshot_ready",
    "Whether the OCR autoscaler has completed at least one metrics snapshot.",
  )
  setGauge(ready, snapshot !== null)

  if (!snapshot) {
    return await registry.metrics()
  }

  const lastSuccess = addGauge(
    registry,
    "xyne_ocr_autoscaler_last_success_timestamp_seconds",
    "Unix timestamp for the latest completed OCR autoscaler metrics snapshot.",
  )
  setGauge(lastSuccess, snapshot.collectedAt.getTime() / 1000)

  setGauge(
    addGauge(registry, "xyne_ocr_pending_pages", "Pending OCR pages."),
    snapshot.counters.pendingOcrPages,
  )
  setGauge(
    addGauge(registry, "xyne_ocr_active_pages", "Active OCR pages."),
    snapshot.counters.activeOcrPages,
  )
  setGauge(
    addGauge(registry, "xyne_ocr_active_chunks", "Active OCR chunks."),
    snapshot.counters.activeOcrChunks,
  )
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_completed_pages_per_minute",
      "OCR pages completed in the last minute.",
    ),
    snapshot.counters.completedOcrPagesPerMinute,
  )

  setGauge(
    addGauge(
      registry,
      "xyne_ocr_decision_raw_admitted_pages",
      "Raw OCR admitted page decision before admission ramping.",
    ),
    snapshot.rawDecision.admittedPages,
  )
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_decision_effective_admitted_pages",
      "Effective OCR admitted page decision after admission ramping.",
    ),
    snapshot.effectiveDecision.admittedPages,
  )
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_decision_raw_submit_permits",
      "Raw OCR submit permit decision before admission ramping.",
    ),
    snapshot.rawDecision.submitPermits,
  )
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_decision_effective_submit_permits",
      "Effective OCR submit permit decision after admission ramping.",
    ),
    snapshot.effectiveDecision.submitPermits,
  )
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_decision_desired_wrapper_nodes",
      "Desired OCR wrapper node count.",
    ),
    snapshot.effectiveDecision.desiredWrapperNodes,
  )
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_decision_desired_a100_nodes",
      "Desired LightON A100 OCR node count.",
    ),
    snapshot.effectiveDecision.desiredA100Nodes,
  )
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_decision_desired_submitter_containers",
      "Desired OCR submitter container count.",
    ),
    snapshot.effectiveDecision.desiredSubmitterContainers,
  )
  const submitterContainers = addGauge(
    registry,
    "xyne_ocr_submitter_containers",
    "OCR submitter container count by bounded state.",
    ["state"],
  )
  setGauge(submitterContainers, snapshot.currentSubmitterContainers, {
    state: "current",
  })
  setGauge(
    submitterContainers,
    snapshot.effectiveDecision.desiredSubmitterContainers,
    {
      state: "desired",
    },
  )
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_decision_permit_fill_ratio",
      "OCR active page fill ratio against admitted page capacity.",
    ),
    snapshot.effectiveDecision.permitFillRatio,
  )
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_submitter_target_active_pages",
      "Target active OCR pages used by submitter capacity-fill sizing.",
    ),
    snapshot.rawDecision.targetActivePages,
  )
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_submitter_page_gap",
      "OCR pages needed to reach the submitter active-capacity fill target.",
    ),
    snapshot.rawDecision.submitterPageGap,
  )
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_submitter_completed_pages_per_second",
      "OCR completed page drain rate used by submitter sizing.",
    ),
    snapshot.rawDecision.completedOcrPagesPerSecond,
  )
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_submitter_required_pages_per_second",
      "Required OCR submit page rate used by submitter sizing.",
    ),
    snapshot.rawDecision.requiredSubmitPagesPerSecond,
  )
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_submitter_observed_pages_per_second",
      "Observed OCR accepted submit page rate inferred from active page movement.",
    ),
    snapshot.rawDecision.observedSubmitPagesPerSecond,
  )
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_submitter_observed_pages_per_second_per_container",
      "Observed OCR accepted submit page rate per submitter container.",
    ),
    snapshot.rawDecision.observedSubmitPagesPerSecondPerContainer,
  )
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_submitter_effective_pages_per_second_per_container",
      "Effective OCR submit page rate per container used by submitter sizing.",
    ),
    snapshot.rawDecision.effectiveSubmitPagesPerSecondPerContainer,
  )

  setGauge(
    addGauge(
      registry,
      "xyne_ocr_runtime_admitted_page_budget",
      "Runtime OCR admitted page budget read from Redis config.",
    ),
    snapshot.runtimeConfig.admittedPageBudget,
  )
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_runtime_submit_permits",
      "Runtime OCR submit permits read from Redis config.",
    ),
    snapshot.runtimeConfig.submitPermits,
  )
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_runtime_submitter_max_containers",
      "Runtime OCR submitter horizontal max container count read from Redis config.",
    ),
    snapshot.runtimeConfig.submitterMaxContainers,
  )
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_runtime_wrapper_min_nodes",
      "Runtime OCR wrapper minimum node count read from Redis config.",
    ),
    snapshot.runtimeConfig.wrapperMinNodes,
  )
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_runtime_a100_min_nodes",
      "Runtime LightON A100 minimum node count read from Redis config.",
    ),
    snapshot.runtimeConfig.a100MinNodes,
  )
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_runtime_vespa_write_permits",
      "Runtime Vespa write permits read from Redis config.",
    ),
    snapshot.runtimeConfig.vespaWritePermits,
  )
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_runtime_config_age_seconds",
      "Age in seconds of the Redis runtime config update; -1 means no valid update timestamp.",
    ),
    runtimeConfigAgeSeconds(snapshot.runtimeConfig, nowMs),
  )
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_runtime_config_autoscaler_written",
      "Whether the current runtime config version was written by the OCR autoscaler.",
    ),
    runtimeConfigWriter(snapshot.runtimeConfig) === "ocr-autoscaler",
  )
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_runtime_config_updated_timestamp_seconds",
      "Unix timestamp of the Redis runtime config update; 0 means no valid update timestamp.",
    ),
    snapshot.runtimeConfig.updatedAt
      ? Date.parse(snapshot.runtimeConfig.updatedAt) / 1000
      : 0,
  )
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_runtime_config_source_info",
      "Runtime config source and bounded writer classification.",
      ["source", "writer"],
    ),
    1,
    {
      source: snapshot.runtimeConfig.source,
      writer: runtimeConfigWriter(snapshot.runtimeConfig),
    },
  )

  const wrapperNodes = addGauge(
    registry,
    "xyne_ocr_wrapper_nodes",
    "OCR wrapper node count by bounded state.",
    ["state"],
  )
  setGauge(wrapperNodes, snapshot.wrapperFleet.currentNodes, {
    state: "current",
  })
  setGauge(
    wrapperNodes,
    snapshot.wrapperFleet.backendHealthyNodes ??
      snapshot.wrapperFleet.healthyNodes,
    {
      state: "backend_healthy",
    },
  )
  setGauge(wrapperNodes, snapshot.wrapperFleet.healthyNodes, {
    state: "app_healthy",
  })

  const a100Nodes = addGauge(
    registry,
    "xyne_ocr_a100_nodes",
    "LightON A100 OCR node count by bounded state.",
    ["state"],
  )
  setGauge(a100Nodes, snapshot.a100Fleet.currentNodes, { state: "current" })
  setGauge(a100Nodes, snapshot.a100Fleet.healthyNodes, { state: "healthy" })

  const costConfig = await loadOcrCostConfig()
  const nodeCostPerHour = addGauge(
    registry,
    "xyne_ocr_fleet_node_cost_per_hour",
    "Configured OCR fleet cost per node-hour by bounded fleet.",
    ["fleet", "currency"],
  )
  setGauge(nodeCostPerHour, costConfig.a100CostPerHour, {
    fleet: "a100",
    currency: costConfig.currency,
  })
  setGauge(nodeCostPerHour, costConfig.wrapperCostPerHour, {
    fleet: "wrapper",
    currency: costConfig.currency,
  })

  const fleetCostPerHour = addGauge(
    registry,
    "xyne_ocr_fleet_cost_per_hour",
    "Estimated current OCR fleet cost per hour by bounded fleet.",
    ["fleet", "currency"],
  )
  const a100CostPerHour =
    snapshot.a100Fleet.currentNodes * costConfig.a100CostPerHour
  const wrapperCostPerHour =
    snapshot.wrapperFleet.currentNodes * costConfig.wrapperCostPerHour
  setGauge(fleetCostPerHour, a100CostPerHour, {
    fleet: "a100",
    currency: costConfig.currency,
  })
  setGauge(fleetCostPerHour, wrapperCostPerHour, {
    fleet: "wrapper",
    currency: costConfig.currency,
  })
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_estimated_cost_per_hour",
      "Estimated current total OCR cost per hour across wrapper and A100 fleets.",
      ["currency"],
    ),
    a100CostPerHour + wrapperCostPerHour,
    { currency: costConfig.currency },
  )

  const discoveredTargets = addGauge(
    registry,
    "xyne_ocr_fleet_discovered_targets",
    "Direct Prometheus scrape targets discovered by the OCR autoscaler by bounded fleet.",
    ["fleet"],
  )
  setGauge(discoveredTargets, snapshot.a100Fleet.scrapeTargets?.length || 0, {
    fleet: "a100",
  })
  setGauge(
    discoveredTargets,
    snapshot.wrapperFleet.scrapeTargets?.length || 0,
    {
      fleet: "wrapper",
    },
  )

  const discoveryError = addGauge(
    registry,
    "xyne_ocr_fleet_discovery_error",
    "Whether latest OCR autoscaler discovery had an error by bounded fleet.",
    ["fleet"],
  )
  setGauge(discoveryError, snapshot.a100Fleet.discoveryError || false, {
    fleet: "a100",
  })
  setGauge(discoveryError, snapshot.wrapperFleet.discoveryError || false, {
    fleet: "wrapper",
  })

  setGauge(
    addGauge(
      registry,
      "xyne_ocr_a100_running_requests_total",
      "Current total running vLLM requests across healthy A100 nodes.",
    ),
    snapshot.a100Fleet.runningRequestsTotal,
  )
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_a100_capacity_waiting_total",
      "Current total vLLM capacity-waiting requests across healthy A100 nodes.",
    ),
    snapshot.a100Fleet.capacityWaitingTotal,
  )
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_a100_capacity_waiting_nodes",
      "Current healthy A100 nodes reporting capacity-waiting requests.",
    ),
    snapshot.a100Fleet.capacityWaitingNodes,
  )
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_a100_capacity_waiting_sustained",
      "Whether A100 capacity-waiting pressure has crossed the sustained threshold.",
    ),
    snapshot.a100Fleet.capacityWaitingSustained,
  )

  const activePermits = addGauge(
    registry,
    "xyne_ocr_redis_permits_active",
    "Active Redis scheduler permits by bounded kind.",
    ["kind"],
  )
  for (const [kind, count] of Object.entries(snapshot.redis.permitActive)) {
    setGauge(activePermits, count, { kind })
  }
  setGauge(
    addGauge(
      registry,
      "xyne_ocr_results_stream_length",
      "Redis result stream length.",
    ),
    snapshot.redis.resultsStreamLength,
  )
  const pendingStreamEntries = addGauge(
    registry,
    "xyne_ocr_results_stream_pending",
    "Redis result stream pending entries by bounded consumer group.",
    ["group"],
  )
  for (const [group, pending] of Object.entries(
    snapshot.redis.resultsStreamPending,
  )) {
    setGauge(pendingStreamEntries, pending, { group })
  }

  const filesTotal = addGauge(
    registry,
    "xyne_docling_files_total",
    "Docling async files by status.",
    ["status"],
  )
  const filePagesTotal = addGauge(
    registry,
    "xyne_docling_file_pages_total",
    "Docling async file pages by file status.",
    ["status"],
  )
  for (const row of snapshot.docling.files) {
    setGauge(filesTotal, row.count, { status: row.status })
    setGauge(filePagesTotal, row.pages, { status: row.status })
  }

  const partsTotal = addGauge(
    registry,
    "xyne_docling_parts_total",
    "Docling async parts by status.",
    ["status"],
  )
  const partPagesTotal = addGauge(
    registry,
    "xyne_docling_part_pages_total",
    "Docling async part pages by part status.",
    ["status"],
  )
  for (const row of snapshot.docling.parts) {
    setGauge(partsTotal, row.count, { status: row.status })
    setGauge(partPagesTotal, row.pages, { status: row.status })
  }
  setGauge(
    addGauge(
      registry,
      "xyne_docling_parts_missing_page_count_total",
      "Docling async parts with missing or invalid page_count values.",
    ),
    snapshot.docling.partsMissingPageCount,
  )

  return await registry.metrics()
}
