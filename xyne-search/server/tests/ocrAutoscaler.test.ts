import { describe, expect, test } from "bun:test"
import { computeOcrAutoscalerDecision } from "@/ingestion/autoscaler/decision"

const baseInput = {
  pendingOcrPages: 0,
  activeOcrPages: 0,
  pageChunkSize: 25,
  healthyWrapperNodes: 1,
  currentA100Nodes: 1,
  healthyA100Nodes: 1,
  a100CapacityWaitingSustained: false,
  wrapperHealthStable: true,
  wrapperPagesPerNode: 4000,
  a100PagesPerNode: 125,
  submitPermitsPerWrapper: 440,
  wrapperMinNodes: 1,
  wrapperMaxNodes: 10,
  a100MinNodes: 1,
  a100MaxNodes: 100,
  currentSubmitterContainers: 1,
  submitterFixedConcurrencyPerContainer: 80,
  submitterContainerMin: 1,
  submitterContainerMax: 8,
  submitterPagesPerSecondPerContainer: 10,
  submitterTargetFillSeconds: 10,
  completedOcrPagesPerSecond: 0,
  observedSubmitPagesPerSecond: null,
  permitFillTarget: 0.85,
  permitFillDownscaleTarget: 0.95,
}

describe("OCR autoscaler decisions", () => {
  test("uses page budget for admission and wrapper request cap for submit permits", () => {
    const decision25 = computeOcrAutoscalerDecision({
      ...baseInput,
      pendingOcrPages: 500,
      pageChunkSize: 25,
      healthyWrapperNodes: 1,
      healthyA100Nodes: 4,
    })
    const decision50 = computeOcrAutoscalerDecision({
      ...baseInput,
      pendingOcrPages: 500,
      pageChunkSize: 50,
      healthyWrapperNodes: 1,
      healthyA100Nodes: 4,
    })

    expect(decision25.admittedPages).toBe(500)
    expect(decision25.submitPermits).toBe(440)
    expect(decision50.admittedPages).toBe(500)
    expect(decision50.submitPermits).toBe(440)
  })

  test("lets tiny-pdf workloads use more chunk permits while page budget remains authoritative", () => {
    const decision = computeOcrAutoscalerDecision({
      ...baseInput,
      pendingOcrPages: 8100,
      healthyWrapperNodes: 10,
      healthyA100Nodes: 8,
      pageChunkSize: 25,
    })

    expect(decision.admittedPages).toBe(1000)
    expect(decision.submitPermits).toBe(1000)
  })

  test("allows submit permits up to the configured safe wrapper request envelope", () => {
    const decision = computeOcrAutoscalerDecision({
      ...baseInput,
      pendingOcrPages: 28_000,
      submitPermitsPerWrapper: 440,
      healthyWrapperNodes: 7,
      healthyA100Nodes: 23,
    })

    expect(decision.admittedPages).toBe(2875)
    expect(decision.submitPermits).toBe(2875)
  })

  test("caps submit permits at the wrapper request envelope", () => {
    const decision = computeOcrAutoscalerDecision({
      ...baseInput,
      pendingOcrPages: 28_000,
      submitPermitsPerWrapper: 440,
      healthyWrapperNodes: 7,
      healthyA100Nodes: 64,
    })

    expect(decision.admittedPages).toBe(8000)
    expect(decision.submitPermits).toBe(3080)
  })

  test("uses current healthy nodes for admission but demand for desired nodes", () => {
    const decision = computeOcrAutoscalerDecision({
      ...baseInput,
      pendingOcrPages: 1000,
      activeOcrPages: 250,
      healthyWrapperNodes: 1,
      healthyA100Nodes: 2,
    })

    expect(decision.admittedPages).toBe(250)
    expect(decision.desiredWrapperNodes).toBe(1)
    expect(decision.desiredA100Nodes).toBe(10)
  })

  test("does not admit against future nodes while scaling up from zero", () => {
    const decision = computeOcrAutoscalerDecision({
      ...baseInput,
      pendingOcrPages: 500,
      healthyWrapperNodes: 0,
      healthyA100Nodes: 0,
      currentA100Nodes: 0,
      wrapperMinNodes: 0,
      a100MinNodes: 0,
    })

    expect(decision.desiredWrapperNodes).toBe(1)
    expect(decision.desiredA100Nodes).toBe(4)
    expect(decision.retainedWrapperNodes).toBe(0)
    expect(decision.retainedA100Nodes).toBe(0)
    expect(decision.admittedPages).toBe(0)
    expect(decision.submitPermits).toBe(0)
  })

  test("caps admission to desired retained nodes while downscaling", () => {
    const decision = computeOcrAutoscalerDecision({
      ...baseInput,
      pendingOcrPages: 500,
      healthyWrapperNodes: 8,
      healthyA100Nodes: 32,
      currentA100Nodes: 32,
    })

    expect(decision.desiredWrapperNodes).toBe(1)
    expect(decision.desiredA100Nodes).toBe(4)
    expect(decision.rawWrapperBudgetPages).toBe(32_000)
    expect(decision.rawGpuBudgetPages).toBe(4000)
    expect(decision.retainedWrapperNodes).toBe(1)
    expect(decision.retainedA100Nodes).toBe(4)
    expect(decision.admittedPages).toBe(500)
    expect(decision.submitPermits).toBe(440)
  })

  test("drains admission immediately when demand and minimum fleet are zero", () => {
    const decision = computeOcrAutoscalerDecision({
      ...baseInput,
      healthyWrapperNodes: 1,
      healthyA100Nodes: 1,
      wrapperMinNodes: 0,
      a100MinNodes: 0,
    })

    expect(decision.desiredWrapperNodes).toBe(0)
    expect(decision.desiredA100Nodes).toBe(0)
    expect(decision.retainedWrapperNodes).toBe(0)
    expect(decision.retainedA100Nodes).toBe(0)
    expect(decision.admittedPages).toBe(0)
    expect(decision.submitPermits).toBe(0)
  })

  test("keeps warm minimum capacity admitted when minimum fleet is one", () => {
    const decision = computeOcrAutoscalerDecision({
      ...baseInput,
      healthyWrapperNodes: 1,
      healthyA100Nodes: 1,
      wrapperMinNodes: 1,
      a100MinNodes: 1,
    })

    expect(decision.desiredWrapperNodes).toBe(1)
    expect(decision.desiredA100Nodes).toBe(1)
    expect(decision.retainedWrapperNodes).toBe(1)
    expect(decision.retainedA100Nodes).toBe(1)
    expect(decision.admittedPages).toBe(125)
    expect(decision.submitPermits).toBe(125)
  })

  test("active OCR pages prevent scale-to-zero", () => {
    const decision = computeOcrAutoscalerDecision({
      ...baseInput,
      activeOcrPages: 100,
      healthyWrapperNodes: 1,
      healthyA100Nodes: 1,
      wrapperMinNodes: 0,
      a100MinNodes: 0,
    })

    expect(decision.desiredWrapperNodes).toBe(1)
    expect(decision.desiredA100Nodes).toBe(1)
    expect(decision.admittedPages).toBe(125)
    expect(decision.submitPermits).toBe(125)
  })

  test("uses configured per-container rate before submit throughput is sampled", () => {
    const decision = computeOcrAutoscalerDecision({
      ...baseInput,
      pendingOcrPages: 500,
      activeOcrPages: 10,
      healthyA100Nodes: 8,
      currentSubmitterContainers: 2,
    })

    expect(decision.desiredSubmitterConcurrencyPerContainer).toBe(80)
    expect(decision.targetActivePages).toBe(531.25)
    expect(decision.submitterPageGap).toBe(500)
    expect(decision.requiredSubmitPagesPerSecond).toBe(50)
    expect(decision.observedSubmitPagesPerSecond).toBe(0)
    expect(decision.effectiveSubmitPagesPerSecondPerContainer).toBe(10)
    expect(decision.desiredSubmitterContainers).toBe(5)
  })

  test("scales submitter containers from observed accepted page throughput", () => {
    const decision = computeOcrAutoscalerDecision({
      ...baseInput,
      pendingOcrPages: 500,
      activeOcrPages: 10,
      healthyA100Nodes: 8,
      currentSubmitterContainers: 2,
      completedOcrPagesPerSecond: 20,
      observedSubmitPagesPerSecond: 10,
    })

    expect(decision.submitterPageGap).toBe(500)
    expect(decision.requiredSubmitPagesPerSecond).toBe(70)
    expect(decision.observedSubmitPagesPerSecondPerContainer).toBe(5)
    expect(decision.effectiveSubmitPagesPerSecondPerContainer).toBe(5)
    expect(decision.desiredSubmitterContainers).toBe(8)
  })

  test("does not over-scale submitters when observed accepted throughput is enough", () => {
    const decision = computeOcrAutoscalerDecision({
      ...baseInput,
      pendingOcrPages: 500,
      activeOcrPages: 10,
      healthyA100Nodes: 8,
      currentSubmitterContainers: 2,
      observedSubmitPagesPerSecond: 100,
    })

    expect(decision.requiredSubmitPagesPerSecond).toBe(50)
    expect(decision.observedSubmitPagesPerSecondPerContainer).toBe(50)
    expect(decision.desiredSubmitterContainers).toBe(2)
  })

  test("drives to the submitter cap when sampled accepted throughput is zero", () => {
    const decision = computeOcrAutoscalerDecision({
      ...baseInput,
      pendingOcrPages: 500,
      activeOcrPages: 10,
      healthyA100Nodes: 8,
      currentSubmitterContainers: 2,
      observedSubmitPagesPerSecond: 0,
    })

    expect(decision.requiredSubmitPagesPerSecond).toBe(50)
    expect(decision.effectiveSubmitPagesPerSecondPerContainer).toBe(0)
    expect(decision.desiredSubmitterContainers).toBe(8)
  })

  test("honors the configured submitter horizontal scale cap", () => {
    const decision = computeOcrAutoscalerDecision({
      ...baseInput,
      pendingOcrPages: 4000,
      activeOcrPages: 0,
      healthyA100Nodes: 32,
      currentSubmitterContainers: 1,
      submitterContainerMax: 30,
      observedSubmitPagesPerSecond: 1,
    })

    expect(decision.submitterPageGap).toBe(3400)
    expect(decision.requiredSubmitPagesPerSecond).toBe(340)
    expect(decision.desiredSubmitterContainers).toBe(30)
  })

  test("does not increase submitter pressure while wrapper health is unstable", () => {
    const decision = computeOcrAutoscalerDecision({
      ...baseInput,
      pendingOcrPages: 990,
      activeOcrPages: 10,
      healthyWrapperNodes: 5,
      healthyA100Nodes: 8,
      currentSubmitterContainers: 2,
      wrapperHealthStable: false,
    })

    expect(decision.permitFillRatio).toBe(0.01)
    expect(decision.desiredSubmitterConcurrencyPerContainer).toBe(80)
    expect(decision.desiredSubmitterContainers).toBe(2)
  })

  test("holds submitter containers when A100 capacity waiting is sustained", () => {
    const decision = computeOcrAutoscalerDecision({
      ...baseInput,
      pendingOcrPages: 990,
      activeOcrPages: 10,
      healthyWrapperNodes: 5,
      healthyA100Nodes: 8,
      currentSubmitterContainers: 2,
      a100CapacityWaitingSustained: true,
    })

    expect(decision.desiredSubmitterConcurrencyPerContainer).toBe(80)
    expect(decision.desiredSubmitterContainers).toBe(2)
  })

  test("uses sustained A100 capacity waiting as a reactive scale-out signal", () => {
    const decision = computeOcrAutoscalerDecision({
      ...baseInput,
      pendingOcrPages: 0,
      activeOcrPages: 100,
      currentA100Nodes: 2,
      healthyA100Nodes: 2,
      a100CapacityWaitingSustained: true,
    })

    expect(decision.desiredA100Nodes).toBe(3)
  })

  test("holds submitter containers while active OCR work remains without pending OCR pages", () => {
    const decision = computeOcrAutoscalerDecision({
      ...baseInput,
      pendingOcrPages: 0,
      activeOcrPages: 100,
      healthyA100Nodes: 2,
      currentSubmitterContainers: 4,
    })

    expect(decision.desiredSubmitterConcurrencyPerContainer).toBe(80)
    expect(decision.desiredSubmitterContainers).toBe(4)
  })

  test("does not request more A100s than desired wrapper capacity can feed", () => {
    const decision = computeOcrAutoscalerDecision({
      ...baseInput,
      pendingOcrPages: 10_000,
      activeOcrPages: 0,
      wrapperMaxNodes: 1,
      a100MaxNodes: 100,
    })

    expect(decision.desiredWrapperNodes).toBe(1)
    expect(decision.desiredA100Nodes).toBe(32)
  })

  test("holds submitter containers inside the permit-fill hysteresis band", () => {
    const decision = computeOcrAutoscalerDecision({
      ...baseInput,
      pendingOcrPages: 500,
      activeOcrPages: 870,
      healthyWrapperNodes: 5,
      healthyA100Nodes: 8,
      currentSubmitterContainers: 3,
    })

    expect(decision.permitFillRatio).toBe(0.87)
    expect(decision.desiredSubmitterConcurrencyPerContainer).toBe(80)
    expect(decision.desiredSubmitterContainers).toBe(3)
  })

  test("holds submitter containers when permit budget is already filled but OCR work remains", () => {
    const decision = computeOcrAutoscalerDecision({
      ...baseInput,
      pendingOcrPages: 500,
      activeOcrPages: 980,
      healthyA100Nodes: 8,
      currentSubmitterContainers: 4,
    })

    expect(decision.permitFillRatio).toBe(0.98)
    expect(decision.desiredSubmitterConcurrencyPerContainer).toBe(80)
    expect(decision.desiredSubmitterContainers).toBe(4)
  })

  test("allows submitter scale-to-zero when configured", () => {
    const decision = computeOcrAutoscalerDecision({
      ...baseInput,
      submitterContainerMin: 0,
      currentSubmitterContainers: 2,
    })

    expect(decision.desiredSubmitterConcurrencyPerContainer).toBe(80)
    expect(decision.desiredSubmitterContainers).toBe(0)
  })
})
