export type OcrAutoscalerInput = {
  pendingOcrPages: number
  activeOcrPages: number
  pageChunkSize: number
  healthyWrapperNodes: number
  currentA100Nodes: number
  healthyA100Nodes: number
  a100CapacityWaitingSustained: boolean
  wrapperHealthStable: boolean
  wrapperPagesPerNode: number
  a100PagesPerNode: number
  submitPermitsPerWrapper: number
  wrapperMinNodes: number
  wrapperMaxNodes: number
  a100MinNodes: number
  a100MaxNodes: number
  currentSubmitterContainers: number
  submitterFixedConcurrencyPerContainer: number
  submitterContainerMin: number
  submitterContainerMax: number
  submitterPagesPerSecondPerContainer: number
  submitterTargetFillSeconds: number
  completedOcrPagesPerSecond: number
  observedSubmitPagesPerSecond: number | null
  permitFillTarget: number
  permitFillDownscaleTarget: number
}

export type OcrAutoscalerDecision = {
  demandPages: number
  wrapperBudgetPages: number
  gpuBudgetPages: number
  rawWrapperBudgetPages: number
  rawGpuBudgetPages: number
  retainedWrapperNodes: number
  retainedA100Nodes: number
  admittedPages: number
  submitPermits: number
  desiredWrapperNodes: number
  desiredA100Nodes: number
  permitFillRatio: number
  targetActivePages: number
  submitterPageGap: number
  completedOcrPagesPerSecond: number
  requiredSubmitPagesPerSecond: number
  observedSubmitPagesPerSecond: number
  observedSubmitPagesPerSecondPerContainer: number
  effectiveSubmitPagesPerSecondPerContainer: number
  desiredSubmitterConcurrencyPerContainer: number
  desiredSubmitterContainers: number
}

const positive = (value: number, fallback: number) =>
  Number.isFinite(value) && value > 0 ? value : fallback

const nonNegative = (value: number, fallback: number) =>
  Number.isFinite(value) && value >= 0 ? value : fallback

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

const ceilDiv = (numerator: number, denominator: number) =>
  denominator <= 0 ? 0 : Math.ceil(numerator / denominator)

const clampRatio = (value: number, fallback: number) =>
  Number.isFinite(value) ? clamp(value, 0, 1) : fallback

export const computeOcrAutoscalerDecision = (
  input: OcrAutoscalerInput,
): OcrAutoscalerDecision => {
  const wrapperPagesPerNode = positive(input.wrapperPagesPerNode, 4000)
  const a100PagesPerNode = positive(input.a100PagesPerNode, 125)
  const submitPermitsPerWrapper = positive(input.submitPermitsPerWrapper, 440)
  const pendingOcrPages = nonNegative(input.pendingOcrPages, 0)
  const activeOcrPages = nonNegative(input.activeOcrPages, 0)
  const healthyWrapperNodes = nonNegative(input.healthyWrapperNodes, 0)
  const currentA100Nodes = nonNegative(input.currentA100Nodes, 0)
  const healthyA100Nodes = nonNegative(input.healthyA100Nodes, 0)

  const wrapperMinNodes = nonNegative(input.wrapperMinNodes, 0)
  const wrapperMaxNodes = Math.max(
    wrapperMinNodes,
    nonNegative(input.wrapperMaxNodes, wrapperMinNodes),
  )
  const a100MinNodes = nonNegative(input.a100MinNodes, 0)
  const a100MaxNodes = Math.max(
    a100MinNodes,
    nonNegative(input.a100MaxNodes, a100MinNodes),
  )

  const demandPages = pendingOcrPages + activeOcrPages
  const desiredWrapperNodes = clamp(
    ceilDiv(demandPages, wrapperPagesPerNode),
    wrapperMinNodes,
    wrapperMaxNodes,
  )
  let desiredA100Nodes = clamp(
    ceilDiv(demandPages, a100PagesPerNode),
    a100MinNodes,
    a100MaxNodes,
  )
  const usefulA100NodesFromWrappers = ceilDiv(
    desiredWrapperNodes * wrapperPagesPerNode,
    a100PagesPerNode,
  )
  desiredA100Nodes = Math.min(desiredA100Nodes, usefulA100NodesFromWrappers)
  if (input.a100CapacityWaitingSustained) {
    desiredA100Nodes = Math.max(
      desiredA100Nodes,
      Math.min(
        clamp(currentA100Nodes + 1, a100MinNodes, a100MaxNodes),
        usefulA100NodesFromWrappers,
      ),
    )
  }

  const retainedWrapperNodes = Math.min(
    healthyWrapperNodes,
    desiredWrapperNodes,
  )
  const retainedA100Nodes = Math.min(healthyA100Nodes, desiredA100Nodes)
  const rawWrapperBudgetPages = healthyWrapperNodes * wrapperPagesPerNode
  const rawGpuBudgetPages = healthyA100Nodes * a100PagesPerNode
  const wrapperBudgetPages = retainedWrapperNodes * wrapperPagesPerNode
  const gpuBudgetPages = retainedA100Nodes * a100PagesPerNode
  const admittedPages = Math.min(wrapperBudgetPages, gpuBudgetPages)
  const submitPermitRequestCap = retainedWrapperNodes * submitPermitsPerWrapper
  const submitPermits = Math.floor(
    Math.min(admittedPages, submitPermitRequestCap),
  )

  const permitFillRatio =
    admittedPages > 0 ? Math.min(activeOcrPages / admittedPages, 1) : 0

  const submitterFixedConcurrencyPerContainer = Math.max(
    1,
    input.submitterFixedConcurrencyPerContainer,
  )
  const submitterContainerMin = Math.max(0, input.submitterContainerMin)
  const submitterContainerMax = Math.max(
    submitterContainerMin,
    input.submitterContainerMax,
  )
  const submitterPagesPerSecondPerContainer = positive(
    input.submitterPagesPerSecondPerContainer,
    120,
  )
  const submitterTargetFillSeconds = positive(
    input.submitterTargetFillSeconds,
    60,
  )
  const permitFillTarget = clampRatio(input.permitFillTarget, 0.85)
  const completedOcrPagesPerSecond = nonNegative(
    input.completedOcrPagesPerSecond,
    0,
  )
  const observedSubmitPagesPerSecond =
    input.observedSubmitPagesPerSecond === null
      ? null
      : nonNegative(input.observedSubmitPagesPerSecond, 0)
  const currentSubmitterContainers = clamp(
    input.currentSubmitterContainers,
    submitterContainerMin,
    submitterContainerMax,
  )
  const submitterScaleUpAllowed =
    input.wrapperHealthStable && !input.a100CapacityWaitingSustained

  const targetActivePages = admittedPages * permitFillTarget
  const submitterPageGap = Math.max(
    0,
    Math.min(pendingOcrPages, targetActivePages - activeOcrPages),
  )
  const requiredSubmitPagesPerSecond =
    completedOcrPagesPerSecond +
    submitterPageGap / submitterTargetFillSeconds
  const observedSubmitPagesPerSecondPerContainer =
    observedSubmitPagesPerSecond !== null && currentSubmitterContainers > 0
      ? observedSubmitPagesPerSecond / currentSubmitterContainers
      : 0
  const effectiveSubmitPagesPerSecondPerContainer =
    observedSubmitPagesPerSecond !== null && currentSubmitterContainers > 0
      ? observedSubmitPagesPerSecondPerContainer
      : submitterPagesPerSecondPerContainer
  const calculatedSubmitterContainers = clamp(
    effectiveSubmitPagesPerSecondPerContainer <= 0 &&
      requiredSubmitPagesPerSecond > 0
      ? submitterContainerMax
      : ceilDiv(
          requiredSubmitPagesPerSecond,
          effectiveSubmitPagesPerSecondPerContainer,
        ),
    submitterContainerMin,
    submitterContainerMax,
  )
  const desiredSubmitterConcurrencyPerContainer =
    submitterFixedConcurrencyPerContainer
  let desiredSubmitterContainers = currentSubmitterContainers
  const hasOcrWork = pendingOcrPages > 0 || activeOcrPages > 0

  if (!hasOcrWork || (admittedPages === 0 && activeOcrPages === 0)) {
    desiredSubmitterContainers = submitterContainerMin
  } else if (permitFillRatio < permitFillTarget && submitterScaleUpAllowed) {
    desiredSubmitterContainers = Math.max(
      currentSubmitterContainers,
      calculatedSubmitterContainers,
    )
  }

  return {
    demandPages,
    wrapperBudgetPages,
    gpuBudgetPages,
    rawWrapperBudgetPages,
    rawGpuBudgetPages,
    retainedWrapperNodes,
    retainedA100Nodes,
    admittedPages,
    submitPermits,
    desiredWrapperNodes,
    desiredA100Nodes,
    permitFillRatio,
    targetActivePages,
    submitterPageGap,
    completedOcrPagesPerSecond,
    requiredSubmitPagesPerSecond,
    observedSubmitPagesPerSecond: observedSubmitPagesPerSecond ?? 0,
    observedSubmitPagesPerSecondPerContainer,
    effectiveSubmitPagesPerSecondPerContainer,
    desiredSubmitterConcurrencyPerContainer,
    desiredSubmitterContainers,
  }
}
