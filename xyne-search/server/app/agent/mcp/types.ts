// Shared MCP types. Kept transport-agnostic so the client/loader never reason
// about a specific transport — that lives entirely in transports.ts.

/** One tool advertised by an MCP server (from `tools/list`). */
export type McpToolInfo = {
  name: string
  description: string
  /** Raw JSON Schema for the tool's arguments (passed through to the agent). */
  inputSchema: Record<string, unknown>
}

/** Result of proxying a `tools/call` to an MCP server, flattened to text. */
export type McpToolResult = {
  text: string
  isError: boolean
}
