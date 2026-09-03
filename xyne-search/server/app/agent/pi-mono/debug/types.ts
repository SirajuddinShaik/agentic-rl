// Debug capture event union: one event per pi-mono/provider boundary
// worth surfacing under the debug toggle. Verbosity gates emission (see
// capture.ts) but never the shape, so the UI doesn't branch on it.

// `summary` keeps just boundaries (request/response/tool/compaction/
// agent_end, no large payloads); `detailed` adds request bodies, full
// response text + usage, and tool args/results.
export type DebugVerbosity = "summary" | "detailed"

export type DebugTokenUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type DebugEvent = (
  | {
      kind: "request"
      // 1-based; the UI groups responses back to their call by this index.
      llmCall: number
      sentAt: number
      model: string
      sampler: {
        temperature?: number
        topP?: number
        maxTokens?: number
      }
      systemPromptChars: number
      // `detailed` only. Scrubbed of secrets (apiKey/Authorization/
      // cookies); shape mirrors the provider wire body so it's
      // copy-pasteable into curl reproductions.
      payload?: unknown
    }
  | {
      kind: "response"
      llmCall: number
      receivedAt: number
      stopReason?: string
      // `detailed` only; omitted when empty.
      text?: string
      thinking?: string
      tokenUsage?: DebugTokenUsage
    }
  | {
      kind: "tool_call_start"
      toolName: string
      toolCallId: string
      args: unknown
      startedAt: number
    }
  | {
      kind: "tool_call_end"
      toolName: string
      toolCallId: string
      // Local tool execution time (Vespa/IO round-trip), not LLM latency.
      durationMs: number
      isError: boolean
      // `detailed` only.
      result?: unknown
    }
  | {
      kind: "compaction_start"
      reason: string
      tokensBefore?: number
      at: number
    }
  | {
      kind: "compaction_end"
      tokensBefore?: number
      tokensAfter?: number
      // Present only on successful (non-aborted) threshold compactions;
      // absent when aborted, prepareCompaction returned early, or
      // model/auth was missing.
      summary?: string
      firstKeptEntryId?: string
      errorMessage?: string
      at: number
      aborted: boolean
    }
  | {
      kind: "agent_end"
      stopReason: string
      tokenUsage: DebugTokenUsage
      // Wall-clock from first request emit to agent_end.
      durationMs: number
    }
  | {
      kind: "error"
      message: string
      // Which call/tool was in flight when the error fired, if known.
      llmCall?: number
      toolName?: string
    }
  // `shouldStopAfterTurn` halted the loop mid-turn on crossing the
  // compaction threshold; the post-run path then compacts + resumes via
  // agent.continue. Surfacing this explains the compaction round that
  // follows in the timeline.
  | {
      kind: "mid_turn_stop"
      reason: "threshold"
      contextTokens: number
      contextWindow: number
      reserveTokens: number
      at: number
    }
  // start/end of a pi-mono auto-retry after a retryable LLM error, so a
  // retried answer is visible in the timeline without diffing run_stats.
  | {
      kind: "retry_attempt"
      phase: "start" | "end"
      attempt: number
      maxAttempts?: number
      success?: boolean
      errorMessage?: string
      at: number
    }
) & {
  /** Set only on events forwarded from a sub-agent's nested run, so the
   *  panel can badge/group them under that sub-agent. */
  subAgent?: { name: string; nestedRunId: string }
}

export const isDetailed = (v: DebugVerbosity): boolean => v === "detailed"
