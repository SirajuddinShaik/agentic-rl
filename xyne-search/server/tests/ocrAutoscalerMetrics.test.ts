import { describe, expect, test } from "bun:test"
import type { DoclingRuntimeConfig } from "@/platform/lib/doclingRuntimeConfig"
import type { OcrAutoscalerDecision } from "@/ingestion/autoscaler/decision"
import {
  loadOcrCostConfig,
  type OcrAutoscalerMetricsSnapshot,
  renderOcrAutoscalerMetrics,
  runtimeConfigAgeSeconds,
  runtimeConfigWriter,
} from "@/ingestion/autoscaler/metrics"

const baseDecision: OcrAutoscalerDecision = {
  demandPages: 1500,
  wrapperBudgetPages: 4000,
  gpuBudgetPages: 1000,
  rawWrapperBudgetPages: 8000,
  rawGpuBudgetPages: 2000,
  retainedWrapperNodes: 1,
  retainedA100Nodes: 8,
  admittedPages: 1000,
  submitPermits: 880,
  desiredWrapperNodes: 1,
  desiredA100Nodes: 8,
  permitFillRatio: 0.2,
  targetActivePages: 850,
  submitterPageGap: 650,
  completedOcrPagesPerSecond: 2.5,
  requiredSubmitPagesPerSecond: 13.33,
  observedSubmitPagesPerSecond: 7.5,
  observedSubmitPagesPerSecondPerContainer: 2.5,
  effectiveSubmitPagesPerSecondPerContainer: 2.5,
  desiredSubmitterConcurrencyPerContainer: 21,
  desiredSubmitterContainers: 3,
}

const baseRuntimeConfig: DoclingRuntimeConfig = {
  submitPermits: 440,
  activeOcrFiles: 10000,
  perFileInflightParts: 2,
  admittedPageBudget: 500,
  perFileInflightPages: 50,
  splitterConcurrency: 1,
  submitterConcurrencyPerContainer: 11,
  submitterMaxContainers: 30,
  wrapperMinNodes: 0,
  a100MinNodes: 0,
  vespaWritePermits: 2,
  pageChunkSize: 25,
  pdfFileProcessingWorkerThreads: 4,
  pdfFileProcessingTeamSize: 2,
  version: "ocr-autoscaler-2026-06-05T00:00:00.000Z",
  updatedAt: "2026-06-05T00:00:00.000Z",
  source: "redis",
}

const makeSnapshot = (
  overrides: Partial<OcrAutoscalerMetricsSnapshot> = {},
): OcrAutoscalerMetricsSnapshot => ({
  collectedAt: new Date("2026-06-05T00:00:30.000Z"),
  counters: {
    pendingOcrPages: 1200,
    activeOcrPages: 200,
    activeOcrChunks: 8,
    admittedOcrPages: 700,
    completedOcrPagesPerMinute: 125,
  },
  runtimeConfig: baseRuntimeConfig,
  rawDecision: baseDecision,
  effectiveDecision: {
    ...baseDecision,
    admittedPages: 500,
    submitPermits: 440,
    desiredSubmitterContainers: 2,
  },
  wrapperFleet: {
    currentNodes: 2,
    backendHealthyNodes: 2,
    healthyNodes: 1,
    scrapeTargets: ["10.2.0.46:8000"],
    discoveryError: false,
  },
  a100Fleet: {
    currentNodes: 8,
    healthyNodes: 7,
    scrapeTargets: ["10.2.0.62:8000", "10.2.0.63:8000"],
    discoveryError: true,
    runningRequestsTotal: 21,
    capacityWaitingTotal: 4,
    capacityWaitingNodes: 2,
    capacityWaitingSustained: true,
  },
  currentSubmitterContainers: 1,
  redis: {
    permitActive: {
      "ocr-submit": 10,
      "ocr-submit-pages": 250,
      "vespa-write": 1,
    },
    resultsStreamLength: 42,
    resultsStreamPending: {
      "app-sync": 3,
      "app-sync-scheduler": 0,
    },
  },
  docling: {
    files: [
      { status: "queued_for_ocr", count: 6, pages: 300 },
      { status: "ocr_active", count: 2, pages: 100 },
    ],
    parts: [
      { status: "queued", count: 12, pages: 300 },
      { status: "submitted", count: 8, pages: 200 },
    ],
    partsMissingPageCount: 0,
  },
  ...overrides,
})

describe("OCR autoscaler metrics", () => {
  test("exposes raw and effective ramped autoscaler decisions separately", async () => {
    const metrics = await renderOcrAutoscalerMetrics(
      makeSnapshot(),
      Date.parse("2026-06-05T00:00:30.000Z"),
    )

    expect(metrics).toContain("xyne_ocr_decision_raw_admitted_pages 1000")
    expect(metrics).toContain("xyne_ocr_decision_effective_admitted_pages 500")
    expect(metrics).toContain("xyne_ocr_decision_raw_submit_permits 880")
    expect(metrics).toContain("xyne_ocr_decision_effective_submit_permits 440")
    expect(metrics).toContain(
      'xyne_ocr_submitter_containers{state="current"} 1',
    )
    expect(metrics).toContain(
      'xyne_ocr_submitter_containers{state="desired"} 2',
    )
    expect(metrics).toContain("xyne_ocr_runtime_submitter_max_containers 30")
    expect(metrics).toContain("xyne_ocr_runtime_wrapper_min_nodes 0")
    expect(metrics).toContain("xyne_ocr_runtime_a100_min_nodes 0")
    expect(metrics).toContain("xyne_ocr_submitter_target_active_pages 850")
    expect(metrics).toContain("xyne_ocr_submitter_page_gap 650")
    expect(metrics).toContain(
      "xyne_ocr_submitter_completed_pages_per_second 2.5",
    )
    expect(metrics).toContain(
      "xyne_ocr_submitter_required_pages_per_second 13.33",
    )
    expect(metrics).toContain(
      "xyne_ocr_submitter_observed_pages_per_second 7.5",
    )
    expect(metrics).toContain(
      "xyne_ocr_submitter_observed_pages_per_second_per_container 2.5",
    )
    expect(metrics).toContain(
      "xyne_ocr_submitter_effective_pages_per_second_per_container 2.5",
    )
    expect(metrics).toContain(
      'xyne_ocr_fleet_discovered_targets{fleet="a100"} 2',
    )
    expect(metrics).toContain(
      'xyne_ocr_fleet_discovered_targets{fleet="wrapper"} 1',
    )
    expect(metrics).toContain('xyne_ocr_fleet_discovery_error{fleet="a100"} 1')
    expect(metrics).toContain(
      'xyne_ocr_fleet_discovery_error{fleet="wrapper"} 0',
    )
  })

  test("exposes runtime config source, writer, and age without dynamic version labels", async () => {
    const metrics = await renderOcrAutoscalerMetrics(
      makeSnapshot(),
      Date.parse("2026-06-05T00:00:30.000Z"),
    )

    expect(
      runtimeConfigAgeSeconds(
        baseRuntimeConfig,
        Date.parse("2026-06-05T00:00:30.000Z"),
      ),
    ).toBe(30)
    expect(runtimeConfigWriter(baseRuntimeConfig)).toBe("ocr-autoscaler")
    expect(metrics).toContain("xyne_ocr_runtime_config_age_seconds 30")
    expect(metrics).toContain("xyne_ocr_runtime_config_autoscaler_written 1")
    expect(metrics).toContain(
      'xyne_ocr_runtime_config_source_info{source="redis",writer="ocr-autoscaler"} 1',
    )
    expect(metrics).not.toContain("ocr-autoscaler-2026-06-05")
  })

  test("exposes missing or invalid part page counts as a first-class metric", async () => {
    const metrics = await renderOcrAutoscalerMetrics(
      makeSnapshot({
        docling: {
          files: [{ status: "ocr_active", count: 1, pages: 25 }],
          parts: [{ status: "queued", count: 2, pages: 25 }],
          partsMissingPageCount: 2,
        },
      }),
      Date.parse("2026-06-05T00:00:30.000Z"),
    )

    expect(metrics).toContain("xyne_docling_parts_missing_page_count_total 2")
    expect(metrics).toContain(
      'xyne_docling_part_pages_total{status="queued"} 25',
    )
  })

  test("exposes configurable OCR fleet cost metrics", async () => {
    const previousA100 = process.env.OCR_A100_COST_PER_HOUR
    const previousWrapper = process.env.OCR_WRAPPER_COST_PER_HOUR
    const previousCurrency = process.env.OCR_COST_CURRENCY
    const previousConfigPath = process.env.OCR_COST_CONFIG_PATH
    process.env.OCR_A100_COST_PER_HOUR = "12.5"
    process.env.OCR_WRAPPER_COST_PER_HOUR = "0.75"
    process.env.OCR_COST_CURRENCY = "USD"
    delete process.env.OCR_COST_CONFIG_PATH

    try {
      const costConfig = await loadOcrCostConfig()
      expect(costConfig).toEqual({
        currency: "USD",
        a100CostPerHour: 12.5,
        wrapperCostPerHour: 0.75,
      })

      const metrics = await renderOcrAutoscalerMetrics(
        makeSnapshot(),
        Date.parse("2026-06-05T00:00:30.000Z"),
      )

      expect(metrics).toContain(
        'xyne_ocr_fleet_node_cost_per_hour{fleet="a100",currency="USD"} 12.5',
      )
      expect(metrics).toContain(
        'xyne_ocr_fleet_node_cost_per_hour{fleet="wrapper",currency="USD"} 0.75',
      )
      expect(metrics).toContain(
        'xyne_ocr_fleet_cost_per_hour{fleet="a100",currency="USD"} 100',
      )
      expect(metrics).toContain(
        'xyne_ocr_fleet_cost_per_hour{fleet="wrapper",currency="USD"} 1.5',
      )
      expect(metrics).toContain(
        'xyne_ocr_estimated_cost_per_hour{currency="USD"} 101.5',
      )
    } finally {
      if (previousA100 === undefined) {
        delete process.env.OCR_A100_COST_PER_HOUR
      } else {
        process.env.OCR_A100_COST_PER_HOUR = previousA100
      }
      if (previousWrapper === undefined) {
        delete process.env.OCR_WRAPPER_COST_PER_HOUR
      } else {
        process.env.OCR_WRAPPER_COST_PER_HOUR = previousWrapper
      }
      if (previousCurrency === undefined) {
        delete process.env.OCR_COST_CURRENCY
      } else {
        process.env.OCR_COST_CURRENCY = previousCurrency
      }
      if (previousConfigPath === undefined) {
        delete process.env.OCR_COST_CONFIG_PATH
      } else {
        process.env.OCR_COST_CONFIG_PATH = previousConfigPath
      }
    }
  })

  test("renders parseable Prometheus text without NaN samples", async () => {
    const metrics = await renderOcrAutoscalerMetrics(
      makeSnapshot(),
      Date.parse("2026-06-05T00:00:30.000Z"),
    )
    const sampleLines = metrics
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))

    expect(metrics.endsWith("\n")).toBe(true)
    expect(metrics).not.toContain("NaN")
    expect(sampleLines.length).toBeGreaterThan(0)

    for (const line of sampleLines) {
      expect(line).toMatch(
        /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^{}]*\})? [-+]?(?:\d+|\d*\.\d+)(?:[eE][-+]?\d+)?$/,
      )
    }
  })
})
