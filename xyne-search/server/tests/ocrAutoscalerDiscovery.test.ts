import { describe, expect, test } from "bun:test"
import {
  applyWrapperHealthHysteresis,
  hostPortFromMetricsUrl,
  listHealthyBackendServiceEndpoints,
  renderPrometheusHttpSdTargetGroups,
  summarizeBackendServiceHealth,
  wrapperMetricsTarget,
} from "@/ingestion/autoscaler/discovery"

describe("OCR autoscaler discovery", () => {
  test("counts only healthy backend-service nodes", () => {
    const summary = summarizeBackendServiceHealth([
      {
        status: {
          healthStatus: [
            {
              healthState: "HEALTHY",
              instance:
                "https://www.googleapis.com/compute/v1/projects/p/zones/z/instances/wrapper-1",
            },
            {
              healthState: "UNHEALTHY",
              instance:
                "https://www.googleapis.com/compute/v1/projects/p/zones/z/instances/wrapper-2",
            },
            {
              healthState: "HEALTHY",
              ipAddress: "10.2.0.46",
              port: 8000,
            },
          ],
        },
      },
    ])

    expect(summary.healthyNodes).toBe(2)
    expect(summary.endpoints).toEqual(["wrapper-1", "10.2.0.46:8000"])
  })

  test("counts raw Compute API backend-service health responses", () => {
    const summary = summarizeBackendServiceHealth([
      {
        healthStatus: [
          {
            healthState: "HEALTHY",
            instance:
              "https://www.googleapis.com/compute/v1/projects/p/zones/z/instances/wrapper-1",
          },
        ],
      },
    ])

    expect(summary.healthyNodes).toBe(1)
    expect(summary.endpoints).toEqual(["wrapper-1"])
  })

  test("returns direct probe endpoints only when backend health includes IPs", () => {
    const endpoints = listHealthyBackendServiceEndpoints([
      {
        status: {
          healthStatus: [
            {
              healthState: "HEALTHY",
              instance:
                "https://www.googleapis.com/compute/v1/projects/p/zones/z/instances/wrapper-1",
              ipAddress: "10.2.0.46",
              port: 8000,
            },
            {
              healthState: "HEALTHY",
              instance:
                "https://www.googleapis.com/compute/v1/projects/p/zones/z/instances/wrapper-2",
            },
            {
              healthState: "UNHEALTHY",
              instance:
                "https://www.googleapis.com/compute/v1/projects/p/zones/z/instances/wrapper-3",
              ipAddress: "10.2.0.48",
              port: 8000,
            },
          ],
        },
      },
    ])

    expect(endpoints).toEqual([
      {
        label: "wrapper-1",
        ipAddress: "10.2.0.46",
        port: 8000,
      },
    ])
  })

  test("fails closed when backend-service health has no health statuses", () => {
    const summary = summarizeBackendServiceHealth([
      {
        backend:
          "https://www.googleapis.com/compute/v1/projects/p/zones/z/instanceGroups/wrapper-mig",
        status: {},
      },
    ])

    expect(summary.healthyNodes).toBe(0)
    expect(summary.endpoints).toEqual([])
  })

  test("keeps wrapper provisionally healthy until failure threshold is reached", () => {
    const endpoint = {
      label: "wrapper-1",
      ipAddress: "10.2.0.46",
      port: 8000,
    }
    const streaks = new Map<string, number>()

    for (let attempt = 1; attempt < 5; attempt += 1) {
      const result = applyWrapperHealthHysteresis(
        [{ endpoint, ok: false, error: "timeout" }],
        streaks,
        5,
      )

      expect(result.healthyEndpoints).toEqual(["wrapper-1"])
      expect(result.errors[0]).toContain(`health probe failed ${attempt}/5`)
      expect(result.errors[0]).toContain("keeping node provisionally healthy")
    }

    const result = applyWrapperHealthHysteresis(
      [{ endpoint, ok: false, error: "timeout" }],
      streaks,
      5,
    )

    expect(result.healthyEndpoints).toEqual([])
    expect(result.errors[0]).toContain("health probe failed 5/5")
    expect(result.errors[0]).toContain("marking node unhealthy")
  })

  test("resets wrapper health failure streak on success", () => {
    const endpoint = {
      label: "wrapper-1",
      ipAddress: "10.2.0.46",
      port: 8000,
    }
    const streaks = new Map<string, number>([["wrapper-1", 4]])

    const result = applyWrapperHealthHysteresis(
      [{ endpoint, ok: true }],
      streaks,
      5,
    )

    expect(result.healthyEndpoints).toEqual(["wrapper-1"])
    expect(result.errors).toEqual([])
    expect(streaks.get("wrapper-1")).toBe(0)
  })

  test("removes stale wrapper health failure streaks", () => {
    const endpoint = {
      label: "wrapper-1",
      ipAddress: "10.2.0.46",
      port: 8000,
    }
    const streaks = new Map<string, number>([
      ["wrapper-1", 2],
      ["wrapper-stale", 4],
    ])

    applyWrapperHealthHysteresis([{ endpoint, ok: true }], streaks, 5)

    expect(streaks.has("wrapper-stale")).toBe(false)
    expect(streaks.get("wrapper-1")).toBe(0)
  })

  test("normalizes metrics URLs to Prometheus host:port targets", () => {
    expect(
      hostPortFromMetricsUrl("http://host.docker.internal:8000/metrics"),
    ).toBe("host.docker.internal:8000")
    expect(hostPortFromMetricsUrl("http://10.2.0.62:8000/metrics")).toBe(
      "10.2.0.62:8000",
    )
    expect(() =>
      hostPortFromMetricsUrl("http://10.2.0.62:8000/instance_status"),
    ).toThrow("expected metrics path /metrics")
  })

  test("renders Prometheus HTTP SD target-group JSON", () => {
    expect(
      renderPrometheusHttpSdTargetGroups(
        ["10.2.0.62:8000", "10.2.0.62:8000", "10.2.0.63:8000"],
        { fleet: "a100", role: "vllm" },
      ),
    ).toEqual([
      {
        targets: ["10.2.0.62:8000", "10.2.0.63:8000"],
        labels: { fleet: "a100", role: "vllm" },
      },
    ])
    expect(renderPrometheusHttpSdTargetGroups([], { fleet: "a100" })).toEqual(
      [],
    )
  })

  test("builds wrapper metrics targets from healthy backend endpoints", () => {
    expect(
      wrapperMetricsTarget({
        label: "wrapper-1",
        ipAddress: "10.2.0.46",
        port: 8000,
      }),
    ).toBe("10.2.0.46:8000")
  })
})
