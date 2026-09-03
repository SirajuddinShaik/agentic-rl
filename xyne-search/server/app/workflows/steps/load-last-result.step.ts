// LOAD_LAST_RESULT step — load the FULL context of this workflow's previous
// completed run, for cross-run comparison ("what changed since last run").
//
// External host step (not a SDK built-in): it needs the persistence adapter to
// read prior executions, so it's constructed with it — the same pattern as the
// other host steps. The data op lives on the adapter (getPreviousExecution).
//
// Use the SDK's bundled zod (3.25) via the "zodsdk" alias — the root zod has a
// type-identity mismatch that blows up tsc (see send-email.step.ts).

import { z } from "zodsdk"
import { BaseActionStep, StepKind } from "@xyne/workflow-sdk"
import type { StepExecutionContext } from "@xyne/workflow-sdk"
import type { DrizzlePersistenceAdapter } from "../adapters/persistence"

// ── Config / output schemas ──────────────────────────────────────────────────

const LoadLastResultStepConfigSchema = z.object({
  status: z
    .string()
    .default("COMPLETED")
    .describe(
      "Status of the prior run to load (default COMPLETED — the last successful run).",
    ),
})

type LoadLastResultStepConfig = z.infer<typeof LoadLastResultStepConfigSchema>

// `context` carries the ENTIRE previous WorkflowContext (trigger + every step's
// output). Permissive object — downstream steps reference the whole blob.
const LoadLastResultStepOutputSchema = z.object({
  hasPrevious: z.boolean(),
  previousExecutionId: z.string().optional(),
  previousRunAt: z.string().optional(),
  context: z.record(z.unknown()).optional(),
})

export interface LoadLastResultStepOutput extends Record<string, unknown> {
  hasPrevious: boolean
  previousExecutionId?: string
  previousRunAt?: string
  context?: Record<string, unknown>
}

// ── Step ─────────────────────────────────────────────────────────────────────

export class LoadLastResultStep extends BaseActionStep<
  typeof LoadLastResultStepConfigSchema,
  LoadLastResultStepOutput
> {
  override readonly kind = StepKind.ACTION
  override readonly type = "LOAD_LAST_RESULT"
  override readonly name = "Load Last Result"
  override readonly description =
    "Load the full context (every step's output) of this workflow's previous completed run, " +
    "for cross-run comparison. Returns hasPrevious=false on the first run."
  override readonly category = "data" as const
  override readonly icon = "history"
  override readonly configSchema = LoadLastResultStepConfigSchema
  override readonly outputSchema = LoadLastResultStepOutputSchema

  private readonly persistence: DrizzlePersistenceAdapter

  constructor(persistence: DrizzlePersistenceAdapter) {
    super()
    this.persistence = persistence
  }

  override async execute(
    config: LoadLastResultStepConfig,
    ctx: StepExecutionContext,
  ): Promise<LoadLastResultStepOutput> {
    const workflowId = ctx.workflow.workflow.id
    const prev = await this.persistence.getPreviousExecution(workflowId, {
      status: config.status,
      excludeExecutionId: ctx.runtime.executionId,
    })

    if (!prev) {
      ctx.log.info(
        `LOAD_LAST_RESULT: no previous ${config.status} run for workflow ${workflowId} — baseline`,
      )
      return { hasPrevious: false }
    }

    ctx.log.info(
      `LOAD_LAST_RESULT: previous run ${prev.executionId} (${prev.runAt})`,
    )
    return {
      hasPrevious: true,
      previousExecutionId: prev.executionId,
      previousRunAt: prev.runAt,
      context: prev.context,
    }
  }
}
