import { eq } from "drizzle-orm"
import { type Context, type Next } from "hono"
import { HTTPException } from "hono/http-exception"

import { db } from "@/platform/db/client"
import { apiKeys, users } from "@/platform/db/schema"
import { getApiKeyExpiresAtFrom } from "@/platform/db/user"
import { ApiKeyScopes } from "@/platform/shared/types"

export type ApiKeyAuthConfig = {
  scopes: string[]
  agents?: string[]
  expiresAt?: string
  neverExpires?: boolean
}

export type ApiKeyAuthContext = {
  apiKey: string
  email: string
  userExternalId: string
  workspaceExternalId: string
  config: ApiKeyAuthConfig
}

const normaliseConfig = (raw: unknown): ApiKeyAuthConfig => {
  const config =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  const scopes = Array.isArray(config["scopes"])
    ? config["scopes"].filter((scope): scope is string => typeof scope === "string")
    : []
  const agents = Array.isArray(config["agents"])
    ? config["agents"].filter((agent): agent is string => typeof agent === "string")
    : undefined
  const expiresAt =
    typeof config["expiresAt"] === "string" ? config["expiresAt"] : undefined
  const neverExpires = config["neverExpires"] === true
  return {
    scopes,
    ...(agents ? { agents } : {}),
    ...(neverExpires ? { neverExpires } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  }
}

const resolveExpiresAt = (
  config: ApiKeyAuthConfig,
  createdAt: Date,
): Date | null => {
  if (config.neverExpires) {
    return null
  }
  if (config.expiresAt) {
    const date = new Date(config.expiresAt)
    if (!Number.isNaN(date.getTime())) {
      return date
    }
  }
  return getApiKeyExpiresAtFrom(createdAt)
}

export const apiKeyAuthMiddleware = async (
  c: Context<{ Variables: { apiKeyAuth: ApiKeyAuthContext } }>,
  next: Next,
): Promise<void> => {
  const apiKey = c.req.header("x-api-key")
  if (!apiKey) {
    throw new HTTPException(401, { message: "Missing API key" })
  }

  const auth = await resolveApiKeyAuth(apiKey, { requireAgentChatScope: true })
  c.set("apiKeyAuth", auth)
  await next()
}

export const resolveApiKeyAuth = async (
  apiKey: string,
  opts: { requireAgentChatScope?: boolean } = {},
): Promise<ApiKeyAuthContext> => {
  const [foundApiKey] = await db
    .select({
      workspaceId: apiKeys.workspaceId,
      userId: apiKeys.userId,
      userEmail: users.email,
      config: apiKeys.config,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .leftJoin(users, eq(apiKeys.userId, users.externalId))
    .where(eq(apiKeys.key, apiKey))
    .limit(1)

  if (!foundApiKey || !foundApiKey.userEmail) {
    throw new HTTPException(401, { message: "Invalid API key" })
  }

  const keyConfig = normaliseConfig(foundApiKey.config)
  const expiresAt = resolveExpiresAt(keyConfig, foundApiKey.createdAt)
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new HTTPException(401, { message: "API key has expired" })
  }

  if (opts.requireAgentChatScope && !keyConfig.scopes.includes(ApiKeyScopes.AGENT_CHAT)) {
    throw new HTTPException(403, {
      message: "API key is missing AGENT_CHAT scope",
    })
  }

  return {
    apiKey,
    email: foundApiKey.userEmail,
    userExternalId: foundApiKey.userId,
    workspaceExternalId: foundApiKey.workspaceId,
    config: keyConfig,
  }
}

export const assertApiKeyAgentAllowed = (
  auth: ApiKeyAuthContext,
  agentId: string,
): void => {
  const allowedAgents = auth.config.agents
  if (allowedAgents && allowedAgents.length > 0 && !allowedAgents.includes(agentId)) {
    throw new HTTPException(403, {
      message: "API key is not allowed to access this agent",
    })
  }
}
