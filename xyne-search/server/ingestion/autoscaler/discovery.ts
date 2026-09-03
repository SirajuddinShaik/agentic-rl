export type BackendServiceHealthStatus = {
  healthState?: string
  instance?: string
  ipAddress?: string
  port?: number
}

export type BackendServiceHealth = {
  backend?: string
  healthStatus?: BackendServiceHealthStatus[]
  status?: {
    healthStatus?: BackendServiceHealthStatus[]
  }
}

export type BackendServiceHealthyEndpoint = {
  label: string
  ipAddress: string
  port: number
}

export type WrapperHealthProbeOutcome = {
  endpoint: BackendServiceHealthyEndpoint
  ok: boolean
  error?: string
}

export type PrometheusHttpSdTargetGroup = {
  targets: string[]
  labels: Record<string, string>
}

const instanceNameFromSelfLink = (selfLink: string) => {
  const lastSegment = selfLink.split("/").filter(Boolean).at(-1)
  return lastSegment ? decodeURIComponent(lastSegment) : ""
}

const endpointLabelFromHealthStatus = (status: BackendServiceHealthStatus) => {
  if (status.instance) {
    return instanceNameFromSelfLink(status.instance)
  }
  if (status.ipAddress) {
    return status.port ? `${status.ipAddress}:${status.port}` : status.ipAddress
  }
  return ""
}

const backendServiceHealthStatuses = (group: BackendServiceHealth) =>
  group.status?.healthStatus || group.healthStatus || []

export const summarizeBackendServiceHealth = (
  health: BackendServiceHealth[],
) => {
  const endpoints: string[] = []
  let healthyNodes = 0
  for (const group of health) {
    for (const status of backendServiceHealthStatuses(group)) {
      if (status.healthState !== "HEALTHY") {
        continue
      }
      healthyNodes += 1
      const endpoint = endpointLabelFromHealthStatus(status)
      if (endpoint) {
        endpoints.push(endpoint)
      }
    }
  }
  return { healthyNodes, endpoints }
}

export const listHealthyBackendServiceEndpoints = (
  health: BackendServiceHealth[],
): BackendServiceHealthyEndpoint[] => {
  const endpoints: BackendServiceHealthyEndpoint[] = []
  for (const group of health) {
    for (const status of backendServiceHealthStatuses(group)) {
      if (status.healthState !== "HEALTHY" || !status.ipAddress) {
        continue
      }
      endpoints.push({
        label: endpointLabelFromHealthStatus(status) || status.ipAddress,
        ipAddress: status.ipAddress,
        port: status.port || 8000,
      })
    }
  }
  return endpoints
}

export const wrapperEndpointKey = (endpoint: BackendServiceHealthyEndpoint) =>
  endpoint.label || `${endpoint.ipAddress}:${endpoint.port}`

export const hostPortFromMetricsUrl = (
  rawUrl: string,
  expectedPath = "/metrics",
) => {
  const url = new URL(rawUrl)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${rawUrl}: expected http or https URL`)
  }

  const normalizedExpectedPath = expectedPath.startsWith("/")
    ? expectedPath
    : `/${expectedPath}`
  if (url.pathname !== normalizedExpectedPath) {
    throw new Error(
      `${rawUrl}: expected metrics path ${normalizedExpectedPath}`,
    )
  }

  return url.port ? `${url.hostname}:${url.port}` : url.hostname
}

export const wrapperMetricsTarget = (endpoint: BackendServiceHealthyEndpoint) =>
  `${endpoint.ipAddress}:${endpoint.port || 8000}`

export const renderPrometheusHttpSdTargetGroups = (
  targets: string[],
  labels: Record<string, string>,
): PrometheusHttpSdTargetGroup[] => {
  const uniqueTargets = [...new Set(targets)].filter(Boolean)
  if (uniqueTargets.length === 0) {
    return []
  }
  return [{ targets: uniqueTargets, labels }]
}

export const applyWrapperHealthHysteresis = (
  outcomes: WrapperHealthProbeOutcome[],
  failureStreaks: Map<string, number>,
  failureThreshold: number,
) => {
  const threshold = Math.max(1, Math.floor(failureThreshold))
  const activeKeys = new Set(
    outcomes.map((outcome) => wrapperEndpointKey(outcome.endpoint)),
  )
  for (const key of failureStreaks.keys()) {
    if (!activeKeys.has(key)) {
      failureStreaks.delete(key)
    }
  }

  const healthyEndpoints: string[] = []
  const errors: string[] = []
  for (const outcome of outcomes) {
    const key = wrapperEndpointKey(outcome.endpoint)
    const label = outcome.endpoint.label || key
    if (outcome.ok) {
      failureStreaks.set(key, 0)
      healthyEndpoints.push(label)
      continue
    }

    const failures = (failureStreaks.get(key) || 0) + 1
    failureStreaks.set(key, failures)
    const error = outcome.error || "unknown error"
    if (failures < threshold) {
      healthyEndpoints.push(label)
      errors.push(
        `${label}: health probe failed ${failures}/${threshold}; keeping node provisionally healthy: ${error}`,
      )
      continue
    }

    errors.push(
      `${label}: health probe failed ${failures}/${threshold}; marking node unhealthy: ${error}`,
    )
  }

  return {
    healthyEndpoints,
    errors,
  }
}
