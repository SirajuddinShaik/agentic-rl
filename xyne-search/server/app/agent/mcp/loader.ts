// Turns an agent's attached MCP servers into callable pi-mono tools. Each MCP
// tool is registered as a first-class tool (self-describing name + JSON-schema
// params), so the model sees it natively — no system-prompt catalog needed.
//
// Connections are cached per (conversation, mcp) and reused across tool calls
// and turns, then evicted after an idle window. Fail-soft: an unreachable server
// is logged and skipped, never crashing the turn.

import { defineTool } from "@earendil-works/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"

import type { McpScopeEntry } from "../agent-scope"
import type { ToolBuildCtx } from "../pi-mono/tools/registry"
import { connectMcp, listMcpTools, callMcpTool } from "./client"

type CachedClient = { client: Client; lastUsed: number }
const CLIENT_CACHE = new Map<string, CachedClient>()
const IDLE_TTL_MS = 10 * 60_000
const MAX_CLIENTS = 100

const cacheKey = (conversationId: string, mcpId: string): string =>
  `${conversationId}::${mcpId}`

const evictStale = (): void => {
  const now = Date.now()
  for (const [key, entry] of CLIENT_CACHE) {
    if (now - entry.lastUsed > IDLE_TTL_MS) {
      void entry.client.close().catch(() => {})
      CLIENT_CACHE.delete(key)
    }
  }
}

const getClient = async (
  conversationId: string,
  mcp: McpScopeEntry,
): Promise<Client> => {
  const key = cacheKey(conversationId, mcp.id)
  const hit = CLIENT_CACHE.get(key)
  if (hit && Date.now() - hit.lastUsed < IDLE_TTL_MS) {
    hit.lastUsed = Date.now()
    return hit.client
  }
  if (hit) {
    void hit.client.close().catch(() => {})
    CLIENT_CACHE.delete(key)
  }
  if (CLIENT_CACHE.size >= MAX_CLIENTS) evictStale()
  const client = await connectMcp(mcp.type, mcp.config)
  CLIENT_CACHE.set(key, { client, lastUsed: Date.now() })
  return client
}

// LLM tool names must be short and [A-Za-z0-9_-]. Prefix keeps MCP tools from
// colliding with built-ins and each other.
const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24) || "mcp"

const toToolName = (mcpName: string, tool: string): string =>
  `mcp__${slug(mcpName)}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)

type McpToolDetails = { mcp: string; tool: string; error?: string }

/** Connect to each of the agent's MCP servers, discover their tools, and wrap
 *  each as a pi-mono tool that proxies calls back to the server. */
export const buildMcpToolsForRun = async (
  mcpEntries: readonly McpScopeEntry[],
  ctx: ToolBuildCtx,
): Promise<ReturnType<typeof defineTool>[]> => {
  const tools: ReturnType<typeof defineTool>[] = []
  const usedNames = new Set<string>()

  for (const mcp of mcpEntries) {
    let discovered
    try {
      const client = await getClient(ctx.conversationId, mcp)
      discovered = await listMcpTools(client)
    } catch (err) {
      ctx.logger.warn(
        {
          mcp: mcp.name,
          err: err instanceof Error ? err.message : String(err),
        },
        "mcp: server unreachable, skipping its tools",
      )
      continue
    }

    for (const tool of discovered) {
      let name = toToolName(mcp.name, tool.name)
      while (usedNames.has(name)) name = `${name.slice(0, 61)}_${usedNames.size % 100}`
      usedNames.add(name)

      const paramsSchema = Type.Unsafe<Record<string, unknown>>(tool.inputSchema)
      const originalTool = tool.name
      const server = mcp

      tools.push(
        defineTool<typeof paramsSchema, McpToolDetails>({
          name,
          label: `${mcp.name}: ${tool.name}`,
          description:
            tool.description || `Tool "${tool.name}" from MCP "${mcp.name}".`,
          parameters: paramsSchema,
          async execute(_toolCallId, params) {
            try {
              const client = await getClient(ctx.conversationId, server)
              const res = await callMcpTool(
                client,
                originalTool,
                (params ?? {}) as Record<string, unknown>,
              )
              return {
                content: [
                  { type: "text" as const, text: res.text || "(no output)" },
                ],
                details: { mcp: server.name, tool: originalTool },
                isError: res.isError,
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `MCP tool "${originalTool}" failed: ${message}`,
                  },
                ],
                details: { mcp: server.name, tool: originalTool, error: message },
                isError: true,
              }
            }
          },
        }),
      )
    }
  }
  return tools
}
