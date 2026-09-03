import { sql } from "drizzle-orm"
import {
  serial,
  pgTable,
  integer,
  text,
  timestamp,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import { z } from "zod"
import { SdkResourceRole } from "@/platform/shared/types"
import { users } from "@/platform/db/schema/users"

// One polymorphic table for both workflows and folders — the deliberate choice
// for workflow-sdk sharing (differs from agents' per-resource table). Ownership
// is a row with role='owner'; there is no separate owner column. Lives in the
// public schema so the FK to public.users is direct; resource_id is text (the
// sdk cuid) with no FK because it spans two tables in the `workflow` schema.
export const sdkResourceRoleEnum = pgEnum(
  "sdk_resource_role",
  Object.values(SdkResourceRole) as [string, ...string[]],
)

export const sdkResourcePermissions = pgTable(
  "sdk_resource_permissions",
  {
    id: serial("id").notNull().primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    resourceType: text("resource_type").notNull(), // 'workflow' | 'folder'
    resourceId: text("resource_id").notNull(), // sdk cuid; polymorphic, no FK
    role: sdkResourceRoleEnum("role").notNull().default(SdkResourceRole.Viewer),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`NOW()`),
  },
  (t) => ({
    // One grant per (user, resource) — backs the grant upsert and is the index
    // the accessible-resources LEFT JOIN rides (all three cols equality-bound).
    uniqueIndex: uniqueIndex("sdk_resource_permission_unique_index").on(
      t.userId,
      t.resourceType,
      t.resourceId,
    ),
    // Backs listGrantsFor(type, id) — the share dialog's "who has access".
    resourceIndex: index("sdk_resource_permissions_resource_index").on(
      t.resourceType,
      t.resourceId,
    ),
    userIdIndex: index("sdk_resource_permissions_user_id_index").on(t.userId),
  }),
)

export const insertSdkResourcePermissionSchema = createInsertSchema(
  sdkResourcePermissions,
).omit({ id: true, createdAt: true, updatedAt: true })
export type InsertSdkResourcePermission = z.infer<
  typeof insertSdkResourcePermissionSchema
>

export const selectSdkResourcePermissionSchema = createSelectSchema(
  sdkResourcePermissions,
)
export type SelectSdkResourcePermission = z.infer<
  typeof selectSdkResourcePermissionSchema
>
