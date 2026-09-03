// Sub-agents: leaves under a parent agent, soft-deleted via `deleted_at`.
// Flat by design — no recursive FK; the build-time registry filter prevents
// a sub-agent from dispatching further sub-agents. External identity is
// `external_id` (stored un-FK'd in v2_chat_runs.sub_agent_id).

import { sql } from "drizzle-orm"
import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"

import { agents } from "./agents"
import { workspaces } from "./workspaces"

export const subAgents = pgTable(
  "sub_agents",
  {
    id: serial("id").notNull().primaryKey(),
    externalId: text("external_id").unique().notNull(),
    parentAgentId: integer("parent_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    // dispatchSubagent `name` arg; unique within a parent (see index below).
    name: text("name").notNull(),
    description: text("description").notNull(),
    systemPrompt: text("system_prompt").notNull(),
    // Subset of pi-mono registry tool names; empty array = all registry tools.
    tools: jsonb("tools").notNull().default(sql`'[]'::jsonb`),
    // Per-sub-agent reasoning effort, read at dispatch (parent can't override).
    // Text not pgEnum so pi-ai ThinkingLevel additions need no migration; zod
    // pins allowed values at the API boundary.
    thinkingLevel: text("thinking_level").notNull().default("medium"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    parentIndex: index("sub_agents_parent_idx").on(table.parentAgentId),
    nameUniquePerParent: uniqueIndex("sub_agents_name_per_parent_unique").on(
      table.parentAgentId,
      table.name,
    ),
  }),
)

// pi-ai's ThinkingLevel minus "xhigh" (not exposed to sub-agent authors yet;
// column is text-typed so adding it later is a zod-only change).
export const SUB_AGENT_THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
] as const
export type SubAgentThinkingLevel = (typeof SUB_AGENT_THINKING_LEVELS)[number]
export const subAgentThinkingLevelSchema = z.enum(SUB_AGENT_THINKING_LEVELS)

export const insertSubAgentSchema = createInsertSchema(subAgents, {
  // Shape only; registry-subset validation happens at the API layer.
  tools: z.array(z.string()).optional().default([]),
  name: z
    .string()
    .min(2)
    .max(64)
    .regex(
      /^[a-z][a-z0-9-]*$/,
      "name must be a lowercase slug ([a-z][a-z0-9-]*)",
    ),
  description: z.string().min(1).max(500),
  systemPrompt: z.string().min(1),
  // Optional for back-compat with create-payloads predating this field.
  thinkingLevel: subAgentThinkingLevelSchema.optional().default("medium"),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
})
export type InsertSubAgent = z.infer<typeof insertSubAgentSchema>

export const selectSubAgentSchema = createSelectSchema(subAgents, {
  tools: z.array(z.string()).default([]),
  thinkingLevel: subAgentThinkingLevelSchema,
})
export type SelectSubAgent = z.infer<typeof selectSubAgentSchema>
