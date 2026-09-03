// HTTP adapter for AgentsService. Routes gated by the parent app's `/v2/*`
// AuthMiddleware (JWT cookie); per-resource permission enforced in the service.

import { Hono, type Context, type Next } from "hono"
import { HTTPException } from "hono/http-exception"
import { streamSSE } from "hono/streaming"
import { z } from "zod"

import {
  AgentNotFoundOrForbiddenError,
  AgentsService,
  OwnerUserOverlapError,
  UpdateHasNoFieldsError,
  UserOrWorkspaceNotFoundError,
  createAgentSchema,
  listAgentsQuerySchema,
  searchWorkspaceUsers,
  updateAgentSchema,
  type Auth,
} from "../services/agents"
import { NoSilentLossError } from "@/platform/db/acl-propagation"
import {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_SYSTEM_PROMPT_MAIN,
  DEFAULT_SYSTEM_PROMPT_SUBAGENTS,
  DEFAULT_SYSTEM_PROMPT_TOOLS,
} from "../agent/pi-mono/system-prompt"
import { TOOL_REGISTRY } from "../agent/pi-mono/tools/registry"
import {
  ExtractorAgentNotFoundError,
  MissingResponseSchemaError,
  NotAnExtractorError,
  runExtractBatch,
} from "../agent/extractor/extract"
import { agentDeps } from "../agent/wiring"
import subAgentsRouter from "./subAgents"

type Vars = {
  jwtPayload: { sub: string; workspaceId: string; role: string }
}

const router = new Hono<{ Variables: Vars }>()
const service = new AgentsService()

const authOf = (c: Context<{ Variables: Vars }>): Auth => {
  const p = c.get("jwtPayload")
  return { email: p.sub, workspaceExternalId: p.workspaceId }
}

/** The workspace default agent drives every un-scoped chat turn for all members,
 *  so only a workspace admin (SuperAdmin) may mutate it. Mirrors admin.ts's
 *  AdminMiddleware; applied to PUT /default only (reads stay open). */
const requireSuperAdmin = async (
  c: Context<{ Variables: Vars }>,
  next: Next,
): Promise<void> => {
  if (c.get("jwtPayload").role !== "SuperAdmin") {
    throw new HTTPException(403, { message: "SuperAdmin access required" })
  }
  await next()
}

/** Single error→HTTP mapping point. Unrecognised errors propagate as 500. */
const handle = async (
  c: Context,
  fn: () => Promise<Response | object>,
): Promise<Response> => {
  try {
    const result = await fn()
    return result instanceof Response ? result : c.json(result)
  } catch (err) {
    if (err instanceof UserOrWorkspaceNotFoundError) {
      throw new HTTPException(404, { message: "User or workspace not found" })
    }
    if (err instanceof AgentNotFoundOrForbiddenError) {
      throw new HTTPException(404, {
        message: "Agent not found or access denied",
      })
    }
    if (err instanceof ExtractorAgentNotFoundError) {
      throw new HTTPException(404, {
        message: "Extractor not found or access denied",
      })
    }
    if (err instanceof NotAnExtractorError) {
      throw new HTTPException(400, {
        message: "This agent is not an extractor",
      })
    }
    if (err instanceof MissingResponseSchemaError) {
      throw new HTTPException(400, {
        message: "Extractor has no response schema configured",
      })
    }
    if (err instanceof OwnerUserOverlapError) {
      return c.json(
        {
          message: "Users cannot be both owners and regular users",
          conflictingEmails: err.conflictingEmails,
        },
        400,
      )
    }
    if (err instanceof NoSilentLossError) {
      return c.json(
        {
          message:
            "Removing this owner would drop referenced knowledge base collections from the agent. Reassign them to a remaining owner, or remove them from the agent, before removing this owner.",
          atRiskCollectionIds: err.atRiskCollectionIds,
          agentExternalId: err.agentExternalId,
        },
        409,
      )
    }
    if (err instanceof UpdateHasNoFieldsError) {
      throw new HTTPException(400, { message: "No fields to update" })
    }
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

// GET /v2/agents/defaults — default system prompt for the agent form, split
// into the three editable sections. `prompt` kept for v1 AgentForm back-compat
// (= assembled prompt, no overrides/sub-agents). Before /:agentExternalId to
// avoid path collision.
router.get("/defaults", (c) =>
  c.json({
    prompt: DEFAULT_SYSTEM_PROMPT,
    sections: {
      main: DEFAULT_SYSTEM_PROMPT_MAIN,
      tools: DEFAULT_SYSTEM_PROMPT_TOOLS,
      subagents: DEFAULT_SYSTEM_PROMPT_SUBAGENTS,
    },
  }),
)

// GET /v2/agents/tools — registry catalog for the agent form's tool picker.
// Before /:agentExternalId to avoid path collision.
router.get("/tools", (c) =>
  c.json({
    tools: TOOL_REGISTRY.map((t) => ({
      name: t.name,
      label: t.label,
      description: t.description,
      category: t.category,
    })),
  }),
)

// GET /v2/agents/default — workspace-wide default agent, auto-created on first
// read (unique partial index handles concurrent inserts).
router.get("/default", (c) =>
  handle(c, async () => {
    const agent = await service.getOrCreateDefault(authOf(c))
    return agent
  }),
)

// PUT /v2/agents/default — patch the workspace default agent. Name/sharing/
// permissions are fixed for this row and stripped server-side (guard vs UI bugs).
router.put("/default", requireSuperAdmin, (c) =>
  handle(c, async () => {
    const body = await c.req.json().catch(() => ({}))
    const payload = updateAgentSchema.parse(body)
    const updated = await service.updateDefault(authOf(c), payload)
    return updated
  }),
)

// GET /v2/agents?limit=&offset=&filter=
router.get("/", (c) =>
  handle(c, async () => {
    const isExtractorRaw = c.req.query("isExtractor")
    const query = listAgentsQuerySchema.parse({
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
      filter: c.req.query("filter"),
      ...(isExtractorRaw !== undefined ? { isExtractor: isExtractorRaw } : {}),
    })
    const agents = await service.list(authOf(c), query)
    // Envelope form (v1 returns a bare array; UI tolerates both — see listAgents
    // in frontend/src/lib/api.ts) to match backendv2's convention.
    return { agents }
  }),
)

// GET /v2/agents/default/effective-prompt — assembled prompt the LLM sees with
// no agent scope. Before the param route so /default isn't captured as :agentExternalId.
router.get("/default/effective-prompt", (c) =>
  handle(c, async () => {
    const agent = await service.getOrCreateDefault(authOf(c))
    const result = await service.getEffectivePrompt(authOf(c), agent.externalId)
    return result
  }),
)

// GET /v2/agents/:agentExternalId/effective-prompt — assembled prompt the LLM
// would see for a turn under this agent.
router.get("/:agentExternalId/effective-prompt", (c) =>
  handle(c, async () => {
    const id = c.req.param("agentExternalId")
    const result = await service.getEffectivePrompt(authOf(c), id)
    return result
  }),
)

// GET /v2/agents/:agentExternalId
router.get("/:agentExternalId", (c) =>
  handle(c, async () => {
    const id = c.req.param("agentExternalId")
    const agent = await service.get(authOf(c), id)
    return agent
  }),
)

// GET /v2/agents/:agentExternalId/permissions
router.get("/:agentExternalId/permissions", (c) =>
  handle(c, async () => {
    const id = c.req.param("agentExternalId")
    const perms = await service.getPermissions(authOf(c), id)
    return perms
  }),
)

// POST /v2/agents
router.post("/", (c) =>
  handle(c, async () => {
    const body = await c.req.json().catch(() => ({}))
    const payload = createAgentSchema.parse(body)
    const created = await service.create(authOf(c), payload)
    c.status(201)
    return created
  }),
)

// PUT /v2/agents/:agentExternalId
router.put("/:agentExternalId", (c) =>
  handle(c, async () => {
    const id = c.req.param("agentExternalId")
    const body = await c.req.json().catch(() => ({}))
    const payload = updateAgentSchema.parse(body)
    const updated = await service.update(authOf(c), id, payload)
    return updated
  }),
)

// DELETE /v2/agents/:agentExternalId
router.delete("/:agentExternalId", (c) =>
  handle(c, async () => {
    const id = c.req.param("agentExternalId")
    const deleted = await service.remove(authOf(c), id)
    // Match v1's response envelope for UI back-compat.
    return { message: "Agent deleted successfully", agent: deleted }
  }),
)

// POST /v2/agents/:agentExternalId/extract — programmatic extractor. Runs the
// agent's pi-mono loop, validates JSON against responseSchema, re-prompts up to
// extractorMaxRetries.
const extractInputSchema = z.object({
  input: z.string().min(1),
  maxRetries: z.number().int().min(0).max(10).optional(),
  modelLabel: z.string().optional(),
  thinkingLevel: z
    .enum(["minimal", "low", "medium", "high"])
    .optional(),
  debug: z.boolean().optional(),
  debugVerbosity: z.enum(["summary", "detailed"]).optional(),
})

router.post("/:agentExternalId/extract", (c) =>
  handle(c, async () => {
    const id = c.req.param("agentExternalId")
    const body = await c.req.json().catch(() => ({}))
    const payload = extractInputSchema.parse(body)
    const auth = authOf(c)
    const batch = await runExtractBatch(
      agentDeps(),
      { email: auth.email, workspaceExternalId: auth.workspaceExternalId },
      id,
      {
        input: payload.input,
        ...(payload.maxRetries !== undefined
          ? { maxRetries: payload.maxRetries }
          : {}),
        ...(payload.modelLabel ? { modelLabel: payload.modelLabel } : {}),
        ...(payload.thinkingLevel
          ? { thinkingLevel: payload.thinkingLevel }
          : {}),
        ...(payload.debug !== undefined ? { debug: payload.debug } : {}),
        ...(payload.debugVerbosity
          ? { debugVerbosity: payload.debugVerbosity }
          : {}),
      },
    )
    // 422 only when every item failed (mixed batches stay 200, per-item `ok`).
    if (batch.items.length > 0 && batch.items.every((i) => !i.ok)) {
      c.status(422)
    }
    return batch
  }),
)

// Streaming variant of /extract — emits each DebugEvent as an SSE frame, then a
// final `result` frame. The UI subscribes here to drive the chat DebugPanel live.
router.post("/:agentExternalId/extract/stream", (c) => {
  return streamSSE(c, async (stream) => {
    let payload: z.infer<typeof extractInputSchema>
    try {
      const body = await c.req.json().catch(() => ({}))
      payload = extractInputSchema.parse(body)
    } catch (err) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({
          message: err instanceof Error ? err.message : String(err),
        }),
      })
      return
    }

    const id = c.req.param("agentExternalId")
    const auth = authOf(c)
    await stream.writeSSE({ event: "ready", data: "" })

    const writeFrame = (event: string, data: unknown): void => {
      stream
        .writeSSE({ event, data: JSON.stringify(data) })
        .catch(() => {
          /* client may have closed */
        })
    }
    try {
      const batch = await runExtractBatch(
        agentDeps(),
        { email: auth.email, workspaceExternalId: auth.workspaceExternalId },
        id,
        {
          input: payload.input,
          ...(payload.maxRetries !== undefined
            ? { maxRetries: payload.maxRetries }
            : {}),
          ...(payload.modelLabel ? { modelLabel: payload.modelLabel } : {}),
          ...(payload.thinkingLevel
            ? { thinkingLevel: payload.thinkingLevel }
            : {}),
          ...(payload.debug !== undefined ? { debug: payload.debug } : {}),
          ...(payload.debugVerbosity
            ? { debugVerbosity: payload.debugVerbosity }
            : {}),
        },
        c.req.raw.signal,
        (event): void => writeFrame("debug_event", event),
        (ev): void => writeFrame(ev.kind, ev),
      )
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({ count: batch.items.length, items: batch.items }),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message: msg }),
      })
    }
  })
})

// Sub-agents CRUD nested under the parent agent; sub-router reads the parent id
// from c.req.param("agentExternalId").
router.route("/:agentExternalId/sub-agents", subAgentsRouter)

// Workspace user search for the agent form's viewer/owner pickers. Mounted at
// /v2/users/search alongside the agents router by server.ts.
export const usersRouter = new Hono<{ Variables: Vars }>()

usersRouter.get("/search", (c) =>
  handle(c, async () => {
    const q = (c.req.query("q") ?? "").trim()
    const limit = Math.max(
      1,
      Math.min(Number.parseInt(c.req.query("limit") ?? "10", 10) || 10, 100),
    )
    if (!q) return { users: [] }
    const users = await searchWorkspaceUsers(authOf(c), q, limit)
    return { users }
  }),
)

export default router
