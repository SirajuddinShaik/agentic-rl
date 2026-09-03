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

export const skills = pgTable(
  "skills",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    // Short unique handle: search/tag + the identifier the LLM references.
    alias: text("alias").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (table) => ({
    skillCreatedByIndex: index("skill_created_by_index").on(table.createdBy),
    skillAliasUnique: uniqueIndex("skill_alias_unique_index").on(table.alias),
  }),
)

// Many-to-many: which skills are attached to which agents.
export const skillAgentMappings = pgTable(
  "skill_agent_mappings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    agentId: integer("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (table) => ({
    skillAgentUnique: uniqueIndex("skill_agent_unique_index").on(
      table.skillId,
      table.agentId,
    ),
    skillAgentSkillIdIndex: index("skill_agent_skill_id_index").on(
      table.skillId,
    ),
    skillAgentAgentIdIndex: index("skill_agent_agent_id_index").on(
      table.agentId,
    ),
  }),
)

export const insertSkillSchema = createInsertSchema(skills).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
})
export type InsertSkill = z.infer<typeof insertSkillSchema>

export const selectSkillSchema = createSelectSchema(skills)
export type SelectSkill = z.infer<typeof selectSkillSchema>

export const insertSkillAgentMappingSchema = createInsertSchema(
  skillAgentMappings,
).omit({
  id: true,
  createdAt: true,
})
export type InsertSkillAgentMapping = z.infer<
  typeof insertSkillAgentMappingSchema
>

export const selectSkillAgentMappingSchema =
  createSelectSchema(skillAgentMappings)
export type SelectSkillAgentMapping = z.infer<
  typeof selectSkillAgentMappingSchema
>
