// Transport registry — the ONLY place that knows how a given MCP `type` is
// configured, connected, and how its secrets are masked/merged. Adding a
// transport (stdio, websocket) later is a pure add-on: append one entry and one
// `McpType` value — the client, service, routes, and runtime are untouched
// (open/closed).

import { z } from "zod"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { McpType } from "@/platform/db/schema/mcps"

/** Placeholder returned to clients in place of a stored secret value. */
export const SECRET_MASK = "••••••••"

/** Everything type-specific about a transport: validate config, build the SDK
 *  transport, and hide/preserve its secrets when talking to clients. */
export type TransportDef = {
  /** Validate + normalize a raw config (throws ZodError on bad input). */
  parseConfig: (raw: unknown) => unknown
  build: (config: unknown) => Transport
  /** A copy safe to return to clients — secret values replaced with SECRET_MASK. */
  maskConfig: (config: unknown) => unknown
  /** Merge a client-submitted config with the stored one, keeping any secret the
   *  client left masked. Returns the config to persist. */
  mergeConfig: (incoming: unknown, stored: unknown) => unknown
}

// ── Remote transports (Streamable HTTP + SSE) ───────────────────────────────
// Both share one config: a URL + optional static headers (e.g. Authorization),
// where header VALUES are the secrets.

const remoteConfigSchema = z.object({
  url: z.string().url().max(2048),
  headers: z.record(z.string(), z.string()).optional(),
})
type RemoteConfig = z.infer<typeof remoteConfigSchema>

const maskAll = (headers?: Record<string, string>): Record<string, string> | undefined =>
  headers
    ? Object.fromEntries(Object.keys(headers).map((k) => [k, SECRET_MASK]))
    : undefined

// A fetch that injects static headers into every request. SSE needs this so the
// auth headers reach the streaming GET, not just the POST channel.
const withHeaders =
  (headers: Record<string, string>) =>
  (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    fetch(input, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), ...headers },
    })

const remoteTransport = (
  build: (config: RemoteConfig) => Transport,
): TransportDef => ({
  parseConfig: (raw) => remoteConfigSchema.parse(raw),
  build: (config) => build(config as RemoteConfig),
  maskConfig: (config) => {
    const { url, headers } = config as RemoteConfig
    return { url, ...(headers ? { headers: maskAll(headers) } : {}) }
  },
  mergeConfig: (incoming, stored) => {
    const next = remoteConfigSchema.parse(incoming)
    const prev = stored as RemoteConfig | undefined
    if (!next.headers) return next
    const headers = { ...next.headers }
    for (const [k, v] of Object.entries(headers)) {
      if (v === SECRET_MASK && prev?.headers?.[k] !== undefined) {
        headers[k] = prev.headers[k]
      }
    }
    return { ...next, headers }
  },
})

export const TRANSPORTS: Record<McpType, TransportDef> = {
  [McpType.StreamableHttp]: remoteTransport(
    ({ url, headers }) =>
      new StreamableHTTPClientTransport(new URL(url), {
        ...(headers ? { requestInit: { headers } } : {}),
      }) as Transport,
  ),
  [McpType.Sse]: remoteTransport(
    ({ url, headers }) =>
      new SSEClientTransport(new URL(url), {
        ...(headers
          ? { requestInit: { headers }, fetch: withHeaders(headers) }
          : {}),
      }) as Transport,
  ),
}

export const isSupportedMcpType = (type: string): type is McpType =>
  Object.prototype.hasOwnProperty.call(TRANSPORTS, type)

export const supportedMcpTypes = (): McpType[] =>
  Object.keys(TRANSPORTS) as McpType[]
