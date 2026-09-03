import { InitialisationError } from "@/platform/errors"
import { startDoclingRedisResultWorker } from "@/ingestion/docling/workers/result"
import { closeRedisClient } from "@/platform/lib/redisClient"
import { getLogger } from "@/platform/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Queue).child({
  module: "doclingResultWorkerMain",
})

const shutdown = async (signal: string) => {
  Logger.info({ signal }, "Shutting down Docling result worker")
  await closeRedisClient()
  process.exit(0)
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM")
})
process.on("SIGINT", () => {
  void shutdown("SIGINT")
})

startDoclingRedisResultWorker().catch((error) => {
  throw new InitialisationError({ cause: error })
})
