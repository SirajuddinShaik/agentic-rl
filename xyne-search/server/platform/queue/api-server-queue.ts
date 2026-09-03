import { getLogger } from "@/platform/logger"
import { Subsystem } from "@/types"
import { boss as sharedBoss } from "./boss"

const Logger = getLogger(Subsystem.Queue)

export const boss = sharedBoss
export const FileProcessingQueue = `file-processing`
export const WorkflowExecutionQueue = "wf-sdk-execution"

/**
 * Initialize pg-boss for API server usage only
 * - Starts the shared pg-boss connection
 * - Creates queues that the API server sends jobs to
 * - Does NOT start any workers (workers run in sync-server.ts)
 */
export const initApiServerQueue = async () => {
  Logger.info("API Server Queue init - starting pg-boss")
  await sharedBoss.start()

  await sharedBoss.createQueue(FileProcessingQueue)
  await sharedBoss.createQueue(WorkflowExecutionQueue)

  Logger.info("API Server Queue initialization complete - ready for boss.send()")
}

// Error handling
sharedBoss.on("error", (error) => {
  Logger.error(error, `API Server Queue error: ${error.message}`)
})
