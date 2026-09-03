import type { ImageContent, Model, ThinkingLevel } from "@earendil-works/pi-ai"
import type {
  AgentSession,
  AgentSessionEvent,
  CreateAgentSessionOptions,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import type { Static, TSchema } from "@sinclair/typebox"

export interface RAGAgentConfig<TState = unknown> {
  /** Model ID string or full pi-mono Model object */
  model: string | Model<any>
  /** LiteLLM base URL (required when model is a string) */
  baseUrl?: string
  apiKey?: string
  sessionId?: string | undefined

  tools: ToolDefinition<any, any, any>[]

  systemPrompt: string
  /** Upstream became `string[]` in 0.74.x — accept either shape and normalise
   *  at the use-site so callers passing a string keep working. */
  appendSystemPrompt?: string | string[]

  sessionManager?: CreateAgentSessionOptions["sessionManager"]

  /** Controls compaction, retry, etc. */
  settingsManager?: CreateAgentSessionOptions["settingsManager"]

  extensions?: ExtensionFactory[]

  thinkingLevel?: ThinkingLevel
  /** Models available for cycling */
  scopedModels?: CreateAgentSessionOptions["scopedModels"]
  modelOptions?: {
    maxTokens?: number
    contextWindow?: number
    reasoning?: boolean
    input?: ("text" | "image")[]
    cost?: {
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
    }
  }
  /** Per-model sampler params. `temperature` goes via StreamOptions;
   *  `topP` is injected onto the final request via onPayload. */
  streamOptions?: {
    temperature?: number
    topP?: number
  }
  /** Per-turn debug sink — when set, shadows outbound requests + inbound chunks
   *  into its emit methods. Absent = no allocation. See pi-mono/debug/. */
  debug?: import("@/app/agent/pi-mono/debug/capture").DebugCapture

  authStorage?: CreateAgentSessionOptions["authStorage"]
  modelRegistry?: CreateAgentSessionOptions["modelRegistry"]

  /** When set, systemPrompt/extensions config is ignored. */
  resourceLoader?: CreateAgentSessionOptions["resourceLoader"]

  /** Application state carried through the agent lifecycle */
  state?: TState

  /** Max wait for agent completion (ms). Default: 5 minutes */
  timeoutMs?: number
}

/** A running RAG agent instance. */
export interface RAGAgent<TState = unknown> {
  /** Subscribes to events and yields them as an async iterable. */
  run(message: string, options?: RunOptions): AsyncIterable<RAGEvent>

  stop(): Promise<void>

  getSession(): AgentSession

  getState(): TState | undefined

  /** Call when done. */
  dispose(): void
}

export interface RunOptions {
  images?: ImageContent[]
  /** Timeout override for this run (ms) */
  timeoutMs?: number
}

/** Thin normalization of pi-mono's AgentSessionEvent; `raw` exposes the
 *  original event when needed. */
export type RAGEvent =
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "turn_start"; turnIndex: number }
  | { type: "turn_end"; turnIndex: number }
  | {
      type: "tool_call"
      toolName: string
      toolCallId: string
      args: unknown
    }
  | {
      type: "tool_result"
      toolName: string
      toolCallId: string
      result: unknown
      isError: boolean
    }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; delta: string; contentIndex: number }
  | { type: "thinking_end"; contentIndex: number; contentSignature?: string }
  | {
      type: "message_end"
      message: { role: string; content?: string; stopReason?: string }
    }
  | { type: "error"; error: { message: string; code?: string } }
  | { type: "raw"; event: AgentSessionEvent }

export interface SimpleToolDefinition<
  TParams extends TSchema = TSchema,
  TState = unknown,
> {
  name: string
  description: string
  parameters: TParams
  /** Optional snippet for the system prompt's "Available tools" section */
  promptSnippet?: string
  execute: (
    toolCallId: string,
    params: Static<TParams>,
    context: ToolContext<TState>,
  ) => Promise<ToolResult>
}

export interface ToolContext<TState = unknown> {
  /** The TState from RAGAgentConfig */
  state: TState
  /** Cancelled when the agent is stopped */
  signal: AbortSignal | undefined
  extensionContext: unknown
}

export interface ToolResult {
  /** Returned to the LLM */
  data: unknown
  /** For rendering/logging; NOT sent to the LLM */
  details?: unknown
  isError?: boolean
}
