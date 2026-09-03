// Thin, transport-agnostic wrapper over the MCP SDK client: connect (with a
// hard timeout), list tools, and proxy a tool call to text. All transport
// specifics come from the registry (transports.ts).

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { McpType } from "@/platform/db/schema/mcps"
import { TRANSPORTS, isSupportedMcpType } from "./transports"
import type { McpToolInfo, McpToolResult } from "./types"

const CLIENT_INFO = { name: "xyne", version: "1.0.0" }
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000

/** Any failure connecting to / talking with an MCP server. */
export class McpConnectionError extends Error {
  public override readonly name = "McpConnectionError"
}

const withTimeout = async <T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new McpConnectionError(`${label} timed out after ${ms}ms`)),
      ms,
    )
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Connect to an MCP server. `rawConfig` is validated against the transport's
 *  schema, so a malformed config throws before any network call. */
export const connectMcp = async (
  type: string,
  rawConfig: unknown,
  opts?: { timeoutMs?: number },
): Promise<Client> => {
  if (!isSupportedMcpType(type)) {
    throw new McpConnectionError(`Unsupported MCP type: ${type}`)
  }
  const def = TRANSPORTS[type as McpType]
  const config = def.parseConfig(rawConfig)
  const client = new Client(CLIENT_INFO)
  await withTimeout(
    client.connect(def.build(config)),
    opts?.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    "MCP connect",
  )
  return client
}

export const listMcpTools = async (client: Client): Promise<McpToolInfo[]> => {
  const { tools } = await client.listTools()
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
  }))
}

export const callMcpTool = async (
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> => {
  const res = await client.callTool({ name, arguments: args })
  const content = Array.isArray(res.content) ? res.content : []
  const text = content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text")
    .map((c) => c.text)
    .join("\n")
  return { text, isError: Boolean(res.isError) }
}
