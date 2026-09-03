import { Hono } from "hono"
import config from "@/config"
import { InitialisationError } from "@/platform/errors"
import { getLogger, LogMiddleware } from "@/platform/logger"
import metricRegister from "@/platform/metrics/sharedRegistry"
import { Subsystem } from "@/types"
import { Worker } from "worker_threads"
import path from "path"
import {
  recordAppSyncDiagnosticEvent,
  startAppSyncResourceSampler,
} from "@/platform/lib/appSyncDiagnostics"

const Logger = getLogger(Subsystem.SyncServer)

const app = new Hono()
const honoMiddlewareLogger = LogMiddleware(Subsystem.SyncServer)

app.use("*", async (c, next) => {
  if (c.req.path === "/health") {
    await next()
    return
  }

  return honoMiddlewareLogger(c, next)
})

app.get("/health", (c) => {
  return c.json({ status: "ok", service: "sync-server" })
})

app.get("/metrics", async (c) => {
  try {
    const metrics = await metricRegister.metrics()
    return c.text(metrics, 200, {
      "Content-Type": metricRegister.contentType,
    })
  } catch (err) {
    Logger.error(err, "Error generating metrics")
    return c.text("Error generating metrics", 500)
  }
})

app.get("/status", (c) => {
  return c.json({
    service: "sync-server",
    status: "running",
    timestamp: new Date().toISOString(),
  })
})

type WorkerContext = {
  workerScript: string
  workerType: string
  workerIndex: number
  workerArrayIndex: number
  workerThreads: Worker[]
}

const attachWorkerEventHandlers = (
  worker: Worker,
  context: WorkerContext,
) => {
  const workerThreadId = worker.threadId

  worker.on("message", (message) => {
    if (message.status === "initialized") {
      recordAppSyncDiagnosticEvent("worker_initialized", {
        workerType: context.workerType,
        workerIndex: context.workerIndex,
        workerScript: context.workerScript,
        threadId: workerThreadId,
      })
      Logger.info(
        `${context.workerType} processing worker thread ${context.workerIndex} initialized successfully`,
      )
    } else if (message.status === "error") {
      recordAppSyncDiagnosticEvent("worker_init_error", {
        workerType: context.workerType,
        workerIndex: context.workerIndex,
        workerScript: context.workerScript,
        threadId: workerThreadId,
        error: message.error,
      })
      Logger.error(
        `${context.workerType} processing worker thread ${context.workerIndex} failed: ${message.error}`,
      )
    }
  })

  worker.on("error", (error) => {
    recordAppSyncDiagnosticEvent("worker_error", {
      workerType: context.workerType,
      workerIndex: context.workerIndex,
      workerScript: context.workerScript,
      threadId: workerThreadId,
      error,
    })
    Logger.error(
      error,
      `${context.workerType} processing worker thread ${context.workerIndex} error`,
    )
  })

  worker.on("exit", (code) => {
    recordAppSyncDiagnosticEvent("worker_exit", {
      workerType: context.workerType,
      workerIndex: context.workerIndex,
      workerScript: context.workerScript,
      threadId: workerThreadId,
      code,
    })
    if (code !== 0) {
      Logger.error(
        `${context.workerType} processing worker thread ${context.workerIndex} exited with code ${code}`,
      )

      Logger.info(
        `Restarting ${context.workerType} processing worker thread ${context.workerIndex}...`,
      )
      const newWorker = new Worker(path.join(__dirname, context.workerScript), {
        workerData: {
          workerType: context.workerType,
          workerIndex: context.workerIndex,
          workerScript: context.workerScript,
        },
      })
      context.workerThreads[context.workerArrayIndex] = newWorker
      recordAppSyncDiagnosticEvent("worker_respawned", {
        workerType: context.workerType,
        workerIndex: context.workerIndex,
        workerScript: context.workerScript,
        threadId: newWorker.threadId,
        previousCode: code,
      })
      attachWorkerEventHandlers(newWorker, context)
    }
  })
}

const startAndMonitorWorkers = (
  workerScript: string,
  workerType: string,
  count: number,
  workerThreads: Worker[],
  arrayIndexOffset: number,
) => {
  Logger.info(`Starting ${count} ${workerType} processing worker threads...`)

  for (let i = 0; i < count; i++) {
    const workerIndex = i + 1
    const workerArrayIndex = arrayIndexOffset + i
    const worker = new Worker(path.join(__dirname, workerScript), {
      workerData: {
        workerType,
        workerIndex,
        workerScript,
      },
    })
    workerThreads.push(worker)
    recordAppSyncDiagnosticEvent("worker_spawned", {
      workerType,
      workerIndex,
      workerScript,
      threadId: worker.threadId,
    })
    attachWorkerEventHandlers(worker, {
      workerScript,
      workerType,
      workerIndex,
      workerArrayIndex,
      workerThreads,
    })
  }
}

export const initSyncServer = async () => {
  Logger.info("Initializing Sync Server")
  startAppSyncResourceSampler()
  recordAppSyncDiagnosticEvent("sync_server_initializing", {
    fileWorkerCount: config.fileProcessingWorkerThreads,
    fileProcessingTeamSize: config.fileProcessingTeamSize,
    appSyncProcessingWorkersDisabled: config.disableAppSyncProcessingWorkers,
    pid: process.pid,
  })

  if (config.disableAppSyncProcessingWorkers) {
    Logger.info(
      "App-sync file processing workers disabled via DISABLE_APP_SYNC_PROCESSING_WORKERS=true",
    )
  } else {
    const workerThreads: Worker[] = []
    startAndMonitorWorkers(
      "fileProcessingWorker.ts",
      "File",
      config.fileProcessingWorkerThreads,
      workerThreads,
      0,
    )

  }

  Logger.info("Sync Server initialization completed")
}

const errorHandler = (error: Error) => {
  Logger.error(error, "Sync Server error")
  return new Response(`<pre>${error}\n${error.stack}</pre>`, {
    headers: {
      "Content-Type": "text/html",
    },
  })
}

const syncServerPort = config.syncServerPort || 3010
Bun.serve({
  fetch: app.fetch,
  port: syncServerPort,
  idleTimeout: 180,
  development: process.env.NODE_ENV != "production",
  error: errorHandler,
})

Logger.info(`Sync Server listening on port: ${syncServerPort}`)

const errorEvents: string[] = [
  `uncaughtException`,
  `unhandledRejection`,
  `rejectionHandled`,
]
errorEvents.forEach((eventType: string) =>
  process.on(eventType, (error: Error) => {
    Logger.error(error, `Sync Server caught via event: ${eventType}`)
    if (
      eventType === "uncaughtException" ||
      eventType === "unhandledRejection"
    ) {
      process.exit(1)
    }
  }),
)

initSyncServer().catch((error) => {
  throw new InitialisationError({ cause: error })
})
