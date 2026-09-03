import {
  exec as execCallback,
  execFile as execFileCallback,
} from "node:child_process"
import { randomUUID } from "node:crypto"
import { promisify } from "node:util"
import config from "@/config"
import {
  getDoclingRuntimeConfig,
  refreshDoclingRuntimeConfig,
} from "@/ingestion/docling/runtime/config"
import { getDoclingOcrPageCounters } from "@/ingestion/docling/scheduler/store"
import {
  type OcrAutoscalerDecision,
  computeOcrAutoscalerDecision,
} from "@/ingestion/autoscaler/decision"
import {
  type BackendServiceHealth,
  type BackendServiceHealthyEndpoint,
  applyWrapperHealthHysteresis,
  hostPortFromMetricsUrl,
  listHealthyBackendServiceEndpoints,
  renderPrometheusHttpSdTargetGroups,
  summarizeBackendServiceHealth,
  wrapperEndpointKey,
  wrapperMetricsTarget,
} from "@/ingestion/autoscaler/discovery"
import {
  OCR_AUTOSCALER_METRICS_CONTENT_TYPE,
  type OcrAutoscalerMetricsSnapshot,
  collectDoclingStatusMetrics,
  collectOcrAutoscalerRedisMetrics,
  renderOcrAutoscalerMetrics,
} from "@/ingestion/autoscaler/metrics"
import { getRedisClient } from "@/platform/lib/redisClient"
import { getErrorMessage } from "@/utils"

const execFile = promisify(execFileCallback)
const exec = promisify(execCallback)

type FleetState = {
  currentNodes: number
  backendHealthyNodes?: number
  healthyNodes: number
  endpoints: string[]
  scrapeTargets: string[]
  discoveryError: boolean
  errors: string[]
}

type A100FleetState = FleetState & {
  runningRequestsTotal: number
  capacityWaitingTotal: number
  capacityWaitingNodes: number
  capacityWaitingSustained: boolean
}

type GcpActuator = "gcloud" | "metadata"
type A100EndpointDiscovery = "static" | "mig"

type AutoscalerConfig = {
  dryRun: boolean
  once: boolean
  metricsEnabled: boolean
  metricsPort: number
  writeRuntimeConfig: boolean
  resizeMigs: boolean
  intervalMs: number
  lockKey: string
  lockTtlMs: number
  project: string
  zone: string
  gcpActuator: GcpActuator
  gcloudPath: string
  wrapperMig: string
  a100Mig: string
  wrapperBackendService: string
  wrapperBackendServiceRegion: string
  wrapperHealthPath: string
  wrapperHealthTimeoutMs: number
  wrapperHealthFailureThreshold: number
  a100MetricsUrls: string[]
  a100EndpointDiscovery: A100EndpointDiscovery
  a100MetricsPort: number
  a100MetricsPath: string
  wrapperPagesPerNode: number
  wrapperAsyncMaxInflight: number
  wrapperLightonConcurrency: number
  a100PagesPerNode: number
  submitPermitsPerWrapper: number
  wrapperMaxNodes: number
  a100MaxNodes: number
  scaleUpCooldownMs: number
  scaleDownCooldownMs: number
  submitterContainerCount: number
  submitterCountCommand: string | null
  submitterFixedConcurrencyPerContainer: number
  submitterContainerMin: number
  submitterPageChunkSize: number
  submitterPagesPerSecondPerContainer: number
  submitterTargetFillSeconds: number
  permitFillTarget: number
  permitFillDownscaleTarget: number
  a100CapacityWaitingSustainMs: number
  activeOcrFileLimit: number
  submitterScaleCommand: string | null
  simDemandPages: number[]
}

const numberFromEnv = (name: string, fallback: number) => {
  const parsed = Number.parseInt(process.env[name] || "", 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const positiveNumberFromEnv = (name: string, fallback: number) => {
  const parsed = numberFromEnv(name, fallback)
  return parsed > 0 ? parsed : fallback
}

const positiveFloatFromEnv = (name: string, fallback: number) => {
  const parsed = Number.parseFloat(process.env[name] || "")
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const boolFromEnv = (name: string, fallback: boolean) => {
  const value = process.env[name]
  if (value === undefined) return fallback
  return ["1", "true", "yes", "on"].includes(value.toLowerCase())
}

const listFromEnv = (name: string) =>
  (process.env[name] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)

const numberListFromEnv = (name: string) =>
  listFromEnv(name)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value) && value >= 0)

const pathFromEnv = (name: string, fallback: string) => {
  const value = (process.env[name] || fallback).trim() || fallback
  return value.startsWith("/") ? value : `/${value}`
}

const gcpActuatorFromEnv = (): GcpActuator => {
  const raw = process.env.OCR_AUTOSCALER_GCP_ACTUATOR || "gcloud"
  if (raw === "gcloud" || raw === "metadata") {
    return raw
  }
  throw new Error(
    `Invalid OCR_AUTOSCALER_GCP_ACTUATOR=${raw}; expected gcloud or metadata`,
  )
}

const a100EndpointDiscoveryFromEnv = (): A100EndpointDiscovery => {
  const raw = process.env.OCR_AUTOSCALER_A100_DISCOVERY || "static"
  if (raw === "static" || raw === "mig") {
    return raw
  }
  throw new Error(
    `Invalid OCR_AUTOSCALER_A100_DISCOVERY=${raw}; expected static or mig`,
  )
}

const regionFromZone = (zone: string) => zone.split("-").slice(0, -1).join("-")

const defaultWrapperMig = "lighton-ocr-wrapper-fleet-mig"

const wrapperBackendServiceFromMig = (migName: string) =>
  migName.endsWith("-mig")
    ? `${migName.slice(0, -"-mig".length)}-backend`
    : "lighton-ocr-wrapper-fleet-backend"

const buildConfig = (): AutoscalerConfig => {
  const zone = process.env.GCP_ZONE || ""
  const wrapperMig = process.env.OCR_AUTOSCALER_WRAPPER_MIG || defaultWrapperMig

  return {
    dryRun: boolFromEnv("OCR_AUTOSCALER_DRY_RUN", true),
    once:
      process.argv.includes("--once") ||
      boolFromEnv("OCR_AUTOSCALER_ONCE", false),
    metricsEnabled: boolFromEnv("OCR_AUTOSCALER_METRICS_ENABLED", true),
    metricsPort: positiveNumberFromEnv("OCR_AUTOSCALER_METRICS_PORT", 3021),
    writeRuntimeConfig: boolFromEnv(
      "OCR_AUTOSCALER_WRITE_RUNTIME_CONFIG",
      false,
    ),
    resizeMigs: boolFromEnv("OCR_AUTOSCALER_RESIZE_MIGS", false),
    intervalMs: positiveNumberFromEnv("OCR_AUTOSCALER_INTERVAL_MS", 30_000),
    lockKey:
      process.env.OCR_AUTOSCALER_LOCK_KEY || "docling:ocr-autoscaler:lock",
    lockTtlMs: positiveNumberFromEnv("OCR_AUTOSCALER_LOCK_TTL_MS", 90_000),
    project: process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "",
    zone,
    gcpActuator: gcpActuatorFromEnv(),
    gcloudPath: process.env.GCLOUD || "gcloud",
    wrapperMig,
    a100Mig: process.env.OCR_AUTOSCALER_A100_MIG || "lightonocr-fleet-mig",
    wrapperBackendService:
      process.env.OCR_AUTOSCALER_WRAPPER_BACKEND_SERVICE ||
      wrapperBackendServiceFromMig(wrapperMig),
    wrapperBackendServiceRegion:
      process.env.OCR_AUTOSCALER_WRAPPER_BACKEND_SERVICE_REGION ||
      regionFromZone(zone),
    wrapperHealthPath: pathFromEnv(
      "OCR_AUTOSCALER_WRAPPER_HEALTH_PATH",
      "/health",
    ),
    wrapperHealthTimeoutMs: positiveNumberFromEnv(
      "OCR_AUTOSCALER_WRAPPER_HEALTH_TIMEOUT_MS",
      15_000,
    ),
    wrapperHealthFailureThreshold: positiveNumberFromEnv(
      "OCR_AUTOSCALER_WRAPPER_HEALTH_FAILURE_THRESHOLD",
      5,
    ),
    a100MetricsUrls: listFromEnv("OCR_AUTOSCALER_A100_METRICS_URLS"),
    a100EndpointDiscovery: a100EndpointDiscoveryFromEnv(),
    a100MetricsPort: positiveNumberFromEnv(
      "OCR_AUTOSCALER_A100_METRICS_PORT",
      8000,
    ),
    a100MetricsPath: process.env.OCR_AUTOSCALER_A100_METRICS_PATH || "/metrics",
    wrapperPagesPerNode: positiveNumberFromEnv(
      "OCR_AUTOSCALER_WRAPPER_PAGES_PER_NODE",
      4000,
    ),
    wrapperAsyncMaxInflight: positiveNumberFromEnv(
      "OCR_AUTOSCALER_WRAPPER_ASYNC_MAX_INFLIGHT",
      125,
    ),
    wrapperLightonConcurrency: positiveNumberFromEnv(
      "OCR_AUTOSCALER_WRAPPER_LIGHTON_CONCURRENCY",
      250,
    ),
    a100PagesPerNode: positiveNumberFromEnv(
      "OCR_AUTOSCALER_A100_PAGES_PER_NODE",
      125,
    ),
    submitPermitsPerWrapper: positiveNumberFromEnv(
      "OCR_AUTOSCALER_SUBMIT_PERMITS_PER_WRAPPER",
      440,
    ),
    wrapperMaxNodes: positiveNumberFromEnv(
      "OCR_AUTOSCALER_WRAPPER_MAX_NODES",
      1,
    ),
    a100MaxNodes: positiveNumberFromEnv("OCR_AUTOSCALER_A100_MAX_NODES", 1),
    scaleUpCooldownMs: positiveNumberFromEnv(
      "OCR_AUTOSCALER_SCALE_UP_COOLDOWN_MS",
      2 * 60 * 1000,
    ),
    scaleDownCooldownMs: positiveNumberFromEnv(
      "OCR_AUTOSCALER_SCALE_DOWN_COOLDOWN_MS",
      20 * 60 * 1000,
    ),
    submitterContainerCount: positiveNumberFromEnv(
      "OCR_AUTOSCALER_SUBMITTER_CONTAINER_COUNT",
      1,
    ),
    submitterCountCommand:
      process.env.OCR_AUTOSCALER_SUBMITTER_COUNT_COMMAND || null,
    submitterFixedConcurrencyPerContainer: positiveNumberFromEnv(
      "OCR_AUTOSCALER_SUBMITTER_FIXED_CONCURRENCY",
      positiveNumberFromEnv("SUBMITTER_INNER_MAX", 80),
    ),
    submitterContainerMin: numberFromEnv("SUBMITTER_CONTAINER_MIN", 1),
    submitterPageChunkSize: positiveNumberFromEnv(
      "OCR_AUTOSCALER_SUBMITTER_PAGE_CHUNK_SIZE",
      1,
    ),
    submitterPagesPerSecondPerContainer: positiveFloatFromEnv(
      "OCR_AUTOSCALER_SUBMITTER_PAGES_PER_SECOND_PER_CONTAINER",
      120,
    ),
    submitterTargetFillSeconds: positiveNumberFromEnv(
      "OCR_AUTOSCALER_SUBMITTER_TARGET_FILL_SECONDS",
      60,
    ),
    permitFillTarget:
      Number.parseFloat(process.env.OCR_AUTOSCALER_PERMIT_FILL_TARGET || "") ||
      0.85,
    permitFillDownscaleTarget:
      Number.parseFloat(
        process.env.OCR_AUTOSCALER_PERMIT_FILL_DOWNSCALE_TARGET || "",
      ) || 0.95,
    a100CapacityWaitingSustainMs: positiveNumberFromEnv(
      "OCR_AUTOSCALER_A100_CAPACITY_WAITING_SUSTAIN_MS",
      3 * 60 * 1000,
    ),
    activeOcrFileLimit: positiveNumberFromEnv(
      "OCR_AUTOSCALER_ACTIVE_OCR_FILE_LIMIT",
      10_000,
    ),
    submitterScaleCommand:
      process.env.OCR_AUTOSCALER_SUBMITTER_SCALE_COMMAND || null,
    simDemandPages: numberListFromEnv("OCR_AUTOSCALER_SIM_DEMAND_PAGES"),
  }
}

const readMigCurrentNodes = async (
  autoscalerConfig: AutoscalerConfig,
  migName: string,
): Promise<number | null> => {
  if (!autoscalerConfig.project || !autoscalerConfig.zone) {
    return null
  }

  if (autoscalerConfig.gcpActuator === "metadata") {
    return await readMigCurrentNodesFromComputeApi(autoscalerConfig, migName)
  }

  const { stdout } = await execFile(autoscalerConfig.gcloudPath, [
    "compute",
    "instance-groups",
    "managed",
    "describe",
    migName,
    "--project",
    autoscalerConfig.project,
    "--zone",
    autoscalerConfig.zone,
    "--format",
    "value(targetSize)",
  ])
  const parsed = Number.parseInt(stdout.trim(), 10)
  return Number.isFinite(parsed) ? parsed : null
}

const metadataTokenUrl =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"

const fetchMetadataAccessToken = async () => {
  const response = await fetch(metadataTokenUrl, {
    headers: {
      "Metadata-Flavor": "Google",
    },
  })
  if (!response.ok) {
    throw new Error(
      `Metadata token request failed: ${response.status} ${response.statusText}`,
    )
  }

  const body = (await response.json()) as { access_token?: string }
  if (!body.access_token) {
    throw new Error("Metadata token response did not include access_token")
  }
  return body.access_token
}

const computeMigUrl = (autoscalerConfig: AutoscalerConfig, migName: string) =>
  `https://compute.googleapis.com/compute/v1/projects/${autoscalerConfig.project}/zones/${autoscalerConfig.zone}/instanceGroupManagers/${migName}`

const computeRegionalBackendServiceUrl = (
  autoscalerConfig: AutoscalerConfig,
  backendService: string,
) =>
  `https://compute.googleapis.com/compute/v1/projects/${autoscalerConfig.project}/regions/${autoscalerConfig.wrapperBackendServiceRegion}/backendServices/${backendService}`

const computeInstanceUrl = (
  autoscalerConfig: AutoscalerConfig,
  instanceName: string,
) =>
  `https://compute.googleapis.com/compute/v1/projects/${autoscalerConfig.project}/zones/${autoscalerConfig.zone}/instances/${instanceName}`

const fetchComputeApi = async <T>(
  url: string,
  init: RequestInit = {},
): Promise<T> => {
  const token = await fetchMetadataAccessToken()
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  })
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(
      `Compute API request failed: ${response.status} ${response.statusText}${body ? `: ${body}` : ""}`,
    )
  }

  const text = await response.text()
  return (text ? JSON.parse(text) : {}) as T
}

const readMigCurrentNodesFromComputeApi = async (
  autoscalerConfig: AutoscalerConfig,
  migName: string,
): Promise<number | null> => {
  const body = await fetchComputeApi<{ targetSize?: number }>(
    computeMigUrl(autoscalerConfig, migName),
  )
  const parsed = Number(body.targetSize)
  return Number.isFinite(parsed) ? parsed : null
}

type ManagedInstance = {
  instance?: string
  instanceStatus?: string
  currentAction?: string
}

type ComputeInstance = {
  networkInterfaces?: Array<{ networkIP?: string }>
}

type BackendService = {
  backends?: Array<{ group?: string }>
}

const instanceNameFromSelfLink = (selfLink: string) => {
  const lastSegment = selfLink.split("/").filter(Boolean).at(-1)
  return lastSegment ? decodeURIComponent(lastSegment) : ""
}

const listMigManagedInstancesFromComputeApi = async (
  autoscalerConfig: AutoscalerConfig,
  migName: string,
) => {
  const body = await fetchComputeApi<{ managedInstances?: ManagedInstance[] }>(
    `${computeMigUrl(autoscalerConfig, migName)}/listManagedInstances`,
    { method: "POST" },
  )
  return body.managedInstances || []
}

const readInstanceNetworkIpFromComputeApi = async (
  autoscalerConfig: AutoscalerConfig,
  instanceName: string,
) => {
  const body = await fetchComputeApi<ComputeInstance>(
    computeInstanceUrl(autoscalerConfig, instanceName),
  )
  return body.networkInterfaces?.[0]?.networkIP || ""
}

const a100MetricsTargetFromIp = (
  autoscalerConfig: AutoscalerConfig,
  networkIp: string,
) => `${networkIp}:${autoscalerConfig.a100MetricsPort}`

const discoverA100MetricsUrlsFromMig = async (
  autoscalerConfig: AutoscalerConfig,
) => {
  if (autoscalerConfig.gcpActuator !== "metadata") {
    throw new Error(
      "OCR_AUTOSCALER_A100_DISCOVERY=mig requires OCR_AUTOSCALER_GCP_ACTUATOR=metadata",
    )
  }
  if (!autoscalerConfig.project || !autoscalerConfig.zone) {
    throw new Error("GCP_PROJECT and GCP_ZONE are required for A100 discovery")
  }

  const managedInstances = await listMigManagedInstancesFromComputeApi(
    autoscalerConfig,
    autoscalerConfig.a100Mig,
  )
  const servingCandidates = managedInstances.filter(
    (instance) =>
      instance.instance &&
      instance.instanceStatus === "RUNNING" &&
      (!instance.currentAction || instance.currentAction === "NONE"),
  )

  const targets = await Promise.all(
    servingCandidates.map(async (instance) => {
      const name = instanceNameFromSelfLink(instance.instance || "")
      if (!name) {
        return null
      }
      const networkIp = await readInstanceNetworkIpFromComputeApi(
        autoscalerConfig,
        name,
      )
      return networkIp
        ? a100MetricsTargetFromIp(autoscalerConfig, networkIp)
        : null
    }),
  )

  return targets.filter((target): target is string => Boolean(target))
}

const a100MetricsUrlFromTarget = (
  autoscalerConfig: AutoscalerConfig,
  target: string,
) => {
  const path = autoscalerConfig.a100MetricsPath.replace(/^\/+/, "")
  return `http://${target}/${path}`
}

const resolveA100MetricsTargets = async (
  autoscalerConfig: AutoscalerConfig,
) => {
  if (autoscalerConfig.a100EndpointDiscovery === "static") {
    const targets: string[] = []
    const errors: string[] = []
    for (const url of autoscalerConfig.a100MetricsUrls) {
      try {
        targets.push(
          hostPortFromMetricsUrl(url, autoscalerConfig.a100MetricsPath),
        )
      } catch (error) {
        errors.push(getErrorMessage(error))
      }
    }
    return { targets, errors }
  }

  try {
    return {
      targets: await discoverA100MetricsUrlsFromMig(autoscalerConfig),
      errors: [],
    }
  } catch (error) {
    return {
      targets: [],
      errors: [
        `${autoscalerConfig.a100Mig}: failed A100 MIG endpoint discovery: ${getErrorMessage(error)}`,
      ],
    }
  }
}

const fetchText = async (url: string, timeoutMs = 3000) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`)
    }
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

const wrapperHealthFailureStreaks = new Map<string, number>()

const wrapperHealthUrl = (
  endpoint: BackendServiceHealthyEndpoint,
  healthPath: string,
) => `http://${endpoint.ipAddress}:${endpoint.port}${healthPath}`

const probeWrapperHealth = async (
  endpoint: BackendServiceHealthyEndpoint,
  autoscalerConfig: AutoscalerConfig,
) => {
  const url = wrapperHealthUrl(endpoint, autoscalerConfig.wrapperHealthPath)
  const body = await fetchText(url, autoscalerConfig.wrapperHealthTimeoutMs)
  if (!body.trim()) {
    throw new Error("empty response")
  }
}

const readPrometheusMetricTotal = (
  metricsText: string,
  metricName: string,
  labelPattern?: RegExp,
) => {
  let total = 0
  for (const line of metricsText.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) {
      continue
    }
    if (!trimmed.startsWith(metricName)) {
      continue
    }
    if (labelPattern && !labelPattern.test(trimmed)) {
      continue
    }
    const value = Number.parseFloat(trimmed.split(/\s+/).at(-1) || "")
    if (Number.isFinite(value)) {
      total += value
    }
  }
  return total
}

const readWrapperBackendServiceHealthFromComputeApi = async (
  autoscalerConfig: AutoscalerConfig,
) => {
  if (autoscalerConfig.gcpActuator !== "metadata") {
    throw new Error(
      "Compute API wrapper backend health discovery requires OCR_AUTOSCALER_GCP_ACTUATOR=metadata",
    )
  }
  if (
    !autoscalerConfig.project ||
    !autoscalerConfig.wrapperBackendServiceRegion ||
    !autoscalerConfig.wrapperBackendService
  ) {
    throw new Error(
      "GCP_PROJECT, OCR_AUTOSCALER_WRAPPER_BACKEND_SERVICE, and OCR_AUTOSCALER_WRAPPER_BACKEND_SERVICE_REGION are required for wrapper backend health discovery",
    )
  }

  const backendService = await fetchComputeApi<BackendService>(
    computeRegionalBackendServiceUrl(
      autoscalerConfig,
      autoscalerConfig.wrapperBackendService,
    ),
  )
  const groups = (backendService.backends || [])
    .map((backend) => backend.group)
    .filter((group): group is string => Boolean(group))

  const health = await Promise.all(
    groups.map((group) =>
      fetchComputeApi<BackendServiceHealth>(
        `${computeRegionalBackendServiceUrl(
          autoscalerConfig,
          autoscalerConfig.wrapperBackendService,
        )}/getHealth`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ group }),
        },
      ),
    ),
  )
  return health
}

const readWrapperBackendServiceHealthFromGcloud = async (
  autoscalerConfig: AutoscalerConfig,
) => {
  if (
    !autoscalerConfig.project ||
    !autoscalerConfig.wrapperBackendServiceRegion ||
    !autoscalerConfig.wrapperBackendService
  ) {
    throw new Error(
      "GCP_PROJECT, OCR_AUTOSCALER_WRAPPER_BACKEND_SERVICE, and OCR_AUTOSCALER_WRAPPER_BACKEND_SERVICE_REGION are required for wrapper backend health discovery",
    )
  }

  const { stdout } = await execFile(autoscalerConfig.gcloudPath, [
    "compute",
    "backend-services",
    "get-health",
    autoscalerConfig.wrapperBackendService,
    "--project",
    autoscalerConfig.project,
    "--region",
    autoscalerConfig.wrapperBackendServiceRegion,
    "--format",
    "json",
  ])
  const parsed = JSON.parse(stdout || "[]") as BackendServiceHealth[]
  return Array.isArray(parsed) ? parsed : [parsed]
}

const readWrapperBackendServiceHealth = async (
  autoscalerConfig: AutoscalerConfig,
) => {
  if (autoscalerConfig.gcpActuator === "metadata") {
    return await readWrapperBackendServiceHealthFromComputeApi(autoscalerConfig)
  }
  return await readWrapperBackendServiceHealthFromGcloud(autoscalerConfig)
}

const collectWrapperFleetState = async (input: {
  autoscalerConfig: AutoscalerConfig
}): Promise<FleetState> => {
  const errors: string[] = []
  const currentNodesOverride = numberFromEnv(
    "OCR_AUTOSCALER_WRAPPER_CURRENT_NODES",
    -1,
  )
  let currentNodesKnown = currentNodesOverride >= 0
  let currentNodes = currentNodesOverride >= 0 ? currentNodesOverride : 0

  try {
    const migNodes = await readMigCurrentNodes(
      input.autoscalerConfig,
      input.autoscalerConfig.wrapperMig,
    )
    if (migNodes !== null) {
      currentNodes = migNodes
      currentNodesKnown = true
    }
  } catch (error) {
    errors.push(getErrorMessage(error))
  }

  if (currentNodesKnown && currentNodes === 0) {
    return {
      currentNodes,
      backendHealthyNodes: 0,
      healthyNodes: 0,
      endpoints: [],
      scrapeTargets: [],
      discoveryError: errors.length > 0,
      errors,
    }
  }

  try {
    const health = await readWrapperBackendServiceHealth(input.autoscalerConfig)
    const summary = summarizeBackendServiceHealth(health)
    const appProbeTargets = listHealthyBackendServiceEndpoints(health)
    if (
      summary.healthyNodes > 0 &&
      appProbeTargets.length !== summary.healthyNodes
    ) {
      errors.push(
        `${input.autoscalerConfig.wrapperBackendService}: backend health returned ${summary.healthyNodes} healthy wrapper nodes but only ${appProbeTargets.length} probeable IP endpoints; treating healthy nodes as 0`,
      )
      return {
        currentNodes,
        backendHealthyNodes: summary.healthyNodes,
        healthyNodes: 0,
        endpoints: [],
        scrapeTargets: [],
        discoveryError: true,
        errors,
      }
    }

    const probeOutcomes = await Promise.all(
      appProbeTargets.map(async (endpoint) => {
        try {
          await probeWrapperHealth(endpoint, input.autoscalerConfig)
          return { endpoint, ok: true }
        } catch (error) {
          return {
            endpoint,
            ok: false,
            error: `${wrapperHealthUrl(
              endpoint,
              input.autoscalerConfig.wrapperHealthPath,
            )}: ${getErrorMessage(error)}`,
          }
        }
      }),
    )
    const appHealth = applyWrapperHealthHysteresis(
      probeOutcomes,
      wrapperHealthFailureStreaks,
      input.autoscalerConfig.wrapperHealthFailureThreshold,
    )
    errors.push(...appHealth.errors)

    if (currentNodes > 0 && summary.healthyNodes === 0) {
      errors.push(
        `${input.autoscalerConfig.wrapperBackendService}: backend service returned no healthy wrapper nodes`,
      )
    }
    if (
      currentNodes > 0 &&
      summary.healthyNodes > 0 &&
      appHealth.healthyEndpoints.length === 0
    ) {
      errors.push(
        `${input.autoscalerConfig.wrapperBackendService}: no app-healthy wrapper nodes`,
      )
    }
    return {
      currentNodes,
      backendHealthyNodes: summary.healthyNodes,
      healthyNodes: appHealth.healthyEndpoints.length,
      endpoints: appHealth.healthyEndpoints,
      scrapeTargets: probeOutcomes
        .filter((outcome) =>
          appHealth.healthyEndpoints.includes(
            outcome.endpoint.label || wrapperEndpointKey(outcome.endpoint),
          ),
        )
        .map((outcome) => wrapperMetricsTarget(outcome.endpoint)),
      discoveryError: errors.length > 0,
      errors,
    }
  } catch (error) {
    errors.push(
      `${input.autoscalerConfig.wrapperBackendService}: failed wrapper backend health discovery: ${getErrorMessage(error)}`,
    )
    return {
      currentNodes,
      backendHealthyNodes: 0,
      healthyNodes: 0,
      endpoints: [],
      scrapeTargets: [],
      discoveryError: true,
      errors,
    }
  }
}

const capacityWaitingSinceKey =
  "docling:ocr-autoscaler:a100-capacity-waiting-since"

const updateA100CapacityWaitingSustained = async (
  waitingTotal: number,
  sustainMs: number,
) => {
  const redis = await getRedisClient()
  if (waitingTotal <= 0) {
    await redis.del(capacityWaitingSinceKey)
    return false
  }

  const now = Date.now()
  const rawSince = await redis.get(capacityWaitingSinceKey)
  const since = Number.parseInt(rawSince || "", 10)
  if (!Number.isFinite(since) || since <= 0) {
    await redis.set(capacityWaitingSinceKey, String(now), {
      PX: Math.max(sustainMs * 2, 60_000),
    })
    return false
  }

  await redis.pExpire(capacityWaitingSinceKey, Math.max(sustainMs * 2, 60_000))
  return now - since >= sustainMs
}

const collectA100FleetState = async (input: {
  autoscalerConfig: AutoscalerConfig
}): Promise<A100FleetState> => {
  const errors: string[] = []
  const currentNodesOverride = numberFromEnv(
    "OCR_AUTOSCALER_A100_CURRENT_NODES",
    -1,
  )
  let currentNodesKnown = currentNodesOverride >= 0
  let currentNodes = currentNodesOverride >= 0 ? currentNodesOverride : 0
  try {
    const migNodes = await readMigCurrentNodes(
      input.autoscalerConfig,
      input.autoscalerConfig.a100Mig,
    )
    if (migNodes !== null) {
      currentNodes = migNodes
      currentNodesKnown = true
    }
  } catch (error) {
    errors.push(getErrorMessage(error))
  }

  if (currentNodesKnown && currentNodes === 0) {
    const capacityWaitingSustained = await updateA100CapacityWaitingSustained(
      0,
      input.autoscalerConfig.a100CapacityWaitingSustainMs,
    )
    return {
      currentNodes,
      healthyNodes: 0,
      endpoints: [],
      scrapeTargets: [],
      discoveryError: errors.length > 0,
      errors,
      runningRequestsTotal: 0,
      capacityWaitingTotal: 0,
      capacityWaitingNodes: 0,
      capacityWaitingSustained,
    }
  }

  const resolvedMetrics = await resolveA100MetricsTargets(
    input.autoscalerConfig,
  )
  const scrapeTargets = resolvedMetrics.targets
  errors.push(...resolvedMetrics.errors)
  if (scrapeTargets.length === 0) {
    errors.push(
      `${input.autoscalerConfig.a100Mig}: no A100 metrics endpoints discovered; treating healthy nodes as 0`,
    )
  }

  let healthyNodes = 0
  let runningRequestsTotal = 0
  let capacityWaitingTotal = 0
  let capacityWaitingNodes = 0

  for (const target of scrapeTargets) {
    const url = a100MetricsUrlFromTarget(input.autoscalerConfig, target)
    try {
      const metricsText = await fetchText(url)
      if (!metricsText.includes("vllm:num_requests_running")) {
        errors.push(`${url}: missing vllm:num_requests_running metric`)
        continue
      }
      healthyNodes += 1
      runningRequestsTotal += readPrometheusMetricTotal(
        metricsText,
        "vllm:num_requests_running",
      )
      const waiting = readPrometheusMetricTotal(
        metricsText,
        "vllm:num_requests_waiting_by_reason",
        /reason="capacity"/,
      )
      capacityWaitingTotal += waiting
      if (waiting > 0) {
        capacityWaitingNodes += 1
      }
    } catch (error) {
      errors.push(`${url}: ${getErrorMessage(error)}`)
    }
  }

  const capacityWaitingSustained = await updateA100CapacityWaitingSustained(
    capacityWaitingTotal,
    input.autoscalerConfig.a100CapacityWaitingSustainMs,
  )

  return {
    currentNodes,
    healthyNodes,
    endpoints: scrapeTargets,
    scrapeTargets,
    discoveryError: errors.length > 0,
    errors,
    runningRequestsTotal,
    capacityWaitingTotal,
    capacityWaitingNodes,
    capacityWaitingSustained,
  }
}

const writeRuntimeConfig = async (
  decision: OcrAutoscalerDecision,
  autoscalerConfig: AutoscalerConfig,
  runtimeConfig: ReturnType<typeof getDoclingRuntimeConfig>,
  activeOcrFileLimit: number,
) => {
  const redis = await getRedisClient()
  await redis.hSet(config.doclingRuntimeConfigKey, {
    admitted_page_budget: String(decision.admittedPages),
    max_inflight_pages: String(decision.admittedPages),
    submit_permits: String(decision.submitPermits),
    active_ocr_files: String(activeOcrFileLimit),
    target_active_ocr_files: String(activeOcrFileLimit),
    wrapper_async_max_inflight: String(
      autoscalerConfig.wrapperAsyncMaxInflight,
    ),
    wrapper_lighton_concurrency: String(
      autoscalerConfig.wrapperLightonConcurrency,
    ),
    page_chunk_size: String(autoscalerConfig.submitterPageChunkSize),
    submitter_concurrency_per_container: String(
      decision.desiredSubmitterConcurrencyPerContainer,
    ),
    submitter_max_containers: String(runtimeConfig.submitterMaxContainers),
    wrapper_min_nodes: String(runtimeConfig.wrapperMinNodes),
    a100_min_nodes: String(runtimeConfig.a100MinNodes),
    version: `ocr-autoscaler-${new Date().toISOString()}`,
    updated_at: new Date().toISOString(),
  })
}

const nonNegativeRuntimeNumber = (value: number) =>
  Number.isFinite(value) && value > 0 ? value : 0

const rampUp = (desired: number, current: number, step: number) => {
  if (desired <= current) {
    return desired
  }
  return Math.min(desired, current + step)
}

const applyAdmissionRamp = (
  decision: OcrAutoscalerDecision,
  runtimeConfig: ReturnType<typeof getDoclingRuntimeConfig>,
  autoscalerConfig: AutoscalerConfig,
): OcrAutoscalerDecision => {
  const currentAdmittedPages = nonNegativeRuntimeNumber(
    runtimeConfig.admittedPageBudget,
  )
  const currentSubmitPermits = nonNegativeRuntimeNumber(
    runtimeConfig.submitPermits,
  )
  const admittedRampStep = Math.max(
    autoscalerConfig.wrapperPagesPerNode,
    autoscalerConfig.a100PagesPerNode,
  )
  const submitPermitRampStep = Math.max(
    1,
    autoscalerConfig.submitPermitsPerWrapper,
  )
  const admittedPages = rampUp(
    decision.admittedPages,
    currentAdmittedPages,
    admittedRampStep,
  )
  const submitPermits = Math.min(
    admittedPages,
    rampUp(decision.submitPermits, currentSubmitPermits, submitPermitRampStep),
  )

  return {
    ...decision,
    admittedPages,
    submitPermits,
  }
}

const resizeMig = async (
  autoscalerConfig: AutoscalerConfig,
  migName: string,
  targetSize: number,
) => {
  if (!autoscalerConfig.project || !autoscalerConfig.zone) {
    throw new Error("GCP_PROJECT and GCP_ZONE are required to resize MIGs")
  }

  if (autoscalerConfig.gcpActuator === "metadata") {
    await fetchComputeApi(
      `${computeMigUrl(autoscalerConfig, migName)}/resize?size=${targetSize}`,
      { method: "POST" },
    )
    return
  }

  await execFile(autoscalerConfig.gcloudPath, [
    "compute",
    "instance-groups",
    "managed",
    "resize",
    migName,
    "--size",
    String(targetSize),
    "--project",
    autoscalerConfig.project,
    "--zone",
    autoscalerConfig.zone,
    "--quiet",
  ])
}

const cooldownField = (fleet: "wrapper" | "a100", direction: "up" | "down") =>
  `${fleet}_${direction}`

const cooldownKey = "docling:ocr-autoscaler:cooldowns"

const canResizeWithCooldown = async (input: {
  fleet: "wrapper" | "a100"
  currentNodes: number
  desiredNodes: number
  autoscalerConfig: AutoscalerConfig
}) => {
  if (input.currentNodes === input.desiredNodes) {
    return false
  }

  const direction = input.desiredNodes > input.currentNodes ? "up" : "down"
  const cooldownMs =
    direction === "up"
      ? input.autoscalerConfig.scaleUpCooldownMs
      : input.autoscalerConfig.scaleDownCooldownMs
  const redis = await getRedisClient()
  const field = cooldownField(input.fleet, direction)
  const rawLastResize = await redis.hGet(cooldownKey, field)
  const lastResizeAt = Number.parseInt(rawLastResize || "0", 10) || 0
  return Date.now() - lastResizeAt >= cooldownMs
}

const markResizeCooldown = async (
  fleet: "wrapper" | "a100",
  currentNodes: number,
  desiredNodes: number,
) => {
  if (currentNodes === desiredNodes) {
    return
  }
  const direction = desiredNodes > currentNodes ? "up" : "down"
  const redis = await getRedisClient()
  await redis.hSet(cooldownKey, {
    [cooldownField(fleet, direction)]: String(Date.now()),
  })
}

const scaleSubmitters = async (
  commandTemplate: string,
  targetCount: number,
) => {
  await exec(commandTemplate.replaceAll("{count}", String(targetCount)))
}

const readSubmitterContainerCount = async (
  autoscalerConfig: AutoscalerConfig,
) => {
  if (!autoscalerConfig.submitterCountCommand) {
    return autoscalerConfig.submitterContainerCount
  }

  const { stdout } = await exec(autoscalerConfig.submitterCountCommand)
  const parsed = Number.parseInt(stdout.trim(), 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `Submitter count command returned invalid count: ${stdout.trim()}`,
    )
  }
  return parsed
}

let latestMetricsSnapshot: OcrAutoscalerMetricsSnapshot | null = null
let simDemandStep = 0
let previousSubmitterThroughputSample: {
  sampledAtMs: number
  activeOcrPages: number
} | null = null

const prometheusSdLabels = (
  autoscalerConfig: AutoscalerConfig,
  fleet: "a100" | "wrapper",
) => ({
  fleet,
  role: fleet === "a100" ? "vllm" : "ocr-wrapper",
  project: autoscalerConfig.project,
  zone: autoscalerConfig.zone,
})

const prometheusSdResponse = (
  autoscalerConfig: AutoscalerConfig,
  fleet: "a100" | "wrapper",
) => {
  const targets =
    fleet === "a100"
      ? latestMetricsSnapshot?.a100Fleet.scrapeTargets || []
      : latestMetricsSnapshot?.wrapperFleet.scrapeTargets || []
  return Response.json(
    renderPrometheusHttpSdTargetGroups(
      targets,
      prometheusSdLabels(autoscalerConfig, fleet),
    ),
  )
}

const startMetricsServer = (autoscalerConfig: AutoscalerConfig) => {
  if (!autoscalerConfig.metricsEnabled) {
    return null
  }

  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: autoscalerConfig.metricsPort,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/metrics") {
        return new Response(
          await renderOcrAutoscalerMetrics(latestMetricsSnapshot),
          {
            headers: {
              "content-type": OCR_AUTOSCALER_METRICS_CONTENT_TYPE,
            },
          },
        )
      }

      if (url.pathname === "/prometheus/targets/vllm") {
        return prometheusSdResponse(autoscalerConfig, "a100")
      }

      if (url.pathname === "/prometheus/targets/wrapper") {
        return prometheusSdResponse(autoscalerConfig, "wrapper")
      }

      if (url.pathname === "/health") {
        return new Response("ok\n", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        })
      }

      return new Response("not found\n", { status: 404 })
    },
  })

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      message: "OCR autoscaler metrics server started",
      port: autoscalerConfig.metricsPort,
    }),
  )
  return server
}

const maybeActuate = async (input: {
  autoscalerConfig: AutoscalerConfig
  decision: OcrAutoscalerDecision
  runtimeConfig: ReturnType<typeof getDoclingRuntimeConfig>
  wrapperFleet: FleetState
  a100Fleet: A100FleetState
  currentSubmitterContainers: number
  ensureLockOwned: () => Promise<void>
}) => {
  const { autoscalerConfig, decision } = input
  if (autoscalerConfig.dryRun) {
    return
  }

  if (autoscalerConfig.writeRuntimeConfig) {
    await input.ensureLockOwned()
    await writeRuntimeConfig(
      decision,
      autoscalerConfig,
      input.runtimeConfig,
      autoscalerConfig.activeOcrFileLimit,
    )
  }

  if (autoscalerConfig.resizeMigs) {
    if (
      await canResizeWithCooldown({
        fleet: "wrapper",
        currentNodes: input.wrapperFleet.currentNodes,
        desiredNodes: decision.desiredWrapperNodes,
        autoscalerConfig,
      })
    ) {
      await input.ensureLockOwned()
      await resizeMig(
        autoscalerConfig,
        autoscalerConfig.wrapperMig,
        decision.desiredWrapperNodes,
      )
      await input.ensureLockOwned()
      await markResizeCooldown(
        "wrapper",
        input.wrapperFleet.currentNodes,
        decision.desiredWrapperNodes,
      )
    }
    if (
      await canResizeWithCooldown({
        fleet: "a100",
        currentNodes: input.a100Fleet.currentNodes,
        desiredNodes: decision.desiredA100Nodes,
        autoscalerConfig,
      })
    ) {
      await input.ensureLockOwned()
      await resizeMig(
        autoscalerConfig,
        autoscalerConfig.a100Mig,
        decision.desiredA100Nodes,
      )
      await input.ensureLockOwned()
      await markResizeCooldown(
        "a100",
        input.a100Fleet.currentNodes,
        decision.desiredA100Nodes,
      )
    }
  }

  if (
    autoscalerConfig.submitterScaleCommand &&
    decision.desiredSubmitterContainers !== input.currentSubmitterContainers
  ) {
    await input.ensureLockOwned()
    await scaleSubmitters(
      autoscalerConfig.submitterScaleCommand,
      decision.desiredSubmitterContainers,
    )
  }
}

const applySimulatedDemand = (
  counters: Awaited<ReturnType<typeof getDoclingOcrPageCounters>>,
  autoscalerConfig: AutoscalerConfig,
) => {
  if (autoscalerConfig.simDemandPages.length === 0) {
    return counters
  }

  const pendingOcrPages =
    autoscalerConfig.simDemandPages[
      simDemandStep % autoscalerConfig.simDemandPages.length
    ] || 0
  simDemandStep += 1
  return {
    ...counters,
    pendingOcrPages,
    activeOcrPages: 0,
    activeOcrChunks: 0,
    admittedOcrPages: pendingOcrPages,
  }
}

const inferSubmitterThroughput = (
  counters: Awaited<ReturnType<typeof getDoclingOcrPageCounters>>,
  sampledAtMs = Date.now(),
) => {
  const completedOcrPagesPerSecond = Math.max(
    counters.completedOcrPagesPerMinute,
    0,
  ) / 60
  let observedSubmitPagesPerSecond: number | null = null

  if (
    previousSubmitterThroughputSample &&
    sampledAtMs > previousSubmitterThroughputSample.sampledAtMs
  ) {
    const elapsedSeconds =
      (sampledAtMs - previousSubmitterThroughputSample.sampledAtMs) / 1000
    const activeDelta =
      counters.activeOcrPages -
      previousSubmitterThroughputSample.activeOcrPages
    observedSubmitPagesPerSecond = Math.max(
      0,
      completedOcrPagesPerSecond + activeDelta / elapsedSeconds,
    )
  }

  previousSubmitterThroughputSample = {
    sampledAtMs,
    activeOcrPages: counters.activeOcrPages,
  }

  return {
    completedOcrPagesPerSecond,
    observedSubmitPagesPerSecond,
  }
}

const runOnce = async (
  autoscalerConfig: AutoscalerConfig,
  ensureLockOwned: () => Promise<void>,
) => {
  await refreshDoclingRuntimeConfig()
  const runtimeConfig = getDoclingRuntimeConfig()
  const [
    counters,
    wrapperFleet,
    a100Fleet,
    currentSubmitterContainers,
    redisMetrics,
    doclingStatusMetrics,
  ] = await Promise.all([
    getDoclingOcrPageCounters(),
    collectWrapperFleetState({ autoscalerConfig }),
    collectA100FleetState({
      autoscalerConfig,
    }),
    readSubmitterContainerCount(autoscalerConfig),
    collectOcrAutoscalerRedisMetrics(),
    collectDoclingStatusMetrics(),
  ])

  const effectiveCounters = applySimulatedDemand(counters, autoscalerConfig)
  const submitterThroughput = inferSubmitterThroughput(effectiveCounters)

  const rawDecision = computeOcrAutoscalerDecision({
    pendingOcrPages: effectiveCounters.pendingOcrPages,
    activeOcrPages: effectiveCounters.activeOcrPages,
    pageChunkSize: runtimeConfig.pageChunkSize,
    healthyWrapperNodes: wrapperFleet.healthyNodes,
    currentA100Nodes: a100Fleet.currentNodes,
    healthyA100Nodes: a100Fleet.healthyNodes,
    a100CapacityWaitingSustained: a100Fleet.capacityWaitingSustained,
    wrapperHealthStable: wrapperFleet.errors.length === 0,
    wrapperPagesPerNode: autoscalerConfig.wrapperPagesPerNode,
    a100PagesPerNode: autoscalerConfig.a100PagesPerNode,
    submitPermitsPerWrapper: autoscalerConfig.submitPermitsPerWrapper,
    wrapperMinNodes: runtimeConfig.wrapperMinNodes,
    wrapperMaxNodes: autoscalerConfig.wrapperMaxNodes,
    a100MinNodes: runtimeConfig.a100MinNodes,
    a100MaxNodes: autoscalerConfig.a100MaxNodes,
    currentSubmitterContainers,
    submitterFixedConcurrencyPerContainer:
      autoscalerConfig.submitterFixedConcurrencyPerContainer,
    submitterContainerMin: autoscalerConfig.submitterContainerMin,
    submitterContainerMax: runtimeConfig.submitterMaxContainers,
    submitterPagesPerSecondPerContainer:
      autoscalerConfig.submitterPagesPerSecondPerContainer,
    submitterTargetFillSeconds: autoscalerConfig.submitterTargetFillSeconds,
    completedOcrPagesPerSecond: submitterThroughput.completedOcrPagesPerSecond,
    observedSubmitPagesPerSecond:
      submitterThroughput.observedSubmitPagesPerSecond,
    permitFillTarget: autoscalerConfig.permitFillTarget,
    permitFillDownscaleTarget: autoscalerConfig.permitFillDownscaleTarget,
  })
  const decision = applyAdmissionRamp(
    rawDecision,
    runtimeConfig,
    autoscalerConfig,
  )

  latestMetricsSnapshot = {
    collectedAt: new Date(),
    counters: effectiveCounters,
    runtimeConfig,
    rawDecision,
    effectiveDecision: decision,
    wrapperFleet,
    a100Fleet,
    currentSubmitterContainers,
    redis: redisMetrics,
    docling: doclingStatusMetrics,
  }

  await maybeActuate({
    autoscalerConfig,
    decision,
    runtimeConfig,
    wrapperFleet,
    a100Fleet,
    currentSubmitterContainers,
    ensureLockOwned,
  })

  console.log(
    JSON.stringify(
      {
        ts: new Date().toISOString(),
        dryRun: autoscalerConfig.dryRun,
        wrapperHealthProbe: {
          path: autoscalerConfig.wrapperHealthPath,
          timeoutMs: autoscalerConfig.wrapperHealthTimeoutMs,
          failureThreshold: autoscalerConfig.wrapperHealthFailureThreshold,
        },
        counters: effectiveCounters,
        simulatedDemandPages: autoscalerConfig.simDemandPages,
        runtimeConfig,
        wrapperFleet,
        a100Fleet,
        currentSubmitterContainers,
        rawDecision,
        decision,
      },
      null,
      2,
    ),
  )
}

const acquireLock = async (
  autoscalerConfig: AutoscalerConfig,
  token: string,
) => {
  const redis = await getRedisClient()
  const result = await redis.set(autoscalerConfig.lockKey, token, {
    NX: true,
    PX: autoscalerConfig.lockTtlMs,
  })
  return result === "OK"
}

const renewLock = async (autoscalerConfig: AutoscalerConfig, token: string) => {
  const redis = await getRedisClient()
  const result = await redis.sendCommand([
    "EVAL",
    `if redis.call("GET", KEYS[1]) == ARGV[1] then
       return redis.call("PEXPIRE", KEYS[1], ARGV[2])
     end
     return 0`,
    "1",
    autoscalerConfig.lockKey,
    token,
    String(autoscalerConfig.lockTtlMs),
  ])
  return Number(result) > 0
}

const releaseLock = async (
  autoscalerConfig: AutoscalerConfig,
  token: string,
) => {
  const redis = await getRedisClient()
  await redis.sendCommand([
    "EVAL",
    `if redis.call("GET", KEYS[1]) == ARGV[1] then
       return redis.call("DEL", KEYS[1])
     end
     return 0`,
    "1",
    autoscalerConfig.lockKey,
    token,
  ])
}

const main = async () => {
  const autoscalerConfig = buildConfig()
  const metricsServer = startMetricsServer(autoscalerConfig)
  if (
    autoscalerConfig.submitterScaleCommand &&
    !autoscalerConfig.submitterCountCommand
  ) {
    throw new Error(
      "OCR_AUTOSCALER_SUBMITTER_COUNT_COMMAND is required when OCR_AUTOSCALER_SUBMITTER_SCALE_COMMAND is set",
    )
  }

  const token = randomUUID()
  const locked = await acquireLock(autoscalerConfig, token)
  if (!locked) {
    throw new Error(`Another OCR autoscaler owns ${autoscalerConfig.lockKey}`)
  }

  let lockLostError: Error | null = null
  const recordLostLock = (message: string) => {
    if (!lockLostError) {
      lockLostError = new Error(message)
    }
    return lockLostError
  }
  const ensureLockOwned = async () => {
    if (lockLostError) {
      throw lockLostError
    }

    const renewed = await renewLock(autoscalerConfig, token)
    if (!renewed) {
      throw recordLostLock(
        `Lost OCR autoscaler lock ownership for ${autoscalerConfig.lockKey}`,
      )
    }
  }

  const renewTimer = setInterval(
    () => {
      void (async () => {
        try {
          const renewed = await renewLock(autoscalerConfig, token)
          if (!renewed) {
            clearInterval(renewTimer)
            const error = recordLostLock(
              `Lost OCR autoscaler lock ownership for ${autoscalerConfig.lockKey}`,
            )
            console.error(
              JSON.stringify({
                ts: new Date().toISOString(),
                error: error.message,
                message: "OCR autoscaler lock ownership lost",
              }),
            )
          }
        } catch (error) {
          clearInterval(renewTimer)
          const lostLockError = recordLostLock(
            `Failed to renew OCR autoscaler lock: ${getErrorMessage(error)}`,
          )
          console.error(
            JSON.stringify({
              ts: new Date().toISOString(),
              error: lostLockError.message,
              message: "Failed to renew OCR autoscaler lock",
            }),
          )
        }
      })()
    },
    Math.max(Math.floor(autoscalerConfig.lockTtlMs / 3), 1000),
  )

  try {
    do {
      await ensureLockOwned()
      await runOnce(autoscalerConfig, ensureLockOwned)
      if (lockLostError) {
        throw lockLostError
      }
      if (!autoscalerConfig.once) {
        await new Promise((resolve) =>
          setTimeout(resolve, autoscalerConfig.intervalMs),
        )
      }
    } while (!autoscalerConfig.once)
  } finally {
    clearInterval(renewTimer)
    await releaseLock(autoscalerConfig, token)
    metricsServer?.stop(true)
  }
}

void main()
  .then(() => {
    process.exit(0)
  })
  .catch((error) => {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        error: getErrorMessage(error),
        message: "OCR autoscaler failed",
      }),
    )
    process.exit(1)
  })
