import { sql } from "drizzle-orm"
import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"

// Abbreviation Table
// Stores abbreviations and their full forms for query expansion in Vespa search
export const abbreviations = pgTable("abbreviation", {
  id: serial("id").notNull().primaryKey(),
  word: text("word").notNull(),
  fullForm: text("full_form").notNull(),
  votes: integer("votes").notNull().default(0),
  totalDefs: integer("total_defs").notNull().default(0),
  altCount: integer("alt_count").notNull().default(0),
  exampleDocId: text("example_doc_id"),
  allFullForms: text("all_full_forms"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`NOW()`),
})

export const selectAbbreviationSchema = createSelectSchema(abbreviations)
export const insertAbbreviationSchema = createInsertSchema(abbreviations)

export type SelectAbbreviation = z.infer<typeof selectAbbreviationSchema>
export type InsertAbbreviation = z.infer<typeof insertAbbreviationSchema>
