// HTTP adapter for SkillsService (mounted at /v2/skills): zod validation +
// error→HTTP mapping. Permission logic lives in the service.

import { Hono, type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"

import {
  AgentNotFoundOrForbiddenError,
  UpdateHasNoFieldsError,
  UserOrWorkspaceNotFoundError,
  type Auth,
} from "../services/agents"
import {
  SkillAliasTakenError,
  SkillAlreadyMappedError,
  SkillForbiddenError,
  SkillMappingNotFoundError,
  SkillNotFoundError,
  SkillsService,
  createSkillSchema,
  updateSkillSchema,
} from "../services/skills"

type Vars = {
  jwtPayload: { sub: string; workspaceId: string }
}

const router = new Hono<{ Variables: Vars }>()
const service = new SkillsService()

const authOf = (c: Context<{ Variables: Vars }>): Auth => {
  const p = c.get("jwtPayload")
  return { email: p.sub, workspaceExternalId: p.workspaceId }
}

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
    if (err instanceof SkillNotFoundError) {
      throw new HTTPException(404, { message: "Skill not found" })
    }
    if (err instanceof AgentNotFoundOrForbiddenError) {
      throw new HTTPException(404, {
        message: "Agent not found or access denied",
      })
    }
    if (err instanceof SkillForbiddenError) {
      throw new HTTPException(403, {
        message: "Only the creator can modify this skill",
      })
    }
    if (err instanceof SkillAliasTakenError) {
      return c.json(
        { message: `Alias "${err.alias}" is already taken` },
        409,
      )
    }
    if (err instanceof SkillAlreadyMappedError) {
      return c.json(
        { message: "Skill is already mapped to this agent" },
        409,
      )
    }
    if (err instanceof SkillMappingNotFoundError) {
      throw new HTTPException(404, {
        message: "Skill is not mapped to this agent",
      })
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

const idOf = (c: Context): string => c.req.param("id") ?? ""
const agentIdOf = (c: Context): string => c.req.param("agentExternalId") ?? ""

router.get("/", (c) =>
  handle(c, async () => {
    const items = await service.list(authOf(c))
    return { skills: items }
  }),
)

router.post("/", (c) =>
  handle(c, async () => {
    const body = await c.req.json().catch(() => ({}))
    const payload = createSkillSchema.parse(body)
    const created = await service.create(authOf(c), payload)
    c.status(201)
    return created
  }),
)

// Declared before /:id so "agents" isn't captured by the :id param.
router.get("/agents/:agentExternalId", (c) =>
  handle(c, async () => {
    const items = await service.listForAgent(authOf(c), agentIdOf(c))
    return { skills: items }
  }),
)

router.get("/:id", (c) =>
  handle(c, async () => service.get(authOf(c), idOf(c))),
)

router.patch("/:id", (c) =>
  handle(c, async () => {
    const body = await c.req.json().catch(() => ({}))
    const payload = updateSkillSchema.parse(body)
    return service.update(authOf(c), idOf(c), payload)
  }),
)

router.delete("/:id", (c) =>
  handle(c, async () => {
    const deleted = await service.remove(authOf(c), idOf(c))
    return { message: "Skill deleted successfully", skill: deleted }
  }),
)

router.post("/:id/agents/:agentExternalId", (c) =>
  handle(c, async () => {
    const mapped = await service.mapToAgent(authOf(c), idOf(c), agentIdOf(c))
    c.status(201)
    return { message: "Skill mapped to agent", ...mapped }
  }),
)

router.delete("/:id/agents/:agentExternalId", (c) =>
  handle(c, async () => {
    const unmapped = await service.unmapFromAgent(
      authOf(c),
      idOf(c),
      agentIdOf(c),
    )
    return { message: "Skill unmapped from agent", ...unmapped }
  }),
)

export default router
