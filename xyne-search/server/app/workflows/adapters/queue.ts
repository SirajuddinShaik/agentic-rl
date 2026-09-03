import type { QueueAdapter } from "@xyne/workflow-sdk"
import { boss } from "@/platform/queue/boss"
import { WorkflowExecutionQueue } from "@/platform/queue/api-server-queue"

export const WORKFLOW_EXECUTION_QUEUE = WorkflowExecutionQueue

export class PgBossQueueAdapter implements QueueAdapter {
  async enqueue(data: { executionId: string; delay?: number }): Promise<void> {
    // Long-running workflows (e.g. DEEP_RESEARCH can take 20+ min) must not hit
    // pg-boss's default 15-min job expiry. Override per-job; tune via env.
    const expireInSeconds = Number(
      process.env["WORKFLOW_JOB_EXPIRE_SECONDS"] ?? 3900,
    )
    const opts: { expireInSeconds: number; startAfter?: number } = {
      expireInSeconds,
    }
    if (data.delay && data.delay > 0) {
      opts.startAfter = Math.ceil(data.delay / 1000)
    }
    await boss.send(WORKFLOW_EXECUTION_QUEUE, { executionId: data.executionId }, opts)
  }
}
