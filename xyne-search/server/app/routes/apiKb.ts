import { Hono, type Context, type Next } from "hono"

import {
  apiKeyAuthMiddleware,
  type ApiKeyAuthContext,
} from "../services/apiKeyAuth"
import type { KbRouteVars } from "../services/knowledgeBaseAccess"
import { kbGetItemHandler, kbUploadHandler } from "./knowledgeBase"

type ApiKbVars = KbRouteVars & { apiKeyAuth: ApiKeyAuthContext }

const router = new Hono<{ Variables: ApiKbVars }>()

router.use("*", apiKeyAuthMiddleware)

router.use("*", async (c: Context<{ Variables: ApiKbVars }>, next: Next) => {
  const auth = c.get("apiKeyAuth")
  c.set("jwtPayload", {
    sub: auth.email,
    workspaceId: auth.workspaceExternalId,
  })
  await next()
})

router.post("/collections/:clId/upload", kbUploadHandler)
router.get("/collections/:clId/items/:itemId", kbGetItemHandler)

export default router
