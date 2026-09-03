import { and, eq } from "drizzle-orm"
import { Hono, type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"

import { db } from "@/platform/db/client"
import { apiKeys } from "@/platform/db/schema"
import {
  DEFAULT_API_KEY_EXPIRY_DAYS,
  createUserApiKey,
  getApiKeyExpiresAt,
  getApiKeyExpiresAtFrom,
  getUserAndWorkspaceByEmail,
} from "@/platform/db/user"
import { ApiKeyScopes } from "@/platform/shared/types"
import { loadAgentScope } from "../agent/agent-scope"
import { viewerFromPayload } from "../agent/services/chat"

type Vars = {
  jwtPayload: { sub: string; workspaceId: string }
}

type NormalisedConfig = {
  scopes: ApiKeyScopes[]
  agents?: string[]
  expiresAt?: string
  neverExpires?: boolean
}

const router = new Hono<{ Variables: Vars }>()

const scopeSchema = z.nativeEnum(ApiKeyScopes)
const expiryDaysSchema = z.union([z.literal(30), z.literal(60), z.literal(90)])
const configSchema = z.object({
  scopes: z.array(scopeSchema).min(1),
  agents: z.array(z.string().trim().min(1)).optional(),
})

const createApiKeySchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(120),
    scopes: z.array(scopeSchema).optional(),
    agents: z.array(z.string().trim().min(1)).optional(),
    expiresInDays: z.union([expiryDaysSchema, z.null()]).optional(),
    neverExpires: z.boolean().optional(),
    permissions: configSchema.optional(),
  })
  .transform((body) => {
    const permissions = body.permissions
    return {
      name: body.name,
      scopes: permissions?.scopes ?? body.scopes ?? [],
      agents: permissions?.agents ?? body.agents,
      expiresInDays:
        body.neverExpires === true
          ? null
          : body.expiresInDays === undefined
            ? DEFAULT_API_KEY_EXPIRY_DAYS
            : body.expiresInDays,
    }
  })
  .superRefine((body, ctx) => {
    if (body.scopes.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopes"],
        message: "At least one scope is required",
      })
      return
    }
    const unsupported = body.scopes.filter(
      (scope) => scope !== ApiKeyScopes.AGENT_CHAT,
    )
    if (unsupported.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopes"],
        message: `Only ${ApiKeyScopes.AGENT_CHAT} is supported by backendv2 API keys`,
      })
    }
  })

const normaliseConfig = (raw: unknown): NormalisedConfig => {
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  const scopes = Array.isArray(obj["scopes"])
    ? obj["scopes"].filter(
        (scope): scope is ApiKeyScopes =>
          typeof scope === "string" &&
          Object.values(ApiKeyScopes).includes(scope as ApiKeyScopes),
      )
    : []
  const agents = Array.isArray(obj["agents"])
    ? obj["agents"].filter((agent): agent is string => typeof agent === "string")
    : undefined
  const expiresAt =
    typeof obj["expiresAt"] === "string" ? obj["expiresAt"] : undefined
  const neverExpires = obj["neverExpires"] === true
  return {
    scopes,
    ...(agents && agents.length > 0 ? { agents } : {}),
    ...(neverExpires ? { neverExpires } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  }
}

const resolveExpiresAt = (
  config: NormalisedConfig,
  createdAt: Date,
): string => {
  if (config.neverExpires) {
    return "No expiry"
  }
  if (config.expiresAt) {
    const date = new Date(config.expiresAt)
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString()
    }
  }
  return getApiKeyExpiresAtFrom(createdAt).toISOString()
}

const authOf = async (
  c: Context<{ Variables: Vars }>,
): Promise<{
  email: string
  userExternalId: string
  workspaceExternalId: string
}> => {
  const payload = c.get("jwtPayload")
  const { user, workspace } = await getUserAndWorkspaceByEmail(
    db,
    payload.workspaceId,
    payload.sub,
  )
  return {
    email: payload.sub,
    userExternalId: user.externalId,
    workspaceExternalId: workspace.externalId,
  }
}

const assertAgentsAccessible = async (
  auth: Awaited<ReturnType<typeof authOf>>,
  agents: string[] | undefined,
): Promise<string[] | undefined> => {
  if (!agents || agents.length === 0) {
    return undefined
  }
  const deduped = [...new Set(agents.map((agent) => agent.trim()).filter(Boolean))]
  const viewer = viewerFromPayload({
    sub: auth.email,
    workspaceId: auth.workspaceExternalId,
  })
  for (const agentId of deduped) {
    const scope = await loadAgentScope(viewer, agentId)
    if (!scope) {
      throw new HTTPException(404, {
        message: `Agent ${agentId} not found or access denied`,
      })
    }
  }
  return deduped
}

const handle = async (
  c: Context<{ Variables: Vars }>,
  fn: () => Promise<Response | object>,
): Promise<Response> => {
  try {
    const result = await fn()
    return result instanceof Response ? result : c.json(result)
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json(
        { message: "Invalid input", errors: err.flatten().fieldErrors },
        400,
      )
    }
    if (err instanceof HTTPException) {
      throw err
    }
    throw new HTTPException(500, {
      message: err instanceof Error ? err.message : "Internal error",
    })
  }
}

router.get("/", (c) =>
  handle(c, async () => {
    const auth = await authOf(c)
    const rows = await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        config: apiKeys.config,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.userId, auth.userExternalId),
          eq(apiKeys.workspaceId, auth.workspaceExternalId),
        ),
      )
      .orderBy(apiKeys.createdAt)

    return {
      keys: rows.map((row) => {
        const config = normaliseConfig(row.config)
        return {
          id: row.id.toString(),
          name: row.name,
          keyPrefix: row.keyPrefix,
          scopes: config.scopes,
          agents: config.agents ?? [],
          createdAt: row.createdAt.toISOString(),
          expiresAt: resolveExpiresAt(config, row.createdAt),
        }
      }),
    }
  }),
)

router.post("/", (c) =>
  handle(c, async () => {
    const rawBody: unknown = await c.req.json().catch(() => {
      throw new HTTPException(400, { message: "JSON body required" })
    })
    const body = createApiKeySchema.parse(rawBody)
    const auth = await authOf(c)
    const agents = await assertAgentsAccessible(auth, body.agents)
    const created = await createUserApiKey({
      db,
      userId: auth.userExternalId,
      workspaceId: auth.workspaceExternalId,
      name: body.name,
      expiresAt:
        body.expiresInDays === null ? null : getApiKeyExpiresAt(body.expiresInDays),
      scope: {
        scopes: [ApiKeyScopes.AGENT_CHAT],
        ...(body.expiresInDays === null ? { neverExpires: true } : {}),
        ...(agents ? { agents } : {}),
      },
    })
    if (!created.success || !created.key) {
      if (created.code === "ACTIVE_API_KEY_LIMIT_REACHED") {
        throw new HTTPException(409, {
          message: created.error || "Active API key limit reached",
        })
      }
      throw new HTTPException(500, {
        message: created.error || "Failed to create API key",
      })
    }
    const [row] = await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        config: apiKeys.config,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.userId, auth.userExternalId),
          eq(apiKeys.workspaceId, auth.workspaceExternalId),
          eq(apiKeys.key, created.key),
        ),
      )
      .limit(1)
    if (!row) {
      throw new HTTPException(500, {
        message: "API key was created but could not be read back",
      })
    }
    const config = normaliseConfig(row.config)
    return {
      apiKey: {
        id: row.id.toString(),
        name: row.name,
        key: created.key,
        keyPrefix: row.keyPrefix,
        scopes: config.scopes,
        agents: config.agents ?? [],
        createdAt: row.createdAt.toISOString(),
        expiresAt: resolveExpiresAt(config, row.createdAt),
      },
    }
  }),
)

router.delete("/:keyId", (c) =>
  handle(c, async () => {
    const keyId = Number.parseInt(c.req.param("keyId"), 10)
    if (!Number.isInteger(keyId) || keyId <= 0) {
      throw new HTTPException(400, { message: "Invalid key id" })
    }
    const auth = await authOf(c)
    const deleted = await db
      .delete(apiKeys)
      .where(
        and(
          eq(apiKeys.id, keyId),
          eq(apiKeys.userId, auth.userExternalId),
          eq(apiKeys.workspaceId, auth.workspaceExternalId),
        ),
      )
      .returning({ id: apiKeys.id })
    if (deleted.length === 0) {
      throw new HTTPException(404, { message: "API key not found" })
    }
    return { ok: true }
  }),
)

export default router
