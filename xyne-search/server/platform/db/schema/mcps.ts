import { sql } from "drizzle-orm"
import {
  pgTable,
  uuid,
  integer,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { users } from "./users"
import { agents } from "./agents"
import { encryptedText } from "@/platform/db/customType"
import { Encryption } from "@/utils/encryption"

// Config carries the server URL + auth header secrets, so it is stored as an
// encrypted TEXT column holding stringified JSON (never jsonb).
const mcpConfigEncryption = new Encryption(process.env.ENCRYPTION_KEY!)

// Remote transports supported in v1. stdio/websocket are deferred — extend this
// union (+ the create form) when they land.
export const McpType = {
  StreamableHttp: "streamable_http",
  Sse: "sse",
} as const
export type McpType = (typeof McpType)[keyof typeof McpType]

export const mcps = pgTable(
  "mcps",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    description: text("description").notNull(),
    // Transport kind — one of McpType.
    type: text("type").notNull(),
    // Encrypted stringified JSON: { url, headers?: Record<string,string> }.
    config: encryptedText(mcpConfigEncryption)("config").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (table) => ({
    mcpCreatedByIndex: index("mcp_created_by_index").on(table.createdBy),
  }),
)

// Many-to-many: which MCPs are attached to which agents.
export const mcpAgentMappings = pgTable(
  "mcp_agent_mappings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    mcpId: uuid("mcp_id")
      .notNull()
      .references(() => mcps.id, { onDelete: "cascade" }),
    agentId: integer("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (table) => ({
    mcpAgentUnique: uniqueIndex("mcp_agent_unique_index").on(
      table.mcpId,
      table.agentId,
    ),
    mcpAgentMcpIdIndex: index("mcp_agent_mcp_id_index").on(table.mcpId),
    mcpAgentAgentIdIndex: index("mcp_agent_agent_id_index").on(table.agentId),
  }),
)

export const insertMcpSchema = createInsertSchema(mcps).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
})
export type InsertMcp = z.infer<typeof insertMcpSchema>

export const selectMcpSchema = createSelectSchema(mcps)
export type SelectMcp = z.infer<typeof selectMcpSchema>

export const insertMcpAgentMappingSchema = createInsertSchema(
  mcpAgentMappings,
).omit({
  id: true,
  createdAt: true,
})
export type InsertMcpAgentMapping = z.infer<typeof insertMcpAgentMappingSchema>

export const selectMcpAgentMappingSchema = createSelectSchema(mcpAgentMappings)
export type SelectMcpAgentMapping = z.infer<typeof selectMcpAgentMappingSchema>
