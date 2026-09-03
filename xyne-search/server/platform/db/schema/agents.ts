import { sql } from "drizzle-orm"
import {
  serial,
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
  index,
  uniqueIndex,
  pgEnum
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { workspaces } from "./workspaces"
import { users } from "./users"


export const AgentCreationSource = {
  DIRECT: "direct",
  WORKFLOW: "workflow",
} as const
export type AgentCreationSource =
  (typeof AgentCreationSource)[keyof typeof AgentCreationSource]
export const creationSourceEnum = pgEnum(
  "creation_source",
  Object.values(AgentCreationSource) as [string, ...string[]]
)
export const agents = pgTable(
  "agents",
  {
    id: serial("id").notNull().primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    externalId: text("external_id").unique().notNull(),
    name: text("name").notNull(),
    description: text("description"),
    prompt: text("prompt"),
    model: text("model").notNull(),
    appIntegrations: jsonb("app_integrations").default(sql`'[]'::jsonb`),
    allowWebSearch: boolean("allow_web_search").default(false),
    isRagOn: boolean("is_rag_on").default(true).notNull(),
    // When true (default), vespaSearch runs its in-tool LLM relevance filter:
    // better precision at +2-5s/search. False skips it (raw Vespa hits).
    searchFilterEnabled: boolean("search_filter_enabled")
      .default(true)
      .notNull(),
    docIds: jsonb("doc_ids").default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    via_apiKey: boolean("via_apiKey").notNull().default(false),
    creation_source: creationSourceEnum("creation_source").default(AgentCreationSource.DIRECT).notNull(),

    // Per-section system prompt (main/tools/subagents). Resolution order:
    // any per-section column set → these; else legacy `prompt`; else
    // hard-coded defaults in pi-mono/system-prompt/defaults/.
    systemPromptMain: text("system_prompt_main"),
    systemPromptTools: text("system_prompt_tools"),
    systemPromptSubagents: text("system_prompt_subagents"),

    // Subset of pi-mono registry tool names; empty array = all tools
    // (runner treats empty list same as undefined).
    tools: jsonb("tools").notNull().default(sql`'[]'::jsonb`),

    // Per-workspace fallback agent; at most one per workspace via the
    // partial unique index below.
    isDefault: boolean("is_default").notNull().default(false),

    // Extractor agents require a structured response: the chat service
    // validates final text against responseSchema and re-prompts on failure
    // (up to extractorMaxRetries) with the validation errors.
    isExtractor: boolean("is_extractor").notNull().default(false),
    responseSchema: jsonb("response_schema"),
    extractorMaxRetries: integer("extractor_max_retries")
      .notNull()
      .default(2),
  },
  (table) => ({
    agentWorkspaceIdIndex: index("agent_workspace_id_index").on(
      table.workspaceId,
    ),
    agentUserIdIndex: index("agent_user_id_index").on(table.userId),
    agentExternalIdIndex: uniqueIndex("agent_external_id_unique_index").on(
      table.externalId,
    ),
    // Partial unique: one default agent per workspace (false rows exempt).
    defaultPerWorkspace: uniqueIndex("agents_default_per_workspace_unique")
      .on(table.workspaceId)
      .where(sql`${table.isDefault} = true`),
  }),
)

export const fetchedDataSourceSchema = z.object({
  docId: z.string(),
  name: z.string(),
  app: z.string(),
  entity: z.string(),
})

export type FetchedDataSource = z.infer<typeof fetchedDataSourceSchema>

export const insertAgentSchema = createInsertSchema(agents, {
  // Legacy string[] OR AppSelectionMap (per-app item/filter selection).
  appIntegrations: z
    .union([
      z.array(z.string()),
      z.record(
        z.string(),
        z.object({
          itemIds: z.array(z.string()),
          selectedAll: z.boolean(),
          filters: z
            .array(
              z.object({
                id: z.number(),
                // Gmail filters
                from: z.array(z.string()).optional(),
                to: z.array(z.string()).optional(),
                cc: z.array(z.string()).optional(),
                bcc: z.array(z.string()).optional(),
                // Slack filters
                senderId: z.array(z.string()).optional(),
                channelId: z.array(z.string()).optional(),
                timeRange: z
                  .object({
                    startDate: z.number(),
                    endDate: z.number(),
                  })
                  .optional(),
              }),
            )
            .optional(),
        }),
      ),
    ])
    .optional()
    .default([]),
  docIds: z.array(fetchedDataSourceSchema).optional().default([]),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
})

export type InsertAgent = z.infer<typeof insertAgentSchema>

export const selectAgentSchema = createSelectSchema(agents, {
  // Legacy string[] OR AppSelectionMap (per-app item/filter selection).
  appIntegrations: z
    .union([
      z.array(z.string()),
      z.record(
        z.string(),
        z.object({
          itemIds: z.array(z.string()),
          selectedAll: z.boolean(),
          filters: z
            .array(
              z.object({
                id: z.number(),
                // Gmail filters
                from: z.array(z.string()).optional(),
                to: z.array(z.string()).optional(),
                cc: z.array(z.string()).optional(),
                bcc: z.array(z.string()).optional(),
                // Slack filters
                senderId: z.array(z.string()).optional(),
                channelId: z.array(z.string()).optional(),
                timeRange: z
                  .object({
                    startDate: z.number(),
                    endDate: z.number(),
                  })
                  .optional(),
              }),
            )
            .optional(),
        }),
      ),
    ])
    .optional()
    .default([]),
  docIds: z.array(fetchedDataSourceSchema).optional().default([]),
  via_apiKey: z.boolean().default(false).optional(),
})
export type SelectAgent = z.infer<typeof selectAgentSchema>

export const selectPublicAgentSchema = selectAgentSchema
  .omit({
    id: true,
    workspaceId: true,
    userId: true,
    deletedAt: true,
    creation_source: true,
  })
  // is_public is dropped from the table; it's derived from acl (a workspace
  // grant) and supplied by the query layer, but stays in the public contract.
  .extend({ isPublic: z.boolean() })
export type SelectPublicAgent = z.infer<typeof selectPublicAgentSchema>
