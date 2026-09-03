// Export all tables
export * from "@/platform/db/schema/acl"
export * from "@/platform/db/schema/abbreviation"
export * from "@/platform/db/schema/workspaces"
export * from "@/platform/db/schema/users"
export * from "@/platform/db/schema/userPersonalization"
export * from "@/platform/db/schema/connectors"
export * from "@/platform/db/schema/oauthProviders"
export * from "@/platform/db/schema/syncJobs"
export * from "@/platform/db/schema/syncHistory"
export * from "@/platform/db/schema/chats"
export * from "@/platform/db/schema/messages"
export * from "@/platform/db/schema/chatTrace"
export * from "@/platform/db/schema/agents"
export * from "@/platform/db/schema/subAgents"
export * from "@/platform/db/schema/userAgentPermissions"
export * from "@/platform/db/schema/sdkResourcePermissions"
export * from "@/platform/db/schema/McpConnectors"
export * from "@/platform/db/schema/sharedChats"
export * from "@/platform/db/schema/knowledgeBase"
export * from "@/platform/db/schema/doclingAsyncScheduler"
export * from "@/platform/db/schema/apiKey"
export * from "@/platform/db/schema/workflows"
export * from "@/platform/db/schema/calls"
export * from "@/platform/db/schema/userWorkflowPermissions"
export * from "@/platform/db/schema/directMessages"
export * from "@/platform/db/schema/channels"
export * from "@/platform/db/schema/threads"
export * from "@/platform/db/schema/ingestions"
export * from "@/platform/db/schema/databaseSyncState"
export * from "@/platform/db/schema/summaries"
export * from "@/platform/db/schema/agentDocuments"
export * from "@/platform/db/schema/v2Chat"
export * from "@/platform/db/schema/skills"
export * from "@/platform/db/schema/mcps"
export * from "@/platform/db/schema/workflowSdk"

// Export combined types
import type { PublicUser, SelectUser } from "@/platform/db/schema/users"
import type { PublicWorkspace, SelectWorkspace } from "@/platform/db/schema/workspaces"

export type PublicUserWorkspace = {
  user: PublicUser
  workspace: PublicWorkspace
}

// if data is not sent out, we can keep all fields
export type InternalUserWorkspace = {
  user: SelectUser
  workspace: SelectWorkspace
}
