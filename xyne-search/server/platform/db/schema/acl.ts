import { sql } from "drizzle-orm"
import {
  serial,
  pgTable,
  integer,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { workspaces } from "@/platform/db/schema/workspaces"
import { users } from "@/platform/db/schema/users"

// Unified access-control list. One row = one grant of `role` on
// (resourceType, resourceId) to a principal (a specific user, or the whole
// workspace for "public"). Effective access to a resource is the MAX role
// over the viewer's grants plus grants inherited from the resource's
// ancestors (KB: file -> folder -> collection). `source` records provenance
// so grants derived from sharing an agent/project can be cascaded away on
// unshare without disturbing independent (direct) grants.
//
// Columns are plain text (not pgEnum) so the engine can register new resource
// types (project, data_source, …) without an ALTER TYPE migration. Valid
// values are enforced at the app layer via the consts below.

export const AclResourceType = {
  Collection: "collection",
  Folder: "folder",
  File: "file",
  Agent: "agent",
  Skill: "skill",
  Mcp: "mcp",
  Project: "project",
} as const
export type AclResourceType =
  (typeof AclResourceType)[keyof typeof AclResourceType]

export const AclPrincipalType = {
  User: "user",
  Workspace: "workspace",
} as const
export type AclPrincipalType =
  (typeof AclPrincipalType)[keyof typeof AclPrincipalType]

export const AclRole = {
  Owner: "owner",
  Editor: "editor",
  Viewer: "viewer",
} as const
export type AclRole = (typeof AclRole)[keyof typeof AclRole]

export const AclSourceType = {
  Direct: "direct",
  Agent: "agent",
  Project: "project",
} as const
export type AclSourceType = (typeof AclSourceType)[keyof typeof AclSourceType]

export const acl = pgTable(
  "acl",
  {
    id: serial("id").notNull().primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Resource being granted on. `resourceId` is the resource's own primary
    // key as text (uuid for collection/folder/skill/project; numeric id for
    // agents) — kept text so one column spans every resource type.
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    // Grantee: a user (principalId = users.id) or the workspace as a whole
    // (principalId = workspaces.id) for a workspace-public grant.
    principalType: text("principal_type").notNull(),
    principalId: integer("principal_id").notNull(),
    role: text("role").notNull(),
    // Provenance. `direct` = an explicit share (sourceId ''). Derived grants
    // carry the agent/project resource id that produced them, so a single
    // (sourceType, sourceId) delete cleanly revokes exactly that share's
    // grants. NOT NULL (default '') so the unique index actually dedupes —
    // NULLs would compare distinct and allow duplicate direct grants.
    sourceType: text("source_type").notNull().default(AclSourceType.Direct),
    sourceId: text("source_id").notNull().default(""),
    createdBy: integer("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (table) => ({
    // At most one grant per (resource, principal, source).
    uniqueGrant: uniqueIndex("acl_unique_grant").on(
      table.resourceType,
      table.resourceId,
      table.principalType,
      table.principalId,
      table.sourceType,
      table.sourceId,
    ),
    // Resolver: fetch every grant on a resource (and its ancestors).
    resourceIndex: index("acl_resource_index").on(
      table.resourceType,
      table.resourceId,
    ),
    // "Resources I can access" listings.
    principalIndex: index("acl_principal_index").on(
      table.principalType,
      table.principalId,
    ),
    // Cascade: delete every grant a given agent/project produced.
    sourceIndex: index("acl_source_index").on(table.sourceType, table.sourceId),
    workspaceIndex: index("acl_workspace_index").on(table.workspaceId),
  }),
)

export const insertAclSchema = createInsertSchema(acl).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
})
export type InsertAcl = z.infer<typeof insertAclSchema>

export const selectAclSchema = createSelectSchema(acl)
export type SelectAcl = z.infer<typeof selectAclSchema>
