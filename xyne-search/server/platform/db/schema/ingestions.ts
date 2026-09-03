// Resumable ingestion jobs (Slack, Zoho Desk) with per-integration progress.

import { sql } from "drizzle-orm"
import {
  serial,
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  pgEnum,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { workspaces } from "./workspaces"
import { users } from "./users"
import { connectors } from "./connectors"

export const ingestionStatusEnum = pgEnum("ingestion_status", [
  "pending",
  "in_progress",
  "paused",
  "completed",
  "failed",
  "cancelled",
])

export const ingestions = pgTable(
  "ingestions",
  {
    id: serial("id").notNull().primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    connectorId: integer("connector_id")
      .notNull()
      .references(() => connectors.id),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    status: ingestionStatusEnum("status").notNull().default("pending"),
    // Resumability + progress state; shape per integration below.
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  // No unique constraint; concurrent-active prevention is enforced in app code.
)

// Slack metadata stored in the `metadata` JSONB column.
export const slackIngestionMetadataSchema = z.object({
  websocketData: z.object({
    connectorId: z.string(),
    currentChannelId: z.string().optional(),
    progress: z
      .object({
        totalChannels: z.number().optional(),
        processedChannels: z.number().optional(),
        currentChannel: z.string().optional(),
        totalMessages: z.number().optional(),
        processedMessages: z.number().optional(),
      })
      .optional(),
  }),
  // Resume cursor + original params for interrupted ingestions.
  ingestionState: z
    .object({
      currentChannelId: z.string().optional(),
      lastMessageTs: z.string().optional(),
      lastUpdated: z.string(),
      channelsToIngest: z.array(z.string()).optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      includeBotMessage: z.boolean().optional(),
      currentChannelIndex: z.number().optional(),
    })
    .optional(),
})

// Zoho Desk metadata stored in the `metadata` JSONB column.
export const zohoDeskIngestionMetadataSchema = z.object({
  websocketData: z.object({
    connectorId: z.string(),
    progress: z
      .object({
        totalTickets: z.number().optional(),
        processedTickets: z.number().optional(),
        ticketsWithAttachments: z.number().optional(),
        totalAttachments: z.number().optional(),
        processedAttachments: z.number().optional(),
        errors: z.number().optional(),
      })
      .optional(),
  }),
  ingestionState: z
    .object({
      lastTicketIndex: z.number().optional(), // Zoho `from` pagination param
      lastModifiedTime: z.string().optional(), // incremental sync watermark
      lastUpdated: z.string(),
      isInitialSync: z.boolean().optional(),
      startDate: z.string().optional(),
    })
    .optional(),
})

export const ingestionMetadataSchema = z.object({
  slack: slackIngestionMetadataSchema.optional(),
  zohoDesk: zohoDeskIngestionMetadataSchema.optional(),
})

export const insertIngestionSchema = createInsertSchema(ingestions, {
  metadata: ingestionMetadataSchema.optional(),
})

export const selectIngestionSchema = createSelectSchema(ingestions, {
  metadata: ingestionMetadataSchema.optional(),
})

export type InsertIngestion = z.infer<typeof insertIngestionSchema>
export type SelectIngestion = z.infer<typeof selectIngestionSchema>
export type IngestionStatus =
  | "pending"
  | "in_progress"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
export type SlackIngestionMetadata = z.infer<
  typeof slackIngestionMetadataSchema
>
export type ZohoDeskIngestionMetadata = z.infer<
  typeof zohoDeskIngestionMetadataSchema
>
