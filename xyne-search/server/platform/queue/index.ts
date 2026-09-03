import { Apps, AuthType, ConnectorType } from "@/platform/shared/types"
import { boss } from "./boss"

export { boss }

export const SaaSQueue = `ingestion-${ConnectorType.SaaS}`
export const SyncOAuthSaaSQueue = `sync-${ConnectorType.SaaS}-${AuthType.OAuth}`
export const SyncServiceAccountSaaSQueue = `sync-${ConnectorType.SaaS}-${AuthType.ServiceAccount}`
export const SyncServiceAccountPerUserQueue = `sync-${ConnectorType.SaaS}-${AuthType.ServiceAccount}-per-user`
export const SyncServiceAccountSchedulerQueue = `sync-${ConnectorType.SaaS}-${AuthType.ServiceAccount}-scheduler`
export const SyncGoogleWorkspace = `sync-${Apps.GoogleWorkspace}-${AuthType.ServiceAccount}`
export const CheckDownloadsFolderQueue = `check-downloads-folder`
export const SyncSlackQueue = `sync-${Apps.Slack}-${AuthType.OAuth}`
export const SyncSlackPerUserQueue = `sync-${Apps.Slack}-${AuthType.OAuth}-per-user`
export const SyncSlackSchedulerQueue = `sync-${Apps.Slack}-${AuthType.OAuth}-scheduler`
export const SyncZohoDeskQueue = `sync-${Apps.ZohoDesk}-${AuthType.OAuth}`
export const ProcessZohoDeskTicketQueue = `process-${Apps.ZohoDesk}-ticket`
export const ProcessZohoDeskAttachmentQueue = `process-${Apps.ZohoDesk}-attachment`
export const SyncToolsQueue = `sync-tools`
export const CleanupAttachmentsQueue = `cleanup-attachments`
export const ProgressEvent = "progress-event"

boss.on("error", (error) => {
  console.error(`Queue error: ${error} ${(error as Error).stack}`)
})
