// DebugCapture — per-turn event sink, created at sendMessage when the
// caller opted in and living until agent_end. Each `emit` applies the
// verbosity gate, then hands the event to the service-supplied publisher
// (typically deps.stream.publish wrapped to carry the run id).

import { scrubSensitive } from "./scrub"
import {
  isDetailed,
  type DebugEvent,
  type DebugTokenUsage,
  type DebugVerbosity,
} from "./types"

type Publish = (event: DebugEvent) => void

/** Methods are driven by the rag-agent streamFn wrapper (request/
 *  response/agent_end), the runner's tool-call wrapping, and the chat
 *  service forwarding compaction events. Payloads are scrubbed before
 *  reaching `publish`. */
export class DebugCapture {
  private llmCall = 0
  private readonly verbosity: DebugVerbosity
  private readonly publish: Publish

  public constructor(verbosity: DebugVerbosity, publish: Publish) {
    this.verbosity = verbosity
    this.publish = publish
  }

  /** Bump + return the LLM-call index; called once per outbound request
   *  so downstream events group under that round in the UI. */
  public nextLlmCall(): number {
    this.llmCall += 1
    return this.llmCall
  }

  public currentLlmCall(): number {
    return this.llmCall
  }

  public emitRequest(args: {
    sentAt: number
    model: string
    sampler: {
      temperature?: number
      topP?: number
      maxTokens?: number
    }
    systemPromptChars: number
    payload: unknown
  }): void {
    const llmCall = this.nextLlmCall()
    // `summary` drops the wire body, keeping only boundaries + sampler.
    const includePayload = isDetailed(this.verbosity)
    this.publish({
      kind: "request",
      llmCall,
      sentAt: args.sentAt,
      model: args.model,
      sampler: args.sampler,
      systemPromptChars: args.systemPromptChars,
      ...(includePayload ? { payload: scrubSensitive(args.payload) } : {}),
    })
  }

  public emitResponse(args: {
    receivedAt: number
    stopReason?: string
    text?: string
    thinking?: string
    tokenUsage?: DebugTokenUsage
  }): void {
    // `detailed` only (both can be long); empty strings omitted so the
    // panel skips rendering an empty section.
    const includeText = isDetailed(this.verbosity)
    this.publish({
      kind: "response",
      llmCall: this.llmCall,
      receivedAt: args.receivedAt,
      ...(args.stopReason ? { stopReason: args.stopReason } : {}),
      ...(includeText && args.text ? { text: args.text } : {}),
      ...(includeText && args.thinking ? { thinking: args.thinking } : {}),
      ...(args.tokenUsage ? { tokenUsage: args.tokenUsage } : {}),
    })
  }

  public emitToolCallStart(args: {
    toolName: string
    toolCallId: string
    args: unknown
    startedAt: number
  }): void {
    this.publish({
      kind: "tool_call_start",
      toolName: args.toolName,
      toolCallId: args.toolCallId,
      args: scrubSensitive(args.args),
      startedAt: args.startedAt,
    })
  }

  public emitToolCallEnd(args: {
    toolName: string
    toolCallId: string
    durationMs: number
    isError: boolean
    result: unknown
  }): void {
    const includeResult = isDetailed(this.verbosity)
    this.publish({
      kind: "tool_call_end",
      toolName: args.toolName,
      toolCallId: args.toolCallId,
      durationMs: args.durationMs,
      isError: args.isError,
      ...(includeResult ? { result: scrubSensitive(args.result) } : {}),
    })
  }

  public emitCompactionStart(args: {
    reason: string
    tokensBefore?: number
    at: number
  }): void {
    this.publish({
      kind: "compaction_start",
      reason: args.reason,
      ...(args.tokensBefore !== undefined
        ? { tokensBefore: args.tokensBefore }
        : {}),
      at: args.at,
    })
  }

  public emitCompactionEnd(args: {
    tokensBefore?: number
    tokensAfter?: number
    summary?: string
    firstKeptEntryId?: string
    errorMessage?: string
    at: number
    aborted: boolean
  }): void {
    this.publish({
      kind: "compaction_end",
      ...(args.tokensBefore !== undefined
        ? { tokensBefore: args.tokensBefore }
        : {}),
      ...(args.tokensAfter !== undefined
        ? { tokensAfter: args.tokensAfter }
        : {}),
      ...(args.summary !== undefined ? { summary: args.summary } : {}),
      ...(args.firstKeptEntryId !== undefined
        ? { firstKeptEntryId: args.firstKeptEntryId }
        : {}),
      ...(args.errorMessage !== undefined
        ? { errorMessage: args.errorMessage }
        : {}),
      at: args.at,
      aborted: args.aborted,
    })
  }

  public emitAgentEnd(args: {
    stopReason: string
    tokenUsage: {
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
    }
    durationMs: number
  }): void {
    this.publish({
      kind: "agent_end",
      stopReason: args.stopReason,
      tokenUsage: args.tokenUsage,
      durationMs: args.durationMs,
    })
  }

  public emitError(args: {
    message: string
    llmCall?: number
    toolName?: string
  }): void {
    this.publish({
      kind: "error",
      message: args.message,
      ...(args.llmCall !== undefined ? { llmCall: args.llmCall } : {}),
      ...(args.toolName !== undefined ? { toolName: args.toolName } : {}),
    })
  }

  /** Emitted when `shouldStopAfterTurn` halts the loop on crossing the
   *  compaction threshold mid-turn. */
  public emitMidTurnStop(args: {
    contextTokens: number
    contextWindow: number
    reserveTokens: number
    at: number
  }): void {
    this.publish({
      kind: "mid_turn_stop",
      reason: "threshold",
      contextTokens: args.contextTokens,
      contextWindow: args.contextWindow,
      reserveTokens: args.reserveTokens,
      at: args.at,
    })
  }

  /** Pi-mono `auto_retry_start` / `auto_retry_end` lifecycle. */
  public emitRetryAttempt(args: {
    phase: "start" | "end"
    attempt: number
    maxAttempts?: number
    success?: boolean
    errorMessage?: string
    at: number
  }): void {
    this.publish({
      kind: "retry_attempt",
      phase: args.phase,
      attempt: args.attempt,
      ...(args.maxAttempts !== undefined ? { maxAttempts: args.maxAttempts } : {}),
      ...(args.success !== undefined ? { success: args.success } : {}),
      ...(args.errorMessage !== undefined
        ? { errorMessage: args.errorMessage }
        : {}),
      at: args.at,
    })
  }
}
