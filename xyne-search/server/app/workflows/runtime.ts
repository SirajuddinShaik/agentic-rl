import {
  ExecutionEventBus,
  ServiceRegistry,
  StepRegistry,
  TriggerRegistry,
  WorkflowExecutor,
  WorkflowRuntime,
} from "@xyne/workflow-sdk"
import {
  AgentStep,
  AgentToolRegistry,
  PiMonoRuntime,
  runCodeTool,
} from "@xyne/workflow-sdk/agents"
import type { ExecutorLogger } from "@xyne/workflow-sdk"
import type PgBoss from "pg-boss"
import { getLogger } from "@/platform/logger"
import { Subsystem } from "@/types"
import { OcrDocumentStep } from "./steps/ocr-document.step"
import { SendEmailStep } from "./steps/send-email.step"
import { createGmailService } from "./services/gmail.service"
import { DeepResearchStep } from "./steps/deep-research.step"
import { LoadLastResultStep } from "./steps/load-last-result.step"
import { makeWebSearchTool } from "./tools/web-search.tool"
import { isWebSearchConfigured } from "@/app/services/research"
import { boss } from "@/platform/queue/boss"
import { DrizzlePersistenceAdapter } from "./adapters/persistence"
import { XyneWorkflowAuthorizer } from "./authorizer"
import type { XyneCtx, XyneFilter } from "./acl"
import { PgBossQueueAdapter, WORKFLOW_EXECUTION_QUEUE } from "./adapters/queue"
import { PgBossSchedulerAdapter } from "./adapters/scheduler"
import { DiskStorageAdapter } from "./adapters/storage"
import { createWorkflowSandboxAdapter } from "./adapters/sandbox"

const Logger = getLogger(Subsystem.Api).child({ module: "workflow-sdk" })

const sdkLogger: ExecutorLogger = {
  info: (msg) => Logger.info(msg),
  warn: (msg) => Logger.warn(msg),
  error: (msg) => Logger.error(msg),
}

const BASE_URL = process.env["BACKENDV2_BASE_URL"] ?? "http://localhost:3000"

// ── Assemble singleton ────────────────────────────────────────────────────────

export const persistence = new DrizzlePersistenceAdapter()

const queue = new PgBossQueueAdapter()
const eventBus = new ExecutionEventBus()
const storage = new DiskStorageAdapter()
// Code-execution sandbox (E2B / Docker). undefined when no backend configured.
const sandbox = createWorkflowSandboxAdapter()

const steps = new StepRegistry()
steps.register(new OcrDocumentStep())
steps.register(new DeepResearchStep())
steps.register(new LoadLastResultStep(persistence))
const triggers = new TriggerRegistry()
const services = new ServiceRegistry()

// Register the deployment Gmail sender (Gmail SMTP via an App Password). When
// env is missing, the SEND_EMAIL step is left unregistered so workflows can't
// reference an unconfigured transport. GMAIL_USER is the mailbox/From: address;
// GMAIL_APP_PASSWORD is a Google App Password for that mailbox (needs 2-Step
// Verification enabled on the account).
const gmailUser = process.env["GMAIL_USER"] ?? ""
const gmailAppPassword = process.env["GMAIL_APP_PASSWORD"] ?? ""
if (gmailUser && gmailAppPassword) {
  services.register(
    "gmail",
    createGmailService({ user: gmailUser, appPassword: gmailAppPassword }),
  )
  steps.register(new SendEmailStep())
  Logger.info(`Workflow: SEND_EMAIL step registered (Gmail sender: ${gmailUser})`)
} else {
  Logger.warn("Gmail not configured — SEND_EMAIL step will not be available in workflows")
}

const workflowLlmBaseUrl = (process.env["WORKFLOW_LLM_BASE_URL"] ?? process.env["LITELLM_BASE_URL"] ?? "").replace(/\/$/, "")
const workflowLlmApiKey = process.env["WORKFLOW_LLM_API_KEY"] ?? process.env["LITELLM_API_KEY"] ?? ""
// Must be a model the LiteLLM team can access (e.g. claude-sonnet-4-6).
const workflowLlmModel = process.env["WORKFLOW_LLM_MODEL"] ?? "open-large-sa"

// Register AgentStep backed by LiteLLM (same endpoint backendv2 already uses).
if (workflowLlmBaseUrl && workflowLlmApiKey) {
  const piMono = new PiMonoRuntime({
    baseUrl: workflowLlmBaseUrl,
    apiKey: workflowLlmApiKey,
    model: workflowLlmModel,
    api: 'openai-completions',
  })
  const toolRegistry = new AgentToolRegistry()
  // Give the agent code execution when a sandbox backend is configured.
  if (sandbox) {
    toolRegistry.register(runCodeTool)
    Logger.info("Workflow agent: run_code tool registered (sandbox available)")
  }
  // Web search when a Brave API key is configured.
  if (isWebSearchConfigured()) {
    toolRegistry.register(makeWebSearchTool())
    Logger.info("Workflow agent: web_search tool registered")
  }
  steps.register(new AgentStep(piMono, toolRegistry))
} else {
  Logger.warn("Workflow LLM not configured — AgentStep will not be available in workflows")
}

const executor = new WorkflowExecutor(persistence, steps, triggers, services, {
  eventBus,
  baseUrl: BASE_URL,
  logger: sdkLogger,
  storage,
  ...(sandbox ? { sandbox } : {}),
})

const scheduler = new PgBossSchedulerAdapter(
  async (workflowId) => { await workflowRuntime.processCronTick(workflowId) },
)

const workflowRuntime = new WorkflowRuntime<
  Record<string, unknown>,
  XyneCtx,
  XyneFilter
>({
  persistence,
  queue,
  scheduler,
  services,
  steps,
  triggers,
  executor,
  authorizer: new XyneWorkflowAuthorizer(),
  eventBus,
  storage,
  ...(sandbox ? { sandbox } : {}),
  logger: sdkLogger,
  config: {
    baseUrl: BASE_URL,
    defaultCronTimezone: "Asia/Kolkata",
    ...(workflowLlmBaseUrl && workflowLlmApiKey
      ? {
          aiBuilder: {
            baseUrl: workflowLlmBaseUrl,
            apiKey: workflowLlmApiKey,
            model: workflowLlmModel,
          },
        }
      : {}),
  },
})

export { workflowRuntime }

// ── Boot worker registration ──────────────────────────────────────────────────

export const initWorkflowWorkers = async (): Promise<void> => {
  await boss.createQueue(WORKFLOW_EXECUTION_QUEUE)
  const parsedConcurrency = Number(process.env["WORKFLOW_WORKER_CONCURRENCY"])
  const concurrency =
    Number.isFinite(parsedConcurrency) && parsedConcurrency >= 1
      ? Math.floor(parsedConcurrency)
      : 3
  for (let i = 0; i < concurrency; i++) {
    await boss.work(
      WORKFLOW_EXECUTION_QUEUE,
      { batchSize: 1 },
      async (jobs: PgBoss.Job<{ executionId: string }>[]) => {
        for (const job of jobs) {
          try {
            await workflowRuntime.processJob(job.data.executionId)
          } catch (err) {
            Logger.error({ err }, `Workflow job ${job.data.executionId} failed`)
          }
        }
      },
    )
  }
  Logger.info(
    `Workflow execution workers registered (queue: ${WORKFLOW_EXECUTION_QUEUE}, concurrency: ${concurrency})`,
  )

  // Cold-start cron recovery: re-register workers for all active CRON workflows
  // so existing schedules resume after a restart.
  try {
    const activeWorkflows = await persistence.listAllActiveWorkflows()
    let cronCount = 0
    for (const wf of activeWorkflows) {
      if (!wf.config) continue
      const cfg = JSON.parse(wf.config) as { trigger?: { type?: string; config?: { expression?: string } } }
      if (cfg.trigger?.type !== "CRON" || !cfg.trigger.config?.expression) continue
      await scheduler.schedule(
        wf.id,
        cfg.trigger.config.expression,
        "Asia/Kolkata",
      )
      cronCount++
    }
    if (cronCount > 0) {
      Logger.info(`Cold-start: re-registered ${cronCount} cron workflow(s)`)
    }
  } catch (err) {
    Logger.error({ err }, "Cold-start cron recovery failed — cron workflows may not fire until next restart")
  }
}
