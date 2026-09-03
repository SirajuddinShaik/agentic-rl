// Sharing is host policy, not SDK runtime — the SDK ships the *action*
// (`workflow:share` / `folder:share`) but not the mutation. So these routes live
// here, and they GUARD by re-checking through the SDK: getWorkflow/getFolder
// returns the caller's permittedActions, and we require the share action in it.
// That way the share guard can never drift from the enforcement everything else
// uses — it IS that enforcement.

import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { eq } from "drizzle-orm"
import { db } from "@/platform/db/client"
import { sdkWorkflows, sdkFolders } from "@/platform/db/schema/workflowSdk"
import { getUserAndWorkspaceByEmail } from "@/platform/db/user"
import {
  grantSdkPermission,
  revokeSdkPermission,
  listSdkGrantsFor,
  type SdkResourceType,
} from "@/platform/db/sdkResourcePermission"
import { SdkResourceRole } from "@/platform/shared/types"
import { AccessDeniedError, ResourceNotFoundError } from "@xyne/workflow-sdk"
import type { Action } from "@xyne/workflow-sdk"
import { workflowRuntime } from "./runtime"
import type { XyneCtx } from "./acl"
import type { JwtPayload } from "@/app/lib/tokens"

type Vars = { jwtPayload: JwtPayload }

const ctxOf = async (payload: JwtPayload): Promise<XyneCtx> => {
  const uw = await getUserAndWorkspaceByEmail(db, payload.workspaceId, payload.sub)
  return { userId: uw.user.id, workspaceExternalId: payload.workspaceId }
}

// Roles a share can grant. Owner is create-only (one owner; transfer is future
// work), so sharing offers editor (full-except-transfer) or viewer (read).
const SHAREABLE_ROLES: readonly SdkResourceRole[] = [
  SdkResourceRole.Editor,
  SdkResourceRole.Viewer,
]

/**
 * The caller's permittedActions on a resource, via the SDK — the same computation
 * the runtime enforces. Maps the SDK's typed errors to HTTP so a denied read is
 * a clean 403/404, not a 500.
 */
const permittedActionsFor = async (
  ctx: XyneCtx,
  type: SdkResourceType,
  id: string,
): Promise<readonly Action[]> => {
  try {
    const rec =
      type === "workflow"
        ? await workflowRuntime.getWorkflow(ctx, id)
        : await workflowRuntime.getFolder(ctx, id)
    return rec.permittedActions
  } catch (err) {
    if (err instanceof AccessDeniedError) throw new HTTPException(403, { message: "Forbidden" })
    if (err instanceof ResourceNotFoundError) throw new HTTPException(404, { message: "Not found" })
    throw err
  }
}

const requireShare = async (ctx: XyneCtx, type: SdkResourceType, id: string): Promise<void> => {
  const perms = await permittedActionsFor(ctx, type, id)
  const action: Action = type === "workflow" ? "workflow:share" : "folder:share"
  if (!perms.includes(action)) {
    throw new HTTPException(403, { message: "You do not have permission to share this resource" })
  }
}

/** Register share/unshare/list/public routes for one resource type onto `router`. */
const registerFor = (router: Hono<{ Variables: Vars }>, type: SdkResourceType): void => {
  const base = type === "workflow" ? "/workflows/:id" : "/folders/:id"
  const table = type === "workflow" ? sdkWorkflows : sdkFolders

  // Who has access + public flag — for the share dialog. Gated on read (you can
  // see the list if you can see the resource).
  router.get(`${base}/shares`, async (c) => {
    const ctx = await ctxOf(c.get("jwtPayload"))
    const id = c.req.param("id")
    await permittedActionsFor(ctx, type, id) // 403/404 if not visible
    const [shares, rows] = await Promise.all([
      listSdkGrantsFor(db, type, id),
      db.select({ isPublic: table.isPublic }).from(table).where(eq(table.id, id)).limit(1),
    ])
    return c.json({ shares, isPublic: rows[0]?.isPublic ?? false })
  })

  // Grant a colleague access. The target is resolved BY the caller's workspace,
  // so a user outside the workspace 404s — cross-workspace grants are impossible,
  // not merely inert.
  router.post(`${base}/share`, async (c) => {
    const ctx = await ctxOf(c.get("jwtPayload"))
    const id = c.req.param("id")
    await requireShare(ctx, type, id)

    const body = (await c.req.json().catch(() => ({}))) as { email?: string; role?: string }
    if (!body.email || typeof body.email !== "string") {
      throw new HTTPException(400, { message: 'Body must contain "email"' })
    }
    const role = body.role as SdkResourceRole
    if (!SHAREABLE_ROLES.includes(role)) {
      throw new HTTPException(400, { message: `role must be one of: ${SHAREABLE_ROLES.join(", ")}` })
    }

    // Resolve within the caller's workspace — throws 404 if not a member.
    const target = await getUserAndWorkspaceByEmail(db, ctx.workspaceExternalId, body.email)
    await grantSdkPermission(db, target.user.id, type, id, role)
    return c.json({ shared: true, userId: target.user.id, role })
  })

  // Revoke a colleague's access.
  router.delete(`${base}/share/:userId`, async (c) => {
    const ctx = await ctxOf(c.get("jwtPayload"))
    const id = c.req.param("id")
    await requireShare(ctx, type, id)
    const userId = Number(c.req.param("userId"))
    if (!Number.isInteger(userId)) {
      throw new HTTPException(400, { message: "userId must be an integer" })
    }
    await revokeSdkPermission(db, userId, type, id)
    return c.json({ revoked: true })
  })

  // Flip workspace-wide visibility. Same guard as sharing (owner/editor).
  router.post(`${base}/public`, async (c) => {
    const ctx = await ctxOf(c.get("jwtPayload"))
    const id = c.req.param("id")
    await requireShare(ctx, type, id)
    const body = (await c.req.json().catch(() => ({}))) as { isPublic?: boolean }
    if (typeof body.isPublic !== "boolean") {
      throw new HTTPException(400, { message: 'Body must contain boolean "isPublic"' })
    }
    await db.update(table).set({ isPublic: body.isPublic }).where(eq(table.id, id))
    return c.json({ isPublic: body.isPublic })
  })
}

/** Mount the sharing routes onto an already-authenticated (jwtPayload) router. */
export const registerShareRoutes = (router: Hono<{ Variables: Vars }>): void => {
  registerFor(router, "workflow")
  registerFor(router, "folder")
}
