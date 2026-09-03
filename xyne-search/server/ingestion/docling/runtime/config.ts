import config from "@/config"
import { getRedisClient } from "@/platform/lib/redisClient"
import { getLogger } from "@/platform/logger"
import { Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"

const Logger = getLogger(Subsystem.Queue).child({
  module: "doclingRuntimeConfig",
})

export type DoclingRuntimeConfig = {
  submitPermits: number
  activeOcrFiles: number
  perFileInflightParts: number
  admittedPageBudget: number
  perFileInflightPages: number
  splitterConcurrency: number
  submitterConcurrencyPerContainer: number
  submitterMaxContainers: number
  wrapperMinNodes: number
  a100MinNodes: number
  vespaWritePermits: number
  pageChunkSize: number
  pdfFileProcessingWorkerThreads: number
  pdfFileProcessingTeamSize: number
  version: string | null
  updatedAt: string | null
  source: "defaults" | "redis"
}

const DEFAULT_RUNTIME_CONFIG: DoclingRuntimeConfig = Object.freeze({
  submitPermits: config.doclingAsyncSubmitPermits,
  activeOcrFiles: config.doclingSchedulerActiveOcrFiles,
  perFileInflightParts: config.doclingSchedulerPerFileInflightParts,
  admittedPageBudget: config.doclingSchedulerAdmittedPageBudget,
  perFileInflightPages: config.doclingSchedulerPerFileInflightPages,
  splitterConcurrency: config.doclingSchedulerSplitConcurrency,
  submitterConcurrencyPerContainer:
    config.doclingSchedulerSubmitterConcurrency,
  submitterMaxContainers: 30,
  wrapperMinNodes: 0,
  a100MinNodes: 0,
  vespaWritePermits: config.doclingSchedulerVespaWritePermits,
  pageChunkSize: config.doclingPageChunkSize,
  pdfFileProcessingWorkerThreads: config.fileProcessingWorkerThreads,
  pdfFileProcessingTeamSize: config.fileProcessingTeamSize,
  version: null,
  updatedAt: null,
  source: "defaults",
})

let currentRuntimeConfig: DoclingRuntimeConfig = { ...DEFAULT_RUNTIME_CONFIG }
let refreshPromise: Promise<DoclingRuntimeConfig> | null = null
let pollTimer: NodeJS.Timeout | null = null
let pollingStarted = false

const parsePositiveInteger = (
  rawValue: string | undefined,
  fallback: number,
): number => {
  const parsed = Number.parseInt(rawValue || "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const parseNonNegativeInteger = (
  rawValue: string | undefined,
  fallback: number,
): number => {
  const parsed = Number.parseInt(rawValue || "", 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

const hasRuntimeValue = (payload: Record<string, string>, key: string) =>
  Object.prototype.hasOwnProperty.call(payload, key)

const sameRuntimeConfig = (
  left: DoclingRuntimeConfig,
  right: DoclingRuntimeConfig,
) =>
  left.submitPermits === right.submitPermits &&
  left.activeOcrFiles === right.activeOcrFiles &&
  left.perFileInflightParts === right.perFileInflightParts &&
  left.admittedPageBudget === right.admittedPageBudget &&
  left.perFileInflightPages === right.perFileInflightPages &&
  left.splitterConcurrency === right.splitterConcurrency &&
  left.submitterConcurrencyPerContainer ===
    right.submitterConcurrencyPerContainer &&
  left.submitterMaxContainers === right.submitterMaxContainers &&
  left.wrapperMinNodes === right.wrapperMinNodes &&
  left.a100MinNodes === right.a100MinNodes &&
  left.vespaWritePermits === right.vespaWritePermits &&
  left.pageChunkSize === right.pageChunkSize &&
  left.pdfFileProcessingWorkerThreads ===
    right.pdfFileProcessingWorkerThreads &&
  left.pdfFileProcessingTeamSize === right.pdfFileProcessingTeamSize &&
  left.version === right.version &&
  left.updatedAt === right.updatedAt &&
  left.source === right.source

export const buildRuntimeConfig = (
  payload: Record<string, string>,
): DoclingRuntimeConfig => {
  if (Object.keys(payload).length === 0) {
    return { ...DEFAULT_RUNTIME_CONFIG }
  }

  const pageChunkSize = parsePositiveInteger(
    payload.page_chunk_size,
    DEFAULT_RUNTIME_CONFIG.pageChunkSize,
  )
  const perFileInflightParts = parsePositiveInteger(
    payload.per_file_inflight_parts,
    DEFAULT_RUNTIME_CONFIG.perFileInflightParts,
  )
  const submitPermits = parseNonNegativeInteger(
    payload.submit_permits,
    DEFAULT_RUNTIME_CONFIG.submitPermits,
  )

  return {
    submitPermits,
    activeOcrFiles: parseNonNegativeInteger(
      payload.active_ocr_files,
      DEFAULT_RUNTIME_CONFIG.activeOcrFiles,
    ),
    perFileInflightParts,
    admittedPageBudget: parseNonNegativeInteger(
      hasRuntimeValue(payload, "admitted_page_budget")
        ? payload.admitted_page_budget
        : undefined,
      0,
    ),
    perFileInflightPages: parseNonNegativeInteger(
      payload.per_file_inflight_pages,
      perFileInflightParts * pageChunkSize,
    ),
    splitterConcurrency: parsePositiveInteger(
      payload.splitter_concurrency,
      DEFAULT_RUNTIME_CONFIG.splitterConcurrency,
    ),
    submitterConcurrencyPerContainer: parsePositiveInteger(
      payload.submitter_concurrency_per_container ||
        payload.submitter_concurrency,
      DEFAULT_RUNTIME_CONFIG.submitterConcurrencyPerContainer,
    ),
    submitterMaxContainers: parsePositiveInteger(
      payload.submitter_max_containers,
      DEFAULT_RUNTIME_CONFIG.submitterMaxContainers,
    ),
    wrapperMinNodes: parseNonNegativeInteger(
      payload.wrapper_min_nodes,
      DEFAULT_RUNTIME_CONFIG.wrapperMinNodes,
    ),
    a100MinNodes: parseNonNegativeInteger(
      payload.a100_min_nodes,
      DEFAULT_RUNTIME_CONFIG.a100MinNodes,
    ),
    vespaWritePermits: parseNonNegativeInteger(
      payload.vespa_write_permits,
      DEFAULT_RUNTIME_CONFIG.vespaWritePermits,
    ),
    pageChunkSize,
    pdfFileProcessingWorkerThreads: parsePositiveInteger(
      payload.pdf_file_processing_worker_threads,
      DEFAULT_RUNTIME_CONFIG.pdfFileProcessingWorkerThreads,
    ),
    pdfFileProcessingTeamSize: parsePositiveInteger(
      payload.pdf_file_processing_team_size,
      DEFAULT_RUNTIME_CONFIG.pdfFileProcessingTeamSize,
    ),
    version: payload.version || null,
    updatedAt: payload.updated_at || null,
    source: "redis",
  }
}

const schedulePoll = () => {
  if (!pollingStarted) {
    return
  }

  pollTimer = setTimeout(async () => {
    pollTimer = null
    await refreshDoclingRuntimeConfig()
    schedulePoll()
  }, config.doclingRuntimeConfigPollMs)

  pollTimer.unref?.()
}

export const getDoclingRuntimeConfig = (): DoclingRuntimeConfig =>
  currentRuntimeConfig

export const refreshDoclingRuntimeConfig =
  async (): Promise<DoclingRuntimeConfig> => {
    if (refreshPromise) {
      return refreshPromise
    }

    refreshPromise = (async () => {
      try {
        const redis = await getRedisClient()
        const payload = await redis.hGetAll(config.doclingRuntimeConfigKey)
        const nextRuntimeConfig = buildRuntimeConfig(payload)

        if (!sameRuntimeConfig(currentRuntimeConfig, nextRuntimeConfig)) {
          Logger.info(
            {
              redisKey: config.doclingRuntimeConfigKey,
              previous: currentRuntimeConfig,
              next: nextRuntimeConfig,
            },
            "Updated Docling runtime config from Redis",
          )
        }

        currentRuntimeConfig = nextRuntimeConfig
      } catch (error) {
        Logger.warn(
          {
            redisKey: config.doclingRuntimeConfigKey,
            error: getErrorMessage(error),
          },
          "Failed to refresh Docling runtime config from Redis; keeping previous values",
        )
      }

      return currentRuntimeConfig
    })().finally(() => {
      refreshPromise = null
    })

    return refreshPromise
  }

export const startDoclingRuntimeConfigPolling = () => {
  if (pollingStarted) {
    return
  }

  pollingStarted = true
  void refreshDoclingRuntimeConfig()
  schedulePoll()
}

export const stopDoclingRuntimeConfigPolling = () => {
  pollingStarted = false
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}
