// Use the SDK's bundled zod (3.25) via the "zodsdk" alias so `z.infer` / step
// config types resolve — the root zod version otherwise breaks the schema types.
import { z } from "zodsdk"
import { BaseActionStep, StepKind, variableRef } from "@xyne/workflow-sdk"
import type { StepExecutionContext } from "@xyne/workflow-sdk"
import { deepResearch } from "@/app/services/research/deep-research"

// Config — what the workflow editor sets. `query` is bindable to a ref.
const DeepResearchStepConfigSchema = z.object({
  query: variableRef(
    z.string().min(1).describe(
      "Research question. Bind to a ref (e.g. {{trigger.topic}}) or type a literal.",
    ),
  ),
  maxIterations: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional: override the research-round budget (default set by the service)."),
})
type DeepResearchStepConfig = z.infer<typeof DeepResearchStepConfigSchema>

// Output — referenced downstream as steps.<id>.output.report
const DeepResearchStepOutputSchema = z.object({
  report: z.string(),
  threadId: z.string(),
})

export interface DeepResearchStepOutput extends Record<string, unknown> {
  report: string
  threadId: string
}

export class DeepResearchStep extends BaseActionStep<
  typeof DeepResearchStepConfigSchema,
  DeepResearchStepOutput
> {
  override readonly kind = StepKind.ACTION
  override readonly type = "DEEP_RESEARCH"
  override readonly name = "Deep Research"
  override readonly description =
    "Run an in-depth, multi-source research investigation (LangGraph) and return a comprehensive " +
    "markdown report. Blocks until the report is ready — use for a deterministic research stage."
  override readonly category = "action" as const
  override readonly configSchema = DeepResearchStepConfigSchema
  override readonly outputSchema = DeepResearchStepOutputSchema

  override async execute(
    config: DeepResearchStepConfig,
    ctx: StepExecutionContext,
  ): Promise<DeepResearchStepOutput> {
    const query = String(config.query ?? "").trim()
    if (!query) {
      throw new Error(
        "DEEP_RESEARCH: 'query' is empty — bind it to a ref like {{trigger.topic}} or set a literal.",
      )
    }

    ctx.log.info(`DEEP_RESEARCH: starting research for "${query.slice(0, 80)}"`)
    const signal = ctx.runtime.metadata["signal"] as AbortSignal | undefined
    const { report, threadId } = await deepResearch(query, {
      ...(signal ? { signal } : {}),
      ...(config.maxIterations !== undefined ? { maxIterations: config.maxIterations } : {}),
    })
    ctx.log.info(`DEEP_RESEARCH: report ready (${String(report.length)} chars, thread ${threadId})`)

    return { report, threadId }
  }
}
