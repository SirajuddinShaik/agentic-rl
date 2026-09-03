import { InitialisationError } from "@/platform/errors"
import {
  startDoclingRuntimeConfigPolling,
  stopDoclingRuntimeConfigPolling,
} from "@/platform/lib/doclingRuntimeConfig"
import { closeRedisClient } from "@/platform/lib/redisClient"
import { getLogger } from "@/platform/logger"
import { startDoclingSchedulerRole } from "@/ingestion/docling/workers/scheduler"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Queue).child({
  module: "doclingSchedulerWorkerMain",
})

const shutdown = async (signal: string) => {
  Logger.info({ signal }, "Shutting down Docling scheduler worker")
  stopDoclingRuntimeConfigPolling()
  await closeRedisClient()
  process.exit(0)
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM")
})
process.on("SIGINT", () => {
  void shutdown("SIGINT")
})

const role = process.env.DOCLING_SCHEDULER_ROLE || process.env.ROLE || "reaper"

startDoclingRuntimeConfigPolling()

startDoclingSchedulerRole(role).catch((error) => {
  throw new InitialisationError({ cause: error })
})
