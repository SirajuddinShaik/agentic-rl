import { parentPort } from "worker_threads"
import { getLogger } from "@/platform/logger"
import { Subsystem } from "@/types"
import { initFileProcessingWorker } from "@/ingestion/entrypoints/standardFileWorker"

const Logger = getLogger(Subsystem.Queue)

async function startFileProcessingWorker() {
  try {
    Logger.info("Starting file processing worker thread...")
    
    // Import FileProcessingQueue from shared location
    const { FileProcessingQueue } = await import("@/platform/queue/api-server-queue")
    
    // Initialize boss and create FileProcessingQueue in this worker thread
    const { boss } = await import("@/platform/queue")
    await boss.start()
    await boss.createQueue(FileProcessingQueue)
    
    // Now initialize the file processing worker
    await initFileProcessingWorker()
    Logger.info("File processing worker thread initialized successfully")
    
    // Send success message to parent
    parentPort?.postMessage({ status: "initialized" })
  } catch (error) {
    Logger.error(error, "Failed to initialize file processing worker thread")
    
    // Send error message to parent
    parentPort?.postMessage({ 
      status: "error", 
      error: error instanceof Error ? error.message : String(error) 
    })
  }
}

// Start the worker when this script is loaded
await startFileProcessingWorker()

// Handle messages from parent thread if needed
parentPort?.on("message", (message) => {
  Logger.info("Received message from parent:", message)
})
