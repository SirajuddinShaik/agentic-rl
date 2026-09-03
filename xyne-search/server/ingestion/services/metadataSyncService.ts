import { kickoffKbMetadataSync } from "@/ingestion/indexing/kbMetadataSync"

export type KbMetadataSyncTarget = Parameters<typeof kickoffKbMetadataSync>[0]

export const enqueueKbMetadataSync = (
  target: KbMetadataSyncTarget,
): void => {
  kickoffKbMetadataSync(target)
}
