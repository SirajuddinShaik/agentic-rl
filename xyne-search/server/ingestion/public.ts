// Stable integration surface for backendv2.
//
// Keep this file intentionally small. backendv2 may import ingestion behavior
// from here, but must not reach into ingestion services, repositories, storage,
// processors, workers, Docling internals, or indexing modules directly.

export { IngestionUploadError } from "@/ingestion/domain/errors"
export type {
  IngestionUploadActor,
  IngestionUploadCollection,
  UploadBatchInput,
  UploadBatchResult,
  UploadResult,
} from "@/ingestion/domain/types"
export {
  enqueueKbMetadataSync,
  type KbMetadataSyncTarget,
} from "@/ingestion/services/metadataSyncService"
export { uploadKbFiles } from "@/ingestion/services/uploadService"
