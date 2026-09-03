import { z } from "zod"

// The user_agent_permissions TABLE is dropped — agent access lives in the
// unified `acl` table. These schemas/types are retained as the shape the
// (acl-backed) agent-permission functions return, so consumers are unchanged.

export const selectUserAgentPermissionSchema = z.object({
  id: z.number(),
  userId: z.number(),
  agentId: z.number(),
  role: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
})
export type SelectUserAgentPermission = z.infer<
  typeof selectUserAgentPermissionSchema
>

export const insertUserAgentPermissionSchema = z.object({
  userId: z.number(),
  agentId: z.number(),
  role: z.string().optional(),
})
export type InsertUserAgentPermission = z.infer<
  typeof insertUserAgentPermissionSchema
>

// Permission joined with user + agent detail, for the "who has access" UI.
export const userAgentPermissionWithDetailsSchema =
  selectUserAgentPermissionSchema.extend({
    user: z.object({
      id: z.number(),
      email: z.string(),
      name: z.string(),
      photoLink: z.string().nullable(),
      externalId: z.string(),
    }),
    agent: z.object({
      id: z.number(),
      externalId: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      model: z.string(),
    }),
  })
export type UserAgentPermissionWithDetails = z.infer<
  typeof userAgentPermissionWithDetailsSchema
>
