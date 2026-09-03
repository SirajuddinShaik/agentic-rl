import { Hono } from "hono"
import { stream } from "hono/streaming"
import { HTTPException } from "hono/http-exception"
import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { createWorkflowRouter } from "@xyne/workflow-sdk"
import type { RouteRequest } from "@xyne/workflow-sdk"
import type { JwtPayload } from "@/app/lib/tokens"
import { db } from "@/platform/db/client"
import { getUserAndWorkspaceByEmail } from "@/platform/db/user"
import { workflowRuntime } from "./runtime"
import { registerShareRoutes } from "./share"
import type { XyneCtx } from "./acl"
import { getLogger } from "@/platform/logger"
import { Subsystem } from "@/types"

type Vars = { jwtPayload: JwtPayload }

const Logger = getLogger(Subsystem.WorkflowApi).child({ module: "workflow-router" })

// Build the SDK route definitions once at module load.
// The `authenticate` callback is only called by the SDK for unauthenticated routes
// (webhooks, wait-callbacks) where auth is path-embedded — it's never invoked for
// the protected routes we wire manually below.
const routeDefs = createWorkflowRouter(workflowRuntime, {
  authenticate: (_headers) => {
    throw new HTTPException(401, { message: "Unauthorized" })
  },
})

const publicRouteDefs = routeDefs.filter((r) => r.authenticated === false)


// ── Utility: adapt Hono Context to RouteRequest ──────────────────────────────

const buildRouteRequest = async (
  c: Context,
  injectBodyPatch?: (body: Record<string, unknown>) => void,
): Promise<RouteRequest> => {
  const params = c.req.param() as Record<string, string>
  const query: Record<string, string> = Object.fromEntries(
    Object.entries(c.req.query()).map(([k, v]) => [k, String(v)]),
  )
  const headers: Record<string, string> = {}
  c.req.raw.headers.forEach((value, key) => { headers[key] = value })

  const ct = c.req.header("content-type") ?? ""
  let body: unknown
  let files: Array<{ fieldName?: string; name: string; mimeType: string; bytes: Uint8Array }> | undefined

  if (ct.includes("multipart/form-data")) {
    const parsed = await c.req.parseBody({ all: true })
    body = {}
    files = []
    for (const [fieldName, v] of Object.entries(parsed)) {
      const values = Array.isArray(v) ? v : [v]
      const bodyValues: string[] = []
      for (const value of values) {
        if (value instanceof File) {
          const ab = await value.arrayBuffer()
          files.push({
            fieldName,
            name: value.name,
            mimeType: value.type,
            bytes: new Uint8Array(ab),
          })
        } else {
          bodyValues.push(value)
        }
      }
      if (bodyValues.length === 1) {
        ;(body as Record<string, unknown>)[fieldName] = bodyValues[0]
      } else if (bodyValues.length > 1) {
        ;(body as Record<string, unknown>)[fieldName] = bodyValues
      }
    }
  } else if (ct.includes("application/json")) {
    body = await c.req.json().catch(() => undefined)
  }

  // A workflow/folder `name` must be a well-formed string. A JSON object once
  // slipped through as {"$ne":"test"} (a NoSQL-injection probe) and crashed the
  // analytics UI's `name.toLowerCase()` filter. Enforce the type AND a
  // conservative character set — letters, digits, spaces, and _ ( ) + - — which
  // covers every real name while rejecting injection/special characters.
  if (body && typeof body === "object" && "name" in body) {
    const rawName = (body as Record<string, unknown>).name
    if (rawName != null) {
      if (typeof rawName !== "string") {
        throw new HTTPException(400, { message: "`name` must be a string" })
      }
      if (!/^[A-Za-z0-9 _()+-]+$/.test(rawName)) {
        throw new HTTPException(400, {
          message:
            "`name` may contain only letters, digits, spaces, and _ ( ) + -",
        })
      }
    }
  }

  if (body && injectBodyPatch) {
    injectBodyPatch(body as Record<string, unknown>)
  }

  return {
    params,
    query,
    body,
    headers,
    ...(files !== undefined ? { files } : {}),
  }
}

// ── Protected router (mounted at /v2 under AuthMiddleware) ──────────────────
// All SDK routes keep their full paths (/workflows, /schema, /executions, etc.)
// so the frontend client using baseUrl="/v2" resolves them correctly.

export const workflowRouter = new Hono<{ Variables: Vars }>()

for (const routeDef of routeDefs.filter((r) => r.authenticated !== false)) {
  workflowRouter.on(
    routeDef.method,
    routeDef.path,
    async (c) => {
      const payload = c.get("jwtPayload")
      const uw = await getUserAndWorkspaceByEmail(db, payload.workspaceId, payload.sub)
      const ctx: XyneCtx = {
        userId: uw.user.id,
        workspaceExternalId: payload.workspaceId,
      }

      // Derive attributes from ctx on create — never trusted from the client.
      // The SDK forwards body.attributes into createWorkflow/createFolder; the
      // adapter reads workspaceId (tenant) and createdByUserId (owner-row stamp).
      const isCreate =
        routeDef.method === "POST" &&
        (routeDef.path === "/workflows" || routeDef.path === "/folders")

      const req = await buildRouteRequest(
        c,
        isCreate
          ? (body): void => {
              body["attributes"] = {
                workspaceId: ctx.workspaceExternalId,
                createdByUserId: ctx.userId,
              }
            }
          : undefined,
      )

      let response: Awaited<ReturnType<typeof routeDef.handler>>
      try {
        response = await routeDef.handler(req, ctx)
      } catch (err) {
        if (err instanceof HTTPException) throw err
        throw new HTTPException(500, {
          message: err instanceof Error ? err.message : "Internal error",
        })
      }

      if (response.stream) {
        c.header("Content-Type", "text/event-stream")
        c.header("Cache-Control", "no-cache")
        c.header("Connection", "keep-alive")
        return stream(c, async (s) => {
          for await (const chunk of response.stream!) {
            await s.write(chunk)
          }
        })
      }

      if (response.headers) {
        for (const [k, v] of Object.entries(response.headers)) {
          c.header(k, v)
        }
      }

      // Redirect (e.g. attachment download via a signed URL).
      const location = response.headers?.["Location"]
      if (response.status >= 300 && response.status < 400 && location) {
        return c.redirect(location)
      }

      // Binary body (e.g. attachment download streamed from storage).
      // Hono's c.body accepts string | ArrayBuffer | ReadableStream, so copy
      // the view's bytes into a fresh ArrayBuffer of exactly that length.
      if (response.body instanceof Uint8Array) {
        const bytes = response.body
        const ab = new ArrayBuffer(bytes.byteLength)
        new Uint8Array(ab).set(bytes)
        return c.body(ab, response.status as ContentfulStatusCode)
      }

      return c.json(
        response.body as Record<string, unknown>,
        response.status as ContentfulStatusCode,
      )
    },
  )
}

// Host-owned sharing routes (grant/revoke/list/setPublic) — the SDK ships the
// action vocabulary, not the mutation. Mounted on the same authenticated router.
registerShareRoutes(workflowRouter)

// ── AI builder — also expose under /v2 (proxied by the UI dev server) ────────
// The SDK marks /ai-builder/chat as `authenticated: false` so the host can use
// path-embedded secrets, but we re-expose it behind AuthMiddleware at /v2 so
// the browser can reach it through the existing /v2 vite proxy.

for (const routeDef of routeDefs.filter((r) => r.path === "/ai-builder/chat")) {
  workflowRouter.on(routeDef.method, routeDef.path, async (c) => {
    const req = await buildRouteRequest(c)
    let response: Awaited<ReturnType<typeof routeDef.handler>>
    try {
      response = await routeDef.handler(req, null)
    } catch (err) {
      if (err instanceof HTTPException) throw err
      throw new HTTPException(500, {
        message: err instanceof Error ? err.message : "Internal error",
      })
    }
    if (response.stream) {
      c.header("Content-Type", "text/event-stream")
      c.header("Cache-Control", "no-cache")
      c.header("Connection", "keep-alive")
      return stream(c, async (s) => {
        for await (const chunk of response.stream!) {
          await s.write(chunk)
        }
      })
    }
    return c.json(
      response.body as Record<string, unknown>,
      response.status as ContentfulStatusCode,
    )
  })
}

// ── Public router (no auth — secret-in-path security model) ─────────────────

export const workflowPublicRouter = new Hono()

// These SDK routes mount BEFORE AuthMiddleware with auth=null — reachable
// unauthenticated via the SDK's public-route metadata. Executions they start are
// flagged `publicTrigger` by the SDK, and privileged steps (SEND_EMAIL) refuse
// to run for such runs (#18). Enumerated at boot so the surface stays auditable.
Logger.info(
  { routes: publicRouteDefs.map((r) => `${String(r.method)} ${r.path}`) },
  "workflow: mounting unauthenticated public routes (secret-in-path model)",
)

for (const routeDef of publicRouteDefs) {
  workflowPublicRouter.on(routeDef.method, routeDef.path, async (c) => {
    const req = await buildRouteRequest(c)
    let response: Awaited<ReturnType<typeof routeDef.handler>>
    try {
      response = await routeDef.handler(req, null)
    } catch (err) {
      if (err instanceof HTTPException) throw err
      throw new HTTPException(500, {
        message: err instanceof Error ? err.message : "Internal error",
      })
    }
    if (response.stream) {
      c.header("Content-Type", "text/event-stream")
      c.header("Cache-Control", "no-cache")
      c.header("Connection", "keep-alive")
      return stream(c, async (s) => {
        for await (const chunk of response.stream!) {
          await s.write(chunk)
        }
      })
    }
    return c.json(
      response.body as Record<string, unknown>,
      response.status as ContentfulStatusCode,
    )
  })
}
