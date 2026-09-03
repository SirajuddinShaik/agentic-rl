import { Hono, type Context, type Next } from "hono"
import { getCookie } from "hono/cookie"
import { logger as honoLogger } from "hono/logger"
import { HTTPException } from "hono/http-exception"
import { createHash, timingSafeEqual } from "node:crypto"

import { db } from "@/platform/db/client"
import {
  getPublicUserAndWorkspaceByEmail,
  saveRefreshTokenToDB,
} from "@/platform/db/user"
import { getLogger } from "@/platform/logger"
import { Subsystem } from "@/types"
import config from "@/config"
import { getAvailableModels } from "@/platform/ai/fetchModels"

import keycloakRouter from "./auth/keycloak"
import {
  googleAuthMiddleware,
  googleCallback,
  isGoogleWebLoginEnabled,
} from "./auth/google"
import chatRouter from "./agent/routes/chat"
import kbRouter from "./routes/knowledgeBase"
import agentsRouter, { usersRouter } from "./routes/agents"
import skillsRouter from "./routes/skills"
import mcpsRouter from "./routes/mcps"
import adminRouter from "./routes/admin"
import apiV2Router from "./routes/api"
import apiKeysRouter from "./routes/apiKeys"
import apiKbRouter from "./routes/apiKb"
import { reconcileRunningOnBoot } from "./agent/storage/postgres"
import { initApiServerQueue } from "@/platform/queue/api-server-queue"
import { workflowRouter, workflowPublicRouter } from "./workflows/router"
import { initWorkflowWorkers } from "./workflows/runtime"
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  clearSessionCookies,
  setSessionCookies,
} from "./lib/cookies"
import {
  type JwtPayload,
  generateAccessToken,
  generateRefreshToken,
  verifyAccess,
  verifyRefresh,
} from "./lib/tokens"
import metricRegister from "@/platform/metrics/sharedRegistry"

type Variables = { jwtPayload: JwtPayload }

const Logger = getLogger(Subsystem.Api).child({ module: "backendv2" })

// Must match the callback host registered in the Google/Keycloak client config.
const PORT = Number(process.env["BACKENDV2_PORT"] ?? 3000)
const DEFAULT_IDLE_TIMEOUT_SECONDS = 240
const MAX_IDLE_TIMEOUT_SECONDS = 3600
const configuredIdleTimeoutSeconds = Number(
  process.env["BACKENDV2_IDLE_TIMEOUT_SECONDS"],
)
const IDLE_TIMEOUT_SECONDS =
  Number.isFinite(configuredIdleTimeoutSeconds) &&
  configuredIdleTimeoutSeconds >= 0
    ? Math.min(configuredIdleTimeoutSeconds, MAX_IDLE_TIMEOUT_SECONDS)
    : DEFAULT_IDLE_TIMEOUT_SECONDS
const AGENT_CHAT_API_PREFIX = "/api/v2/agents/chat"

const app = new Hono<{ Variables: Variables }>()
app.use("*", honoLogger())

const tryRefresh = async (c: Context): Promise<JwtPayload | null> => {
  const refreshToken = getCookie(c, REFRESH_COOKIE)
  if (!refreshToken) {
    return null
  }
  let decoded: JwtPayload
  try {
    decoded = await verifyRefresh(refreshToken)
  } catch (err) {
    Logger.warn({ err }, "refresh: invalid signature")
    return null
  }
  const email = decoded.sub
  const workspaceId = decoded.workspaceId
  if (!email || !workspaceId) {
    return null
  }
  const uw = await getPublicUserAndWorkspaceByEmail(db, workspaceId, email)
  const existingUser = uw?.user
  const existingWorkspace = uw?.workspace
  if (!existingUser || !existingWorkspace) {
    Logger.warn({ email }, "refresh: user/workspace not found")
    return null
  }
  if (existingUser.refreshToken !== refreshToken) {
    Logger.warn({ email }, "refresh: token mismatch with DB")
    return null
  }
  const newAccess = await generateAccessToken(
    existingUser.email,
    existingUser.role,
    existingUser.workspaceExternalId,
    decoded.authProvider,
  )
  const newRefresh = await generateRefreshToken(
    existingUser.email,
    existingUser.role,
    existingUser.workspaceExternalId,
    decoded.authProvider,
  )
  await saveRefreshTokenToDB(db, existingUser.email, newRefresh)
  setSessionCookies(c, newAccess, newRefresh)

  return {
    sub: existingUser.email,
    role: existingUser.role,
    workspaceId: existingUser.workspaceExternalId,
    tokenType: "access",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...(decoded.authProvider ? { authProvider: decoded.authProvider } : {}),
  }
}

const AuthMiddleware = async (c: Context, next: Next): Promise<void> => {
  const access = getCookie(c, ACCESS_COOKIE)
  if (access) {
    try {
      const decoded = await verifyAccess(access)
      c.set("jwtPayload", decoded)
      await next()
      return
    } catch (err) {
      Logger.debug({ err }, "access invalid; trying refresh")
    }
  }
  const refreshed = await tryRefresh(c)
  if (!refreshed) {
    clearSessionCookies(c)
    throw new HTTPException(401, { message: "Unauthorized" })
  }
  c.set("jwtPayload", refreshed)
  await next()
}

// ── Public routes ─────────────────────────────────────────────────────────
app.get("/v2/health", (c) => c.json({ ok: true, service: "backendv2" }))
// The GCP HTTPS LB probes bare /health and marks the backend healthy on 2xx.
app.get("/health", (c) => c.json({ ok: true, service: "backendv2" }))

app.post("/v2/refresh-token", async (c) => {
  const refreshed = await tryRefresh(c)
  if (!refreshed) {
    clearSessionCookies(c)
    throw new HTTPException(401, { message: "Refresh failed" })
  }
  return c.json({ msg: "Tokens refreshed", email: refreshed.sub })
})

app.post("/v2/logout", (c) => {
  clearSessionCookies(c)
  return c.json({ ok: true })
})

// Constant-time bearer check for /metrics. Hash both sides to a fixed 32-byte
// digest so timingSafeEqual never sees mismatched lengths (which would throw).
const metricsTokenOk = (c: Context): boolean => {
  const auth = c.req.header("authorization") ?? ""
  const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : ""
  if (!provided) return false
  const a = createHash("sha256").update(provided).digest()
  const b = createHash("sha256").update(config.metricsAuthToken).digest()
  return timingSafeEqual(a, b)
}

// /metrics exposes the full Prometheus registry (internal counters, route labels,
// cardinality) — a recon surface. Secure by default: it is served ONLY when
// METRICS_AUTH_TOKEN is configured, and then only to a caller presenting that
// bearer token. With no token set the endpoint is disabled (404), never exposed
// to unauthenticated callers.
if (!config.metricsAuthToken) {
  Logger.warn(
    "/metrics is disabled: set METRICS_AUTH_TOKEN to enable authenticated scraping",
  )
}
app.get("/metrics", async (c) => {
  if (!config.metricsAuthToken) {
    throw new HTTPException(404, { message: "Not found" })
  }
  if (!metricsTokenOk(c)) {
    throw new HTTPException(401, { message: "Unauthorized" })
  }
  c.header("Content-Type", metricRegister.contentType)
  return c.body(await metricRegister.metrics())
})

// ── OAuth (paths must match the URIs registered in GCP / Keycloak) ─────
// Single Google endpoint: initiates if no `code`, completes if present.
app.get("/v1/auth/callback", googleAuthMiddleware, googleCallback)
app.get("/v1/auth/google/start", (c) =>
  isGoogleWebLoginEnabled()
    ? c.redirect("/v1/auth/callback")
    : c.redirect("/signin?error=provider_disabled"),
)

app.route("/v1/auth/keycloak", keycloakRouter)

app.route("/", workflowPublicRouter)
app.route("/api/v2/kb", apiKbRouter)
app.route("/api/v2", apiV2Router)

// ── Protected routes ──────────────────────────────────────────────────────
app.use("/v2/*", AuthMiddleware)

app.route("/v2/chat", chatRouter)
app.route("/v2/kb", kbRouter)
app.route("/v2/agents", agentsRouter)
app.route("/v2/skills", skillsRouter)
app.route("/v2/mcps", mcpsRouter)
app.route("/v2/users", usersRouter)
app.route("/v2/api-keys", apiKeysRouter)
app.route("/v2/admin", adminRouter)
app.route("/v2", workflowRouter)

app.get("/v2/me", (c) => {
  const p = c.get("jwtPayload")
  return c.json({
    email: p.sub,
    role: p.role,
    workspaceId: p.workspaceId,
    tokenType: p.tokenType,
  })
})

// LLM catalog for the composer's model picker; mirrors xyne's /api/v1/chat/models.
app.get("/v2/models", async (c) => {
  try {
    const models = await getAvailableModels({
      AwsAccessKey: config.AwsAccessKey,
      AwsSecretKey: config.AwsSecretKey,
      OpenAIKey: config.OpenAIKey,
      OllamaModel: config.OllamaModel,
      TogetherAIModel: config.TogetherAIModel,
      TogetherApiKey: config.TogetherApiKey,
      FireworksAIModel: config.FireworksAIModel,
      FireworksApiKey: config.FireworksApiKey,
      GeminiAIModel: config.GeminiAIModel,
      GeminiApiKey: config.GeminiApiKey,
      VertexAIModel: config.VertexAIModel,
      VertexProjectId: config.VertexProjectId,
      VertexRegion: config.VertexRegion,
      LiteLLMApiKey: config.LiteLLMApiKey,
      LiteLLMBaseUrl: config.LiteLLMBaseUrl,
    })
    // Strip actualName / provider before returning.
    const filtered = models.map((m) => ({
      labelName: m.labelName,
      reasoning: m.reasoning,
      websearch: m.websearch,
      deepResearch: m.deepResearch,
      description: m.description,
    }))
    return c.json({ models: filtered })
  } catch (err) {
    Logger.error({ err }, "/v2/models failed")
    throw new HTTPException(500, { message: "Could not fetch models" })
  }
})

// ── Static SPA (frontend build output) ─────────────────────────────────────────
// Prod serves frontend's built assets from this process (single container/port).
// Path is relative to the server cwd at runtime; the Docker image copies
// frontend/dist to server/frontend-dist. In dev, vite serves frontend on :5176
// and proxies /v2/* + /v1/auth/* here, so these static handlers never fire.
const SPA_DIST = process.env["FRONTEND_DIST_DIR"] ?? "./frontend-dist"
// Served via Bun.file rather than hono/bun serveStatic, which mishandles
// absolute `path` in some releases.
const mime = (p: string): string => {
  if (p.endsWith(".html")) return "text/html; charset=utf-8"
  if (p.endsWith(".js") || p.endsWith(".mjs"))
    return "application/javascript; charset=utf-8"
  if (p.endsWith(".css")) return "text/css; charset=utf-8"
  if (p.endsWith(".svg")) return "image/svg+xml"
  if (p.endsWith(".png")) return "image/png"
  if (p.endsWith(".ico")) return "image/x-icon"
  if (p.endsWith(".json")) return "application/json"
  if (p.endsWith(".woff2")) return "font/woff2"
  if (p.endsWith(".woff")) return "font/woff"
  return "application/octet-stream"
}

const serveSpaFile = async (
  c: Context,
  filePath: string,
): Promise<Response> => {
  const file = Bun.file(filePath)
  if (!(await file.exists())) {
    return c.notFound()
  }
  const headers = new Headers()
  headers.set("Content-Type", mime(filePath))
  return new Response(file, {
    headers,
  })
}

app.get("/assets/*", async (c) => {
  // Reject '..' to prevent escaping the dist root via path traversal.
  const rel = c.req.path.replace(/^\//, "")
  if (rel.includes("..")) {
    return c.notFound()
  }
  return serveSpaFile(c, `${SPA_DIST}/${rel.replace(/^assets\//, "assets/")}`)
})
app.get("/favicon.ico", (c) => serveSpaFile(c, `${SPA_DIST}/favicon.ico`))
app.get("/favicon.svg", (c) => serveSpaFile(c, `${SPA_DIST}/favicon.svg`))
app.get("/auth", (c) => c.redirect("/signin"))
// pdf.js worker: shipped via frontend/public/ for a stable (unhashed) name at
// the dist root, where the PDF viewer's workerSrc points.
app.get("/pdf.worker.mjs", (c) =>
  serveSpaFile(c, `${SPA_DIST}/pdf.worker.mjs`),
)
// Client-side routing fallback: unknown non-API/auth GETs serve index.html.
app.get("*", (c) => serveSpaFile(c, `${SPA_DIST}/index.html`))

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status)
  }
  Logger.error({ err }, "unhandled error")
  return c.json({ error: "internal_error" }, 500)
})

Logger.info(`backendv2 listening on port ${PORT}`)

initApiServerQueue().catch((err) => {
  Logger.error(
    { err: err instanceof Error ? err : String(err) },
    "Failed to init pg-boss queue for backendv2",
  )
})

initWorkflowWorkers().catch((err) => {
  Logger.error(
    { err: err instanceof Error ? err : String(err) },
    "Failed to init workflow workers",
  )
})

// Sweep turns/runs left `running` by a previous process (postgres driver only;
// memory state is already gone on restart).
if ((process.env["AGENT_STORAGE"] ?? "postgres") === "postgres") {
  reconcileRunningOnBoot()
    .then(({ turns, runs }) => {
      if (turns > 0 || runs > 0) {
        Logger.warn({ turns, runs }, "reconciled stale running turns/runs")
      }
    })
    .catch((err) => {
      Logger.error(
        { err: err instanceof Error ? err : String(err) },
        "boot reconcile failed",
      )
    })
}

export default {
  port: PORT,
  fetch(
    request: Request,
    server: Bun.Server<undefined>,
  ): Response | Promise<Response> {
    const { pathname } = new URL(request.url)
    if (
      pathname === AGENT_CHAT_API_PREFIX ||
      pathname.startsWith(`${AGENT_CHAT_API_PREFIX}/`)
    ) {
      server.timeout(request, 0)
    }
    return app.fetch(request)
  },
  idleTimeout: Math.min(IDLE_TIMEOUT_SECONDS, 255),
}
