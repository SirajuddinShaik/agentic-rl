import { describe, expect, test } from "bun:test"

process.env.ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

const { buildRuntimeConfig } = await import("@/platform/lib/doclingRuntimeConfig")

describe("Docling runtime config", () => {
  test("accepts zero for throttle knobs", () => {
    const runtimeConfig = buildRuntimeConfig({
      submit_permits: "0",
      active_ocr_files: "0",
      admitted_page_budget: "0",
      vespa_write_permits: "0",
      page_chunk_size: "25",
      submitter_max_containers: "30",
      wrapper_min_nodes: "0",
      a100_min_nodes: "0",
    })

    expect(runtimeConfig.submitPermits).toBe(0)
    expect(runtimeConfig.activeOcrFiles).toBe(0)
    expect(runtimeConfig.admittedPageBudget).toBe(0)
    expect(runtimeConfig.vespaWritePermits).toBe(0)
    expect(runtimeConfig.submitterMaxContainers).toBe(30)
    expect(runtimeConfig.wrapperMinNodes).toBe(0)
    expect(runtimeConfig.a100MinNodes).toBe(0)
  })

  test("keeps page chunk size strictly positive", () => {
    const runtimeConfig = buildRuntimeConfig({
      submit_permits: "0",
      page_chunk_size: "0",
    })

    expect(runtimeConfig.pageChunkSize).toBeGreaterThan(0)
  })

  test("uses defaults only when Redis runtime config is absent", () => {
    const runtimeConfig = buildRuntimeConfig({})

    expect(runtimeConfig.admittedPageBudget).toBeGreaterThan(0)
    expect(runtimeConfig.submitterMaxContainers).toBe(30)
    expect(runtimeConfig.wrapperMinNodes).toBe(0)
    expect(runtimeConfig.a100MinNodes).toBe(0)
  })

  test("fails closed when Redis omits explicit page admission budget", () => {
    const runtimeConfig = buildRuntimeConfig({
      submit_permits: "7",
      page_chunk_size: "50",
    })

    expect(runtimeConfig.admittedPageBudget).toBe(0)
  })

  test("falls back to safe submitter max when Redis value is missing or invalid", () => {
    expect(
      buildRuntimeConfig({ submitter_max_containers: "0" })
        .submitterMaxContainers,
    ).toBe(30)
    expect(buildRuntimeConfig({}).submitterMaxContainers).toBe(30)
  })

  test("reads OCR fleet warm minimums from Redis runtime config", () => {
    const runtimeConfig = buildRuntimeConfig({
      wrapper_min_nodes: "2",
      a100_min_nodes: "3",
    })

    expect(runtimeConfig.wrapperMinNodes).toBe(2)
    expect(runtimeConfig.a100MinNodes).toBe(3)
  })
})
