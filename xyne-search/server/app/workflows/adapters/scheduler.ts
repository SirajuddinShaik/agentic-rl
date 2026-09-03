import type { SchedulerAdapter } from "@xyne/workflow-sdk"
import type PgBoss from "pg-boss"
import { boss } from "@/platform/queue/boss"

export class PgBossSchedulerAdapter implements SchedulerAdapter {
  private readonly registeredQueues = new Set<string>()
  private readonly cronHandler: (workflowId: string) => Promise<void>

  constructor(cronHandler: (workflowId: string) => Promise<void>) {
    this.cronHandler = cronHandler
  }

  async schedule(
    workflowId: string,
    cronExpression: string,
    timezone?: string,
  ): Promise<void> {
    const queueName = `wf-cron-${workflowId}`
    await boss.schedule(
      queueName,
      cronExpression,
      { workflowId },
      timezone ? { tz: timezone } : {},
    )
    if (!this.registeredQueues.has(queueName)) {
      await boss.work(queueName, async (jobs: PgBoss.Job<{ workflowId: string }>[]) => {
        for (const job of jobs) {
          await this.cronHandler(job.data.workflowId)
        }
      })
      this.registeredQueues.add(queueName)
    }
  }

  async unschedule(workflowId: string): Promise<void> {
    const queueName = `wf-cron-${workflowId}`
    await boss.unschedule(queueName)
    if (this.registeredQueues.has(queueName)) {
      await boss.offWork(queueName)
      this.registeredQueues.delete(queueName)
    }
  }
}
