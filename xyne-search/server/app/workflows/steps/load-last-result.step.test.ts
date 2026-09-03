// Unit tests for the LOAD_LAST_RESULT host step. Pure — the persistence adapter
// is mocked (the step only type-imports it, so no DB is touched). Run:
//   bun test app/workflows/steps/load-last-result.step.test.ts
import { test, expect } from "bun:test"
import { LoadLastResultStep } from "./load-last-result.step"

// Minimal StepExecutionContext stub — only the fields the step reads.
function mockCtx(executionId = "exec_current", workflowId = "wf_1") {
  return {
    workflow: { workflow: { id: workflowId, metadata: {} } },
    runtime: { executionId },
    log: { info() {}, warn() {}, error() {} },
  } as never
}

test("no previous run → hasPrevious=false, no context", async () => {
  const persistence = { getPreviousExecution: async () => null } as never
  const step = new LoadLastResultStep(persistence)

  const out = await step.execute({ status: "COMPLETED" } as never, mockCtx())

  expect(out.hasPrevious).toBe(false)
  expect(out.context).toBeUndefined()
  expect(out.previousExecutionId).toBeUndefined()
})

test("previous run → returns full context, scoped + excluding self", async () => {
  const prevContext = {
    workflow: { id: "wf_1" },
    steps: { matrix: { output: { response: { rows: [{ feature: "Routing" }] } } } },
  }
  let calledWith: { wfId: string; opts: { status?: string; excludeExecutionId?: string } } | undefined
  const persistence = {
    getPreviousExecution: async (
      wfId: string,
      opts: { status?: string; excludeExecutionId?: string },
    ) => {
      calledWith = { wfId, opts }
      return {
        executionId: "exec_prev",
        runAt: "2026-06-28T00:00:00.000Z",
        context: prevContext,
      }
    },
  } as never
  const step = new LoadLastResultStep(persistence)

  const out = await step.execute(
    { status: "COMPLETED" } as never,
    mockCtx("exec_current", "wf_1"),
  )

  expect(out.hasPrevious).toBe(true)
  expect(out.previousExecutionId).toBe("exec_prev")
  expect(out.previousRunAt).toBe("2026-06-28T00:00:00.000Z")
  expect(out.context).toEqual(prevContext)
  // queried for THIS workflow, excluding the current execution, with the status.
  expect(calledWith?.wfId).toBe("wf_1")
  expect(calledWith?.opts.excludeExecutionId).toBe("exec_current")
  expect(calledWith?.opts.status).toBe("COMPLETED")
})

test("step metadata: type + schemas wired", () => {
  const step = new LoadLastResultStep({} as never)
  expect(step.type).toBe("LOAD_LAST_RESULT")
  // output schema declares the cross-run shape
  const keys = Object.keys((step.outputSchema as { shape: Record<string, unknown> }).shape)
  expect(keys).toContain("hasPrevious")
  expect(keys).toContain("context")
})
