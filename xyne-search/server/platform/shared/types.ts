import {
  Apps,
  AttachmentEntity,
  CalendarEntity,
  DataSourceEntity,
  DriveEntity,
  GooglePeopleEntity,
  KbItemsSchema,
  KnowledgeBaseEntity,
  MailAttachmentEntity,
  MailEntity,
  MicrosoftPeopleEntity,
  NotionEntity,
  SlackEntity,
  SystemEntity,
  VespaChatContainerSchema,
  VespaEventSchema,
  VespaFileSchema,
  VespaKbFileSchemaBase,
  VespaUserSchema,
  WebSearchEntity,
  ZohoEntity,
  chatContainerSchema,
  chatUserSchema,
  dataSourceFileSchema,
  eventSchema,
  fileSchema,
  mailAttachmentSchema,
  mailSchema,
  userQuerySchema,
  userSchema,
} from "@xyne/vespa-ts/types"
export {
  GooglePeopleEntity,
  DriveEntity,
  NotionEntity,
  CalendarEntity,
  MailAttachmentEntity,
  SlackEntity,
  AttachmentEntity,
  Apps,
  isMailAttachment,
  SystemEntity,
  dataSourceFileSchema,
  DataSourceEntity,
  WebSearchEntity,
  KnowledgeBaseEntity,
  datasourceSchema,
  ZohoEntity,
} from "@xyne/vespa-ts/types"

export { ZohoEntity as ZohoDeskEntity } from "@xyne/vespa-ts/types"
export type {
  Entity,
  VespaDataSourceFile,
  VespaGetResult,
  FileResponse,
  SearchResultsSchema,
  SearchResponse,
  SearchResultDiscriminatedUnion,
  Span,
  VespaChatContainerSearch,
  VespaChatUserSearch,
  VespaSearchResults,
} from "@xyne/vespa-ts/types"

export type VespaFile = z.infer<typeof VespaFileSchema>
export const FileEntitySchema = z.union([
  z.nativeEnum(DriveEntity),
  z.nativeEnum(AttachmentEntity),
])
export const MailEntitySchema = z.nativeEnum(MailEntity)
export const MailAttachmentEntitySchema = z.nativeEnum(MailAttachmentEntity)
export const EventEntitySchema = z.nativeEnum(CalendarEntity)
export const SystemEntitySchema = z.nativeEnum(SystemEntity)
export const DataSourceEntitySchema = z.nativeEnum(DataSourceEntity)
export const WebSearchEntitySchema = z.nativeEnum(WebSearchEntity)
export const KnowledgeBaseEntitySchema = z.nativeEnum(KnowledgeBaseEntity)
const NotionEntitySchema = z.nativeEnum(NotionEntity)
export const PeopleEntitySchema = z.nativeEnum(GooglePeopleEntity)
export const ChatEntitySchema = z.nativeEnum(SlackEntity)
export const MicrosoftPeopleEntitySchema = z.nativeEnum(MicrosoftPeopleEntity)
export const ZohoDeskEntitySchema = z.nativeEnum(ZohoEntity)
export const entitySchema = z.union([
  SystemEntitySchema,
  PeopleEntitySchema,
  MicrosoftPeopleEntitySchema,
  FileEntitySchema,
  NotionEntitySchema,
  MailEntitySchema,
  EventEntitySchema,
  MailAttachmentEntitySchema,
  ChatEntitySchema,
  DataSourceEntitySchema,
  WebSearchEntitySchema,
  KnowledgeBaseEntitySchema,
  ZohoDeskEntitySchema,
])

export const ConnectorType = {
  SaaS: "SaaS", // Google, Notion, Github
  Database: "Database", // DuckDB, Postgres, MySQL
  API: "Api",
  File: "File", // manually uploaded data like pdf
  Website: "Website", // scraped / crawled
  MCP: "Mcp",
} as const
export type ConnectorType = (typeof ConnectorType)[keyof typeof ConnectorType]

import { z } from "zod"
import type { DatabaseEngine } from "@/integrations/database/types"

export type { Citation, ImageCitation } from "@/platform/shared/chat/types"
export type {
  SelectPublicMessage,
  PublicUser,
  SelectPublicChat,
  PublicWorkspace,
  SelectPublicAgent,
  UserMetadata,
  // @ts-ignore
} from "@/platform/db/schema"


export const AuthType = {
  OAuth: "oauth",
  ServiceAccount: "service_account",
  // custom JSON holding the key material for end-to-end encryption
  Custom: "custom",
  ApiKey: "api_key",
} as const
export type AuthType = (typeof AuthType)[keyof typeof AuthType]

export const ConnectorStatus = {
  Connected: "connected",
  Connecting: "connecting",

  Paused: "paused",
  Failed: "failed",
  NotConnected: "not-connected", // default for oauth
  Authenticated: "authenticated",
} as const
export type ConnectorStatus =
  (typeof ConnectorStatus)[keyof typeof ConnectorStatus]

export const SyncJobStatus = {
  NotStarted: "NotStarted",
  Started: "Started",
  Failed: "Failed",
  Successful: "Successful",
} as const
export type SyncJobStatus = (typeof SyncJobStatus)[keyof typeof SyncJobStatus]

export const OpenAIError = {
  RateLimitError: "rate_limit_exceeded",
  InvalidAPIKey: "invalid_api_key",
} as const
export type OpenAIError = (typeof OpenAIError)[keyof typeof OpenAIError]

export const FileType = {
  IMAGE: "Image",
  DOCUMENT: "Document",
  SPREADSHEET: "Spreadsheet",
  PRESENTATION: "Presentation",
  PDF: "PDF",
  TEXT: "Text",
  FILE: "File", // fallback
} as const
export type FileType = (typeof FileType)[keyof typeof FileType]

export const MIME_TYPE_MAPPINGS = {
  [FileType.IMAGE]: [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/gif",
    "image/webp",
  ],
  [FileType.DOCUMENT]: [
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  [FileType.SPREADSHEET]: [
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/csv",
  ],
  [FileType.PRESENTATION]: [
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  [FileType.PDF]: ["application/pdf"],
  [FileType.TEXT]: ["text/plain", "text/markdown"],
} as const

// Fallback detection when MIME type is unavailable.
export const EXTENSION_MAPPINGS = {
  [FileType.IMAGE]: [".jpg", ".jpeg", ".png", ".gif", ".webp"],
  [FileType.DOCUMENT]: [".doc", ".docx"],
  [FileType.SPREADSHEET]: [".xls", ".xlsx", ".csv"],
  [FileType.PRESENTATION]: [".ppt", ".pptx"],
  [FileType.PDF]: [".pdf"],
  [FileType.TEXT]: [".txt", ".md"],
} as const

export const attachmentFileTypeMap: Record<string, AttachmentEntity> = {
  [FileType.DOCUMENT]: AttachmentEntity.Docs,
  [FileType.SPREADSHEET]: AttachmentEntity.Sheets,
  [FileType.PRESENTATION]: AttachmentEntity.PPT,
  [FileType.PDF]: AttachmentEntity.PDF,
  [FileType.TEXT]: AttachmentEntity.Text,
  [FileType.IMAGE]: AttachmentEntity.Image,
  [FileType.FILE]: AttachmentEntity.File,
}

export const ApiKeyScopes = {
  CREATE_AGENT: "CREATE_AGENT",
  READ_AGENT: "READ_AGENT",
  AGENT_CHAT: "AGENT_CHAT",
  AGENT_CHAT_STOP: "AGENT_CHAT_STOP",
  UPDATE_AGENT: "UPDATE_AGENT",
  DELETE_AGENT: "DELETE_AGENT",
  CHAT_HISTORY: "CHAT_HISTORY",
  CREATE_COLLECTION: "CREATE_COLLECTION",
  UPDATE_COLLECTION: "UPDATE_COLLECTION",
  LIST_COLLECTIONS: "LIST_COLLECTIONS",
  UPLOAD_FILES: "UPLOAD_FILES",
  SEARCH_COLLECTION: "SEARCH_COLLECTION",
  DELETE_COLLECTION: "DELETE_COLLECTION",
  DELETE_COLLECTION_ITEM: "DELETE_COLLECTION_ITEM",
  MESSAGE_FEEDBACK: "MESSAGE_FEEDBACK",
  ENHANCED_MESSAGE_FEEDBACK: "ENHANCED_MESSAGE_FEEDBACK",
} as const
export type ApiKeyScopes = (typeof ApiKeyScopes)[keyof typeof ApiKeyScopes]

export const AutocompleteFileSchema = z
  .object({
    type: z.literal(fileSchema),
    relevance: z.number(),
    title: z.string(),
    app: z.nativeEnum(Apps),
    entity: entitySchema,
  })
  .strip()

export const AutocompleteUserSchema = z
  .object({
    type: z.literal(userSchema),
    relevance: z.number(),
    // optional due to contacts
    name: z.string().optional(),
    email: z.string(),
    app: z.nativeEnum(Apps),
    entity: entitySchema,
    photoLink: z.string().optional(),
  })
  .strip()

export const AutocompleteUserQueryHSchema = z
  .object({
    type: z.literal(userQuerySchema),
    docId: z.string(),
    query_text: z.string(),
    timestamp: z.number().optional(),
  })
  .strip()

export const AutocompleteMailSchema = z
  .object({
    type: z.literal(mailSchema),
    relevance: z.number(),
    // optional due to contacts
    subject: z.string().optional(),
    app: z.nativeEnum(Apps),
    entity: entitySchema,
    threadId: z.string().optional(),
    docId: z.string(),
  })
  .strip()

export const AutocompleteMailAttachmentSchema = z
  .object({
    type: z.literal(mailAttachmentSchema),
    relevance: z.number(),
    app: z.nativeEnum(Apps),
    entity: entitySchema,
    filename: z.string(),
    docId: z.string(),
  })
  .strip()

export const AutocompleteEventSchema = z
  .object({
    type: z.literal(eventSchema),
    relevance: z.number(),
    name: z.string().optional(),
    app: z.nativeEnum(Apps),
    entity: entitySchema,
    docId: z.string(),
  })
  .strip()

export const AutocompleteChatUserSchema = z
  .object({
    type: z.literal(chatUserSchema),
    relevance: z.number(),
    // optional due to contacts
    name: z.string().optional(),
    email: z.string().optional(),
    app: z.nativeEnum(Apps),
    entity: entitySchema,
    image: z.string(),
  })
  .strip()

export const AutocompleteChatContainerSchema = z
  .object({
    type: z.literal(chatContainerSchema),
    relevance: z.number(),
    name: z.string(),
    app: z.nativeEnum(Apps),
    entity: entitySchema,
    docId: z.string(),
  })
  .strip()

export const AutocompleteKbFileSchema = z
  .object({
    type: z.literal(KbItemsSchema),
    relevance: z.number(),
    title: z.string(),
    app: z.literal(Apps.KnowledgeBase),
    entity: KnowledgeBaseEntitySchema,
    docId: z.string(),
  })
  .strip()

const AutocompleteSchema = z.discriminatedUnion("type", [
  AutocompleteFileSchema,
  AutocompleteUserSchema,
  AutocompleteMailSchema,
  AutocompleteEventSchema,
  AutocompleteUserQueryHSchema,
  AutocompleteMailAttachmentSchema,
  AutocompleteChatUserSchema,
  AutocompleteChatContainerSchema,
  AutocompleteKbFileSchema,
])

export const AutocompleteResultsSchema = z.object({
  results: z.array(AutocompleteSchema),
})

export type AutocompleteResults = z.infer<typeof AutocompleteResultsSchema>

// when imported from the frontend the type comes with unknown types
// possibly related to
// https://github.com/colinhacks/zod/issues/3536#issuecomment-2374074951
export type FileAutocomplete = z.infer<typeof AutocompleteFileSchema>
export type UserAutocomplete = z.infer<typeof AutocompleteUserSchema>
export type MailAutocomplete = z.infer<typeof AutocompleteMailSchema>
export type ChatUserAutocomplete = z.infer<typeof AutocompleteChatUserSchema>
export type AutocompleteChatContainer = z.infer<
  typeof AutocompleteChatContainerSchema
>
export type MailAttachmentAutocomplete = z.infer<
  typeof AutocompleteMailAttachmentSchema
>
export type EventAutocomplete = z.infer<typeof AutocompleteEventSchema>
export type UserQueryHAutocomplete = z.infer<
  typeof AutocompleteUserQueryHSchema
>
export type KbFileAutocomplete = z.infer<typeof AutocompleteKbFileSchema>
export type Autocomplete = z.infer<typeof AutocompleteSchema>

export const scoredChunk = z.object({
  chunk: z.string(),
  score: z.number(),
  index: z.number(),
})

export const FileResponseSchema = VespaFileSchema.pick({
  docId: true,
  title: true,
  url: true,
  app: true,
  entity: true,
  owner: true,
  ownerEmail: true,
  photoLink: true,
  updatedAt: true,
})
  .extend({
    type: z.literal(fileSchema),
    chunk: z.string().optional(),
    chunkIndex: z.number().optional(),
    mimeType: z.string(),
    chunks_summary: z.array(scoredChunk).optional(),
    relevance: z.number(),
    matchfeatures: z.any().optional(),
    rankfeatures: z.any().optional(),
  })
  .strip()

export const KbFileResponseSchema = VespaKbFileSchemaBase.pick({
  docId: true,
  fileName: true,
  app: true,
  entity: true,
  createdBy: true,
  updatedAt: true,
  itemId: true,
  clId: true,
  mimeType: true,
})
  .extend({
    app: z.literal(Apps.KnowledgeBase),
    type: z.literal(KbItemsSchema),
    chunk: z.string().optional(),
    chunkIndex: z.number().optional(),
    chunks_summary: z.array(scoredChunk).optional(),
    relevance: z.number(),
    matchfeatures: z.any().optional(),
    rankfeatures: z.any().optional(),
  })
  .strip()
export const EventResponseSchema = VespaEventSchema.pick({
  docId: true,
  name: true,
  url: true,
  app: true,
  entity: true,
  updatedAt: true,
})
  .extend({
    type: z.literal(eventSchema),
    relevance: z.number(),
    description: z.string().optional(),
    chunks_summary: z.array(z.string()).optional(),
    attendeesNames: z.array(z.string()).optional(),
    matchfeatures: z.any().optional(),
    rankfeatures: z.any().optional(),
  })
  .strip()

export const UserResponseSchema = VespaUserSchema.pick({
  name: true,
  email: true,
  app: true,
  entity: true,
  photoLink: true,
  docId: true,
})
  .strip()
  .extend({
    type: z.literal(userSchema),
    relevance: z.number(),
    matchfeatures: z.any().optional(),
    rankfeatures: z.any().optional(),
  })

export const DataSourceFileResponseSchema = z
  .object({
    docId: z.string(),
    title: z.string().optional(),
    fileName: z.string().optional(),
    url: z.string().optional(),
    owner: z.string().optional(),
    ownerEmail: z.string().email().optional(),
    updatedAt: z.number().optional(),
    createdAt: z.number().optional(),
    mimeType: z.string().optional(),
    size: z.number().optional(),

    type: z.literal(dataSourceFileSchema),
    app: z.literal(Apps.DataSource),
    entity: z.literal("file"),

    chunks_summary: z.array(scoredChunk).optional(),
    relevance: z.number(),
    matchfeatures: z.any().optional(),
    rankfeatures: z.any().optional(),
  })
  .strip()

export const ChatContainerResponseSchema = VespaChatContainerSchema.pick({
  docId: true,
  name: true,
  app: true,
  entity: true,
  updatedAt: true,
  isPrivate: true,
  isArchived: true,
  isGeneral: true,
  isIm: true,
  isMpim: true,
  topic: true,
  description: true,
  count: true,
})
  .extend({
    type: z.literal(chatContainerSchema),
    relevance: z.number(),
    matchfeatures: z.any().optional(),
    rankfeatures: z.any().optional(),
  })
  .strip()

export const AnswerResponseSchema = z.object({})

// Single-char keys keep the SSE payload small.
export const AnswerSSEvents = {
  Start: "s",
  AnswerUpdate: "u",
  End: "e",
} as const
export type AnswerSSEvents = (typeof AnswerSSEvents)[keyof typeof AnswerSSEvents]

export const ChatSSEvents = {
  ResponseMetadata: "rm",
  Start: "s",
  ResponseUpdate: "u",
  End: "e",
  ChatTitleUpdate: "ct",
  CitationsUpdate: "cu",
  ImageCitationUpdate: "icu",
  Reasoning: "rz",
  DeepResearchReasoning: "drr",
  Error: "er",
  AttachmentUpdate: "au",
  ClarificationRequested: "cr",
  ClarificationProvided: "cp",
} as const
export type ChatSSEvents = (typeof ChatSSEvents)[keyof typeof ChatSSEvents]

const messageMetadataSchema = z.object({
  chatId: z.string(),
  messageId: z.string(),
})

export type MessageMetadataResponse = z.infer<typeof messageMetadataSchema>

export const UserRole = {
  User: "User", // oauth their own data, or api-key based
  TeamLeader: "TeamLeader", // manage Users
  Admin: "Admin", // service-account changes
  SuperAdmin: "SuperAdmin", // Admin-level changes
} as const
export type UserRole = (typeof UserRole)[keyof typeof UserRole]

export const UserAgentRole = {
  Owner: "owner",
  Editor: "editor",
  Viewer: "viewer",
  Shared: "shared", // general (non-owner/editor/viewer) access
} as const
export type UserAgentRole = (typeof UserAgentRole)[keyof typeof UserAgentRole]

export const UserWorkflowRole = {
  Owner: "owner",
  Shared: "shared",
  Viewer: "viewer", // role granted when the workflow is public
} as const
export type UserWorkflowRole =
  (typeof UserWorkflowRole)[keyof typeof UserWorkflowRole]

export const SdkResourceRole = {
  Owner: "owner",
  Editor: "editor",
  Viewer: "viewer",
} as const
export type SdkResourceRole =
  (typeof SdkResourceRole)[keyof typeof SdkResourceRole]

export const MessageFeedback = {
  Like: "like",
  Dislike: "dislike",
} as const
export type MessageFeedback =
  (typeof MessageFeedback)[keyof typeof MessageFeedback]

export const ChannelType = {
  Public: "public",
  Private: "private",
} as const
export type ChannelType = (typeof ChannelType)[keyof typeof ChannelType]

export const ChannelMemberRole = {
  Owner: "owner",
  Admin: "admin",
  Member: "member",
} as const
export type ChannelMemberRole =
  (typeof ChannelMemberRole)[keyof typeof ChannelMemberRole]

export const MessageType = {
  Channel: "channel",
  Direct: "direct",
} as const
export type MessageType = (typeof MessageType)[keyof typeof MessageType]

export const MessageMode = {
  Ask: "ask",
  Agentic: "agentic",
} as const
export type MessageMode = (typeof MessageMode)[keyof typeof MessageMode]

export const ContextSysthesisState = {
  Complete: "complete",
  Partial: "partial_information",
  NotFound: "information_not_found",
} as const
export type ContextSysthesisState =
  (typeof ContextSysthesisState)[keyof typeof ContextSysthesisState]

// ─── Structured Reasoning Event System ────────────────────────────────────────
// Typed events replace freeform text + regex on both ends of the wire.

export type ReasoningStage =
  | "understanding"
  | "gathering"
  | "analyzing"
  | "consulting"
  | "preparing"

export const ReasoningEventType = {
  // ── Lifecycle ──────────────────────────────────────────────────────────────
  TurnStarted: "turn_started",
  TurnCompleted: "turn_completed",
  PlanCreated: "plan_created",
  SynthesisStarted: "synthesis_started",
  SynthesisCompleted: "synthesis_completed",

  // ── Tool lifecycle ─────────────────────────────────────────────────────────
  ToolExecuting: "tool_executing",
  ToolCompleted: "tool_completed",
  ToolSkippedDuplicate: "tool_skipped_duplicate",
  ToolSkippedCooldown: "tool_skipped_cooldown",
  ToolValidationError: "tool_validation_error",
  ToolCooldownApplied: "tool_cooldown_applied",
  ToolRecovered: "tool_recovered",

  // ── Document pipeline ──────────────────────────────────────────────────────
  DocumentsFound: "documents_found",
  DocumentsFilteringStarted: "documents_filtering_started",
  DocumentsFiltered: "documents_filtered",
  DocumentsRanking: "documents_ranking",
  MetadataFilterApplied: "metadata_filter_applied",
  MetadataNoMatch: "metadata_no_match",
  RankingFailed: "ranking_failed",

  // ── Agent delegation ───────────────────────────────────────────────────────
  AgentSearching: "agent_searching",
  AgentsFound: "agents_found",
  AgentNoMatch: "agent_no_match",
  AgentDelegated: "agent_delegated",
  AgentCompleted: "agent_completed",

  // ── Attachments ────────────────────────────────────────────────────────────
  AttachmentAnalyzing: "attachment_analyzing",
  AttachmentExtracted: "attachment_extracted",

  // ── Review ─────────────────────────────────────────────────────────────────
  ReviewStarted: "review_started",
  ReviewCompleted: "review_completed",
  AnomaliesDetected: "anomalies_detected",

  // ── Fallback / recovery ────────────────────────────────────────────────────
  FallbackActivated: "fallback_activated",
  FallbackCompleted: "fallback_completed",

  // ── Agent Raw Thinking (from models like Claude 3.7, o3-mini) ─────────────
  AgentThinkingStart: "thinking_start",
  AgentThinkingDelta: "thinking_delta",
  AgentThinkingEnd: "thinking_end",

  // ── Agent stop reason ──────────────────────────────────────────────────────
  AgentStopped: "agent_stopped",

  // ── Context management ────────────────────────────────────────────────────
  ContextCompacted: "context_compacted",

  // ── Generic (escape hatch — use sparingly) ─────────────────────────────────
  LogMessage: "log_message",
} as const
export type ReasoningEventType =
  (typeof ReasoningEventType)[keyof typeof ReasoningEventType]

/**
 * Subtask shape sent over SSE inside plan_created events. Mirrors the
 * server-side SubTask but carries only the fields the frontend needs.
 */
export interface PlanSubTask {
  id: string
  description: string
  status: "pending" | "in_progress" | "completed" | "blocked" | "failed"
}

export interface ReasoningEventPayload {
  /** Discriminant for icon, grouping, and rendering. */
  type: ReasoningEventType

  /** Pre-rendered sentence; the frontend displays it as-is, no transforms. */
  displayText: string

  stage: ReasoningStage

  // ── Optional structured fields (type-specific) ─────────────────────────────
  toolName?: string // plain string — tool names come from JAF at runtime
  count?: number
  agentName?: string
  turnNumber?: number
  detail?: string
  /** The search/lookup query used in this tool call — shown in the UI beneath the step label. */
  toolQuery?: string

  /** Present on plan_created events — the full goal + subtask list for the PlanCard. */
  plan?: { goal: string; subTasks: PlanSubTask[] }

  // ── Orchestration metadata ─────────────────────────────────────────────────
  runId?: string
  /** When set, this event belongs to a delegated sub-agent */
  agent?: string
  /** Unique per run_public_agent call; frontend groups by this so one container per tool call */
  delegationRunId?: string
  /** When set, identifies the orchestrator that delegated to `agent` */
  parentAgent?: string
  /**
   * Unique per individual tool execution (generated at tool_requests time).
   * Not set for runPublicAgent calls (those use delegationRunId instead).
   * Frontend groups all events sharing this ID into a collapsible tool block.
   */
  toolExecutionId?: string
  timestamp: number
}

export const XyneTools = {
  toDoWrite: "toDoWrite",
  searchGlobal: "searchGlobal",
  searchKnowledgeBase: "searchKnowledgeBase",
  searchGmail: "searchGmail",
  searchDriveFiles: "searchDriveFiles",
  searchCalendarEvents: "searchCalendarEvents",
  searchGoogleContacts: "searchGoogleContacts",
  getSlackRelatedMessages: "getSlackRelatedMessages",
  getSlackThreads: "getSlackThreads",
  getSlackUserProfile: "getSlackUserProfile",
  searchChatHistory: "searchChatHistory",
  listCustomAgents: "list_custom_agents",
  runPublicAgent: "run_public_agent",
  fallBack: "fall_back",
  synthesizeFinalAnswer: "synthesize_final_answer",
  MetadataRetrieval: "metadata_retrieval",
  readDocument: "read_document",
  getDocumentOutline: "getDocumentOutline",
  getPageContent: "getPageContent",
} as const
export type XyneTools = (typeof XyneTools)[keyof typeof XyneTools]

export const IngestionType = {
  fullIngestion: "full_ingestion",
  partialIngestion: "partial_ingestion",
} as const
export type IngestionType = (typeof IngestionType)[keyof typeof IngestionType]

export const attachmentMetadataSchema = z.object({
  fileId: z.string(),
  fileName: z.string(),
  fileType: z.string(),
  fileSize: z.number(),
  isImage: z.boolean(),
  thumbnailUrl: z.string().optional(),
  createdAt: z.union([z.string(), z.date()]).transform((val) => {
    if (typeof val === "string") {
      return new Date(val)
    }
    return val
  }),
  url: z.string().optional(),
})

export type AttachmentMetadata = z.infer<typeof attachmentMetadataSchema>

export const ApiKeyPermissionsSchema = z.object({
  scopes: z.array(z.nativeEnum(ApiKeyScopes)),
  agents: z.array(z.string()).optional(),
})

export const CreateApiKeySchema = z.object({
  name: z.string().min(1, "Name is required"),
  permissions: ApiKeyPermissionsSchema,
})

export type ApiKeyPermissions = z.infer<typeof ApiKeyPermissionsSchema>
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeySchema>

export const DEFAULT_TEST_AGENT_ID = "default-test-agent"

export const agentPromptPayloadSchema = z.preprocess(
  (val) => {
    if (typeof val === "string") {
      try {
        return JSON.parse(val)
      } catch {
        throw new Error("Invalid agentPromptPayload JSON")
      }
    }
    return val
  },
  z
    .object({
      name: z.string().optional(),
      description: z.string().optional(),
      prompt: z.string().optional(),
      model: z.string().optional(),
      isPublic: z.boolean().optional(),
      isRagOn: z.boolean().optional(),
      appIntegrations: z
        .record(
          z.string(),
          z.object({
            itemIds: z.array(z.string()),
            selectedAll: z.boolean(),
          }),
        )
        .optional(),
      docIds: z
        .array(
          z.object({
            docId: z.string(),
            name: z.string(),
            app: z.string(),
            entity: z.string(),
          }),
        )
        .optional(),
      userEmails: z.array(z.string()).optional(),
      ownerEmails: z.array(z.string()).optional(),
      allowWebSearch: z.boolean().optional(),
    })
    .optional(),
)

export type AgentPromptPayload = z.infer<typeof agentPromptPayloadSchema>

export interface ModelConfiguration {
  actualName?: string
  labelName: string
  provider?: string
  reasoning: boolean
  websearch: boolean
  deepResearch: boolean
  description: string
  /** Per-model sampler params applied at the LLM-call boundary. */
  streamOptions?: {
    temperature?: number
    topP?: number
  }
  /** Pi-mono compaction-threshold target. Set BELOW the real provider
   *  limit so compaction (and the mid-turn `shouldStopAfterTurn` hook)
   *  fires before the provider rejects oversized requests. Omit to use
   *  BACKENDV2_PI_CONTEXT_WINDOW. */
  contextWindow?: number
  /** Compaction headroom; threshold = contextWindow − reserveTokens.
   *  Thinking models need more because reasoning tokens inflate output
   *  unpredictably between message_end and the next call. Omit to use
   *  BACKENDV2_PI_RESERVE_TOKENS. */
  reserveTokens?: number
  /** Tokens of recent transcript kept through a compaction (older becomes
   *  a summary). Omit to use BACKENDV2_PI_KEEP_RECENT_TOKENS. */
  keepRecentTokens?: number
  /** Default reasoning budget when the caller passes no thinkingLevel.
   *  Tuned per model — e.g. Nemotron hits streaming-truncation cliffs
   *  around ~1k reasoning tokens, so it defaults below the global "medium".
   *  UI selectors still override per message. */
  thinkingLevel?: "minimal" | "low" | "medium" | "high"
}
export const getDocumentSchema = z.object({
  docId: z.string().min(1),
  sheetIndex: z.number().min(0).optional(),
  schema: z.string().min(1),
})

export const UploadStatus = {
  PENDING: "pending",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
} as const
export type UploadStatus = (typeof UploadStatus)[keyof typeof UploadStatus]

export interface DatabaseConnectorConfig {
  engine: DatabaseEngine
  host: string
  port: number
  database: string
  schema?: string
  /** include/ignore filter which tables to sync; embed = table names to sync as full data (CSV). Others sync as schema-only (JSON). */
  tables?: { include?: string[]; ignore?: string[]; embed?: string[] }
  auth: { username: string; password: string }
  batchSize: number
  /** Column name for watermark-based incremental sync (e.g. updated_at). Optional. */
  watermarkColumn?: string
}
