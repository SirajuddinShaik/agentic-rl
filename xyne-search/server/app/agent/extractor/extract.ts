// Programmatic extraction: run pi-mono, validate JSON against the agent's
// responseSchema, re-prompt up to extractorMaxRetries on failure. Synchronous.
//
// Persists to the same v2_chat_* tables as chat (originKind "extract"): keeps it
// out of the chat sidebar but fully replayable. Each retry is a fresh turn whose
// user message is the prior validation errors.

import { randomUUID } from "node:crypto"

import { loadAgentScope } from "../agent-scope"
import {
  type RunPiMonoTurnResult,
  dropSession,
  runPiMonoTurn,
} from "../pi-mono/runner"
import { resolveAgentSystemPrompt } from "../pi-mono/system-prompt"
import {
  type ValidationError,
  formatErrorsForRetry,
  validate,
} from "./validator"
import { DebugCapture } from "../pi-mono/debug/capture"
import type { DebugEvent, DebugVerbosity } from "../pi-mono/debug/types"
import type { NestedRunPersistence } from "../pi-mono/tools/dispatch-subagent"
import type { AgentDeps } from "../wiring"
import {
  type Block,
  type ToolCallId,
  asAgentId,
  asRunId,
  asToolCallId,
  asUserId,
  asWorkspaceId,
} from "../storage/types"
import { baseLogger } from "../log"

const Logger = baseLogger("backendv2/extractor")

const newIdemKey = (): string => randomUUID()

export class ExtractorAgentNotFoundError extends Error {
  public override readonly name = "ExtractorAgentNotFoundError"
}
export class NotAnExtractorError extends Error {
  public override readonly name = "NotAnExtractorError"
}
export class MissingResponseSchemaError extends Error {
  public override readonly name = "MissingResponseSchemaError"
}

export type ExtractAttemptDebug = {
  attempt: number
  /** v2_chat_runs.id — keys the shared debug-event store the chat DebugPanel reads. */
  runId: string
  durationMs: number
  rawText: string
  rawJson?: string
  ok: boolean
  errors?: ValidationError[]
  debugEvents: DebugEvent[]
}

export type ExtractResult =
  | {
      ok: true
      conversationId: string
      value: unknown
      attempts: number
      tokenUsage: RunPiMonoTurnResult["stats"]["tokenUsage"]
      debug: ExtractAttemptDebug[]
    }
  | {
      ok: false
      conversationId: string
      errors: ValidationError[]
      lastRawText: string
      attempts: number
      tokenUsage: RunPiMonoTurnResult["stats"]["tokenUsage"]
      debug: ExtractAttemptDebug[]
    }

export type ExtractInput = {
  input: string
  maxRetries?: number
  modelLabel?: string
  thinkingLevel?: "minimal" | "low" | "medium" | "high"
  /** Gates DebugCapture allocation; off by default. */
  debug?: boolean
  /** "summary" = boundaries + sampler params; "detailed" also adds payloads,
   *  assistant text/thinking, and tool results. */
  debugVerbosity?: DebugVerbosity
}

/** Schema goes in the user message, not the system prompt: empirically yields a
 *  more reliable response shape. */
const buildInitialMessage = (
  input: string,
  schema: Record<string, unknown>,
): string =>
  [
    input,
    "",
    "---",
    "",
    "Return ONLY a JSON object matching this schema. No prose, no markdown fences, no explanation outside the JSON.",
    "",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
  ].join("\n")

const sumTokenUsage = (
  acc: RunPiMonoTurnResult["stats"]["tokenUsage"],
  add: RunPiMonoTurnResult["stats"]["tokenUsage"],
): RunPiMonoTurnResult["stats"]["tokenUsage"] => ({
  input: acc.input + add.input,
  output: acc.output + add.output,
  cacheRead: acc.cacheRead + add.cacheRead,
  cacheWrite: acc.cacheWrite + add.cacheWrite,
})

const summariseErrors = (errors: ValidationError[]): string => {
  const head = errors
    .slice(0, 5)
    .map((e) => `${e.path}: ${e.message}`)
    .join("; ")
  const suffix =
    errors.length > 5 ? ` (+${String(errors.length - 5)} more)` : ""
  return `Validation failed (${String(errors.length)} error${
    errors.length === 1 ? "" : "s"
  }): ${head}${suffix}`
}

/** runId keys the event into the shared debug-event store; in a batch run,
 *  orderId + index attribute it to the right per-id card. */
export type ExtractStreamEvent = {
  kind: "debug_event"
  runId: string
  event: DebugEvent
  orderId?: string
  index?: number
}

export type BatchExtractItem = {
  orderId: string
  index: number
} & (ExtractResult | { ok: false; error: string })

export type BatchExtractResult = {
  items: BatchExtractItem[]
}

/** Extract comma-separated order ids from surrounding prose ("Extract ID1, ID2
 *  from the corpus"): isolate the region from the last token before the first
 *  comma to the first token after the last, then split/trim/de-dupe. No comma →
 *  whole input is one id. */
export const splitOrderIds = (input: string): string[] => {
  let region = input
  const firstComma = input.indexOf(",")
  if (firstComma !== -1) {
    const before = input.slice(0, firstComma)
    const firstId = /(\S*)$/.exec(before)?.[1] ?? ""
    const start = before.length - firstId.length
    const lastComma = input.lastIndexOf(",")
    const after = input.slice(lastComma + 1)
    const tail = /^(\s*)(\S*)/.exec(after)
    const end = lastComma + 1 + (tail?.[1]?.length ?? 0) + (tail?.[2]?.length ?? 0)
    region = input.slice(start, end)
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of region.split(",")) {
    const id = raw.trim()
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

export const runExtract = async (
  deps: AgentDeps,
  viewer: { email: string; workspaceExternalId: string },
  agentExternalId: string,
  args: ExtractInput,
  signal?: AbortSignal,
  /** Fires per captured DebugEvent for the SSE route; must never block the loop. */
  onEvent?: (event: ExtractStreamEvent) => void,
): Promise<ExtractResult> => {
  const scope = await loadAgentScope(
    {
      userId: asUserId(viewer.email),
      workspaceId: asWorkspaceId(viewer.workspaceExternalId),
    },
    agentExternalId,
  )
  if (!scope) {
    throw new ExtractorAgentNotFoundError(agentExternalId)
  }
  if (!scope.isExtractor) {
    throw new NotAnExtractorError(
      `Agent ${agentExternalId} is not an extractor`,
    )
  }
  if (!scope.responseSchema) {
    throw new MissingResponseSchemaError(
      `Extractor ${agentExternalId} has no response schema`,
    )
  }

  const schema = scope.responseSchema
  const maxRetries = Math.max(
    0,
    args.maxRetries ?? scope.extractorMaxRetries ?? 2,
  )
  const assembledPrompt = resolveAgentSystemPrompt({
    systemPromptMain: scope.systemPromptMain,
    systemPromptTools: scope.systemPromptTools,
    systemPromptSubagents: scope.systemPromptSubagents,
    subAgents: scope.subAgents,
  })

  // conv.id also keys pi-mono's in-memory session map, so retries share LLM
  // history; dropped in the finally.
  const conv = await deps.convs.create(
    {
      ownerId: asUserId(viewer.email),
      workspaceId: asWorkspaceId(viewer.workspaceExternalId),
      title: "Extract",
      agentId: asAgentId(scope.externalId),
      originKind: "extract",
    },
    newIdemKey(),
  )
  const sessionConvId = String(conv.id)

  const debug: ExtractAttemptDebug[] = []
  let tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let lastErrors: ValidationError[] = []
  let lastRawText = ""

  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Retries re-send the schema alongside the errors so the model has the
      // target shape in front of it.
      const userText =
        attempt === 0
          ? buildInitialMessage(args.input, schema)
          : formatErrorsForRetry(lastErrors, schema)

      const turnIdem = newIdemKey()
      const { turn } = await deps.msgs.appendTurn(
        {
          conversationId: conv.id,
          userMessage: { blocks: [{ kind: "text", text: userText }] },
        },
        turnIdem,
      )

      const run = await deps.msgs.startRun(
        turn.id,
        {
          agentId: asAgentId(scope.externalId),
          model: args.modelLabel ?? "Auto",
        },
        `${String(turn.id)}:run`,
      )

      const assistantMessage = await deps.msgs.appendAssistantMessage(
        run.id,
        { blocks: [] },
        `${String(run.id)}:msg`,
      )

      const pendingToolCalls = new Map<string, ToolCallId>()
      let pendingText = ""
      let pendingThinking = ""

      const flushPendingText = async (): Promise<void> => {
        if (pendingText.length === 0) return
        await deps.msgs.appendBlock(assistantMessage.id, {
          kind: "text",
          text: pendingText,
        })
        pendingText = ""
      }
      const flushPendingThinking = async (): Promise<void> => {
        if (pendingThinking.length === 0) return
        await deps.msgs.appendBlock(assistantMessage.id, {
          kind: "thinking",
          text: pendingThinking,
        })
        pendingThinking = ""
      }

      const startedAt = Date.now()
      const capturedEvents: DebugEvent[] = []
      const runIdForCapture = String(run.id)
      const capture: DebugCapture | undefined = args.debug
        ? new DebugCapture(args.debugVerbosity ?? "summary", (event): void => {
            capturedEvents.push(event)
            try {
              onEvent?.({
                kind: "debug_event",
                runId: runIdForCapture,
                event,
              })
            } catch {
              /* don't let a sink failure break the loop */
            }
          })
        : undefined
      Logger.info(
        { conversationId: sessionConvId, attempt, agentExternalId },
        "extract: pi-mono turn start",
      )

      // Sub-agent traces persist as nested runs under the parent turn (mirrors chat.ts).
      const dispatchPersistence: NestedRunPersistence = {
        start: async ({ subAgentExternalId, model }) => {
          const nested = await deps.msgs.startRun(
            turn.id,
            {
              parentRunId: run.id,
              agentId: asAgentId(scope.externalId),
              subAgentId: subAgentExternalId,
              model,
            },
            `${String(run.id)}:sub:${subAgentExternalId}:${String(Date.now())}`,
          )
          return String(nested.id)
        },
        finish: async (nestedRunIdStr, batch) => {
          const nestedRunIdTyped = asRunId(nestedRunIdStr)
          const nestedMsg = await deps.msgs.appendAssistantMessage(
            nestedRunIdTyped,
            { blocks: [] },
            `${nestedRunIdStr}:msg`,
          )
          if (batch.thinkingText.trim().length > 0) {
            await deps.msgs.appendBlock(nestedMsg.id, {
              kind: "thinking",
              text: batch.thinkingText.trim(),
            })
          }
          const sortedCalls = [...batch.toolCalls].sort(
            (a, b) => a.startedAt - b.startedAt,
          )
          for (const tc of sortedCalls) {
            await deps.msgs.appendBlock(nestedMsg.id, {
              kind: "tool_use",
              toolCallId: asToolCallId(tc.toolCallId),
              toolName: tc.toolName,
              args: tc.args,
            })
            await deps.msgs.appendBlock(nestedMsg.id, {
              kind: "tool_result",
              toolCallId: asToolCallId(tc.toolCallId),
              output: tc.result,
              isError: tc.isError,
            })
          }
          if (batch.finalText.trim().length > 0) {
            await deps.msgs.appendBlock(nestedMsg.id, {
              kind: "text",
              text: batch.finalText.trim(),
            })
          }
          await deps.msgs.endRun(nestedRunIdTyped, {
            status: batch.status,
            tokensIn: batch.tokens.input + batch.tokens.cacheRead,
            tokensOut: batch.tokens.output,
            ...(batch.error ? { error: batch.error } : {}),
          })
        },
      }

      const piResult = await runPiMonoTurn({
        conversationId: sessionConvId,
        userEmail: viewer.email,
        message: userText,
        agentScope: scope,
        systemPrompt: assembledPrompt,
        toolNames: scope.tools,
        ...(args.modelLabel ? { modelLabel: args.modelLabel } : {}),
        thinkingLevel: args.thinkingLevel ?? "low",
        ...(signal ? { signal } : {}),
        ...(scope.subAgents.length > 0
          ? {
              dispatchableSubAgents: scope.subAgents,
              dispatchPersistence,
            }
          : {}),
        ...(capture ? { debug: capture } : {}),
        onTextDelta: (delta): void => {
          pendingText += delta
        },
        onThinkingDelta: (delta): void => {
          pendingThinking += delta
        },
        onThinkingEnd: flushPendingThinking,
        onToolCall: async (call): Promise<void> => {
          await flushPendingThinking()
          await flushPendingText()
          const id = asToolCallId(call.toolCallId)
          pendingToolCalls.set(call.toolCallId, id)
          await deps.msgs.appendBlock(assistantMessage.id, {
            kind: "tool_use",
            toolCallId: id,
            toolName: call.toolName,
            args: call.args,
          })
        },
        onToolResult: async (result): Promise<void> => {
          const id =
            pendingToolCalls.get(result.toolCallId) ??
            asToolCallId(result.toolCallId)
          await deps.msgs.appendBlock(assistantMessage.id, {
            kind: "tool_result",
            toolCallId: id,
            output: result.result,
            isError: result.isError,
          })
        },
      })

      await flushPendingThinking()
      await flushPendingText()

      const durationMs = Date.now() - startedAt
      tokens = sumTokenUsage(tokens, piResult.stats.tokenUsage)
      lastRawText = piResult.text

      await deps.msgs.setStats(assistantMessage.id, {
        tokenUsage: piResult.stats.tokenUsage,
        cacheHitRatio: piResult.stats.cacheHitRatio,
        ...(piResult.stats.contextUsage
          ? { contextUsage: piResult.stats.contextUsage }
          : {}),
        compactionRounds: piResult.stats.compactionRounds,
        retryAttempts: piResult.stats.retryAttempts,
        durationMs: piResult.stats.durationMs,
      })

      if (piResult.error) {
        const errBlock: Block = {
          kind: "error",
          code: "pi_mono_error",
          message: piResult.error,
        }
        await deps.msgs.appendBlock(assistantMessage.id, errBlock)
        await deps.msgs.endRun(run.id, {
          status: "errored",
          error: piResult.error,
        })
        await deps.msgs.endTurn(turn.id, "errored", piResult.error)

        debug.push({
          attempt,
          runId: String(run.id),
          durationMs,
          rawText: piResult.text,
          ok: false,
          errors: [{ path: "$", message: `Runtime error: ${piResult.error}` }],
          debugEvents: capturedEvents,
        })
        return {
          ok: false,
          conversationId: sessionConvId,
          errors: [{ path: "$", message: `Runtime error: ${piResult.error}` }],
          lastRawText,
          attempts: attempt + 1,
          tokenUsage: tokens,
          debug,
        }
      }

      const v = validate(piResult.text, schema)
      if (v.ok) {
        await deps.msgs.endRun(run.id, { status: "completed" })
        await deps.msgs.endTurn(turn.id, "completed", undefined)
        debug.push({
          attempt,
          runId: String(run.id),
          durationMs,
          rawText: piResult.text,
          rawJson: v.rawJson,
          ok: true,
          debugEvents: capturedEvents,
        })
        return {
          ok: true,
          conversationId: sessionConvId,
          value: v.value,
          attempts: attempt + 1,
          tokenUsage: tokens,
          debug,
        }
      }

      lastErrors = v.errors
      debug.push({
        attempt,
        runId: String(run.id),
        durationMs,
        rawText: piResult.text,
        ...(v.rawJson !== undefined ? { rawJson: v.rawJson } : {}),
        ok: false,
        errors: v.errors,
        debugEvents: capturedEvents,
      })
      await deps.msgs.appendBlock(assistantMessage.id, {
        kind: "error",
        code: "validation_failed",
        message: summariseErrors(v.errors),
      })
      await deps.msgs.endRun(run.id, { status: "completed" })
      await deps.msgs.endTurn(turn.id, "completed", undefined)

      Logger.info(
        {
          conversationId: sessionConvId,
          attempt,
          errorCount: v.errors.length,
        },
        "extract: validation failed",
      )
    }
    return {
      ok: false,
      conversationId: sessionConvId,
      errors: lastErrors,
      lastRawText,
      attempts: maxRetries + 1,
      tokenUsage: tokens,
      debug,
    }
  } finally {
    dropSession(sessionConvId)
    Logger.info(
      { conversationId: sessionConvId, attempts: debug.length },
      "extract: complete",
    )
  }
}

const BATCH_CONCURRENCY = 5

/** One runExtract per order id, up to BATCH_CONCURRENCY in parallel; a failing
 *  id never sinks the batch. onItem/onEvent surface per-item lifecycle. */
export const runExtractBatch = async (
  deps: AgentDeps,
  viewer: { email: string; workspaceExternalId: string },
  agentExternalId: string,
  args: ExtractInput,
  signal?: AbortSignal,
  onEvent?: (event: ExtractStreamEvent) => void,
  onItem?: (
    ev:
      | { kind: "item_start"; orderId: string; index: number }
      | { kind: "item_result"; orderId: string; index: number; result: ExtractResult },
  ) => void,
): Promise<BatchExtractResult> => {
  const orderIds = splitOrderIds(args.input)
  const ids = orderIds.length > 0 ? orderIds : [args.input.trim()]

  const items: BatchExtractItem[] = new Array(ids.length)

  const runOne = async (orderId: string, index: number): Promise<void> => {
    onItem?.({ kind: "item_start", orderId, index })
    try {
      const result = await runExtract(
        deps,
        viewer,
        agentExternalId,
        { ...args, input: orderId },
        signal,
        // Tag events with the item so the UI keys them to the right card.
        onEvent
          ? (ev): void => onEvent({ ...ev, orderId, index })
          : undefined,
      )
      items[index] = { orderId, index, ...result }
      onItem?.({ kind: "item_result", orderId, index, result })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      items[index] = { orderId, index, ok: false, error: message }
      Logger.warn({ orderId, err: message }, "extract(batch): item threw")
    }
  }

  // Bounded worker pool: shared cursor hands out the next index.
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      if (index >= ids.length) return
      await runOne(ids[index]!, index)
    }
  }
  const workers = Array.from(
    { length: Math.min(BATCH_CONCURRENCY, ids.length) },
    () => worker(),
  )
  await Promise.allSettled(workers)

  return { items }
}
