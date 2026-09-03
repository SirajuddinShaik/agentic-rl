// dispatchSubagent — the parent agent's gateway into its sub-agents.
//
// Never touches the DB directly (persistence flows through injected
// callbacks). Sub-agent tokens land on the nested row only, not the
// parent (M7 "Nested row only"). Not in TOOL_REGISTRY: added by the
// runner only when an agent has ≥1 sub-agent; sub-agents never get it
// (flat hierarchy).

import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent"
import {
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import { Type } from "@sinclair/typebox"

import { createRAGAgent, type RAGAgent } from "@/app/agent/pi-mono/core"
import { CITATION_REMINDER } from "../citation-reminder"

import type { AgentScope, DispatchableSubAgent } from "../../agent-scope"
import type { Log } from "../../log"
import { buildToolsForRun } from "./registry"

// ── Persistence contract ────────────────────────────────────────────────────
// Implemented by the chat service over v2_chat_* tables; this tool stays
// storage-agnostic, emitting only start + finish per dispatch.

export type NestedRunBatch = {
  status: "completed" | "errored" | "aborted"
  endedAt: number
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
  /** Set only when status !== "completed"; carried verbatim into the
   *  parent's error result. */
  error?: string
  /** Final assistant text. Shipped even on partial failure so the
   *  parent has something to work with. */
  finalText: string
  thinkingText: string
  toolCalls: ReadonlyArray<{
    toolName: string
    toolCallId: string
    args: unknown
    result: unknown
    isError: boolean
    startedAt: number
    completedAt: number
  }>
}

export type NestedRunPersistence = {
  start: (input: {
    subAgentExternalId: string
    model: string
  }) => Promise<string>
  finish: (nestedRunId: string, batch: NestedRunBatch) => Promise<void>
}

// ── Build context ───────────────────────────────────────────────────────────

export type SubAgentStatusEvent = {
  parentToolCallId: string
  /** Dispatch position within the batch (0 for a single dispatch). The UI keys
   *  lanes by this so same-name sub-agents (same name, different queries) don't
   *  collapse into one lane that flips done when only the first finishes. */
  index: number
  subAgentName: string
  subAgentExternalId: string
  status: "started" | "completed" | "errored"
  nestedRunId?: string
  durationMs?: number
  error?: string
}

export type SubAgentActivityEvent = {
  parentToolCallId: string
  index: number
  subAgentName: string
  label: string
}

const describeToolCall = (toolName: string, args: unknown): string => {
  const a = (args ?? {}) as Record<string, unknown>
  switch (toolName) {
    case "vespaSearch": {
      const q = typeof a["query"] === "string" ? (a["query"] as string) : ""
      return q ? `searching: "${q.slice(0, 60)}"` : "searching the corpus"
    }
    case "getChunks":
      return "reading a document"
    case "searchWithinDoc":
      return "searching within a document"
    case "getFolderTree":
      return "browsing the corpus"
    default:
      return `using ${toolName}`
  }
}

export type DispatchToolCtx = {
  userEmail: string
  /** Threaded into sub-agent tool builds so conversation-scoped tools (e.g. the
   *  computer sandbox) key on the same conversation as the parent. */
  conversationId: string
  logger: Log
  /** Parent's vespa scope — sub-agents inherit it verbatim. */
  agentScope?: AgentScope
  subAgents: ReadonlyArray<DispatchableSubAgent>
  /** Same endpoint as the runner so the nested session hits the same provider;
   *  model comes through verbatim (M7: "same as parent"). */
  llm: {
    model: string
    baseUrl: string
    apiKey: string
  }
  // thinkingLevel intentionally NOT here — stored per sub-agent on the
  // sub_agents row and read off DispatchableSubAgent at dispatch time.
  // A parent-level override would re-introduce the "who decides leaf
  // reasoning effort" ambiguity the persistence move settled.
  maxTokens?: number
  contextWindow?: number
  reserveTokens?: number
  keepRecentTokens?: number
  timeoutMs?: number
  persistence: NestedRunPersistence
  /** Per-sub-agent lifecycle hook, fired independently even within a parallel
   *  batch, for a live `subagent_status` SSE. UI-only; never persisted. */
  onSubAgentStatus?: (s: SubAgentStatusEvent) => void
  /** Fired per sub-agent tool call so the UI can show live lane activity. UI-only. */
  onSubAgentActivity?: (a: SubAgentActivityEvent) => void
  /** Factory for a per-sub-agent DebugCapture (debug mode only), passed to the
   *  nested createRAGAgent so its LLM debug events stream under the parent. */
  makeSubAgentDebug?: (
    nestedRunId: string,
    subAgentName: string,
  ) => import("../debug/capture").DebugCapture
}

const DESCRIPTION = [
  "Dispatch a focused query to one of the available sub-agents. Each ",
  "sub-agent runs in an ISOLATED session (its working memory doesn't ",
  "leak back to you), with its own system prompt and tool subset. Use ",
  "this when the user's question fits a sub-agent's description squarely ",
  "— pattern-match the description, not the agent name. Pass a focused ",
  "query the sub-agent can answer end-to-end; don't pre-decompose. Treat ",
  "the returned text as authoritative for the slice you delegated and ",
  "preserve its citations verbatim. If no sub-agent's description ",
  "matches, answer it yourself instead of force-dispatching.",
].join("")

const params = Type.Object({
  name: Type.String({
    description:
      "Slug of the sub-agent to dispatch to. Must match the `name` " +
      "attribute on one of the <subagent> entries above.",
    minLength: 1,
  }),
  query: Type.String({
    description:
      "Self-contained question for the sub-agent. Pass a focused " +
      "single-topic query the sub-agent can answer end-to-end without " +
      "needing follow-ups from you.",
    minLength: 1,
  }),
})

// ── Tool builder ────────────────────────────────────────────────────────────

// Union of every shape `execute` returns in `details`. defineTool is generic
// over a single TDetails, so without this explicit shape TS picks the first
// branch's keys and rejects the others. All fields optional — no branch sets
// all: not-found {error, requested, available}; persist-fail {error, name};
// sub-agent error {error, name, nestedRunId, partialChars}; success omits
// `error`, adds {resultChars, toolCallCount, durationMs}.
type DispatchDetails = {
  error?: string
  requested?: string
  available?: string
  name?: string
  nestedRunId?: string
  partialChars?: number
  resultChars?: number
  toolCallCount?: number
  durationMs?: number
}

// ── Normalized outcome (shared by the single + batch tools) ─────────────────
// runOneDispatch never throws — every failure is a `status` here, so the batch
// tool's Promise.allSettled always sees clean values to render.
export type DispatchOutcome = {
  name: string
  status:
    | "not-found"
    | "persist-start-failed"
    | "errored"
    | "completed"
    | "aborted"
  finalText: string
  errorText?: string
  available?: string
  nestedRunId?: string
  resultChars: number
  toolCallCount: number
  durationMs: number
}

/** Run ONE sub-agent end-to-end in an isolated session and return a normalized
 *  outcome. The single `dispatchSubagent` tool calls this once; the parallel
 *  `dispatchSubagentBatch` tool calls it many times concurrently via
 *  Promise.allSettled. Never throws. */
async function runOneDispatch(
  ctx: DispatchToolCtx,
  p: { name: string; query: string },
  parentToolCallId: string,
  dispatchIndex: number,
): Promise<DispatchOutcome> {
  const log = ctx.logger.child({
    toolName: "dispatchSubagent",
    subAgentName: p.name,
  })

  // 1. Resolve the sub-agent by name.
  const sub = ctx.subAgents.find((s) => s.name === p.name)
  if (!sub) {
    const available = ctx.subAgents.map((s) => s.name).join(", ")
    log.warn({ available }, "dispatchSubagent: sub-agent not found")
    return {
      name: p.name,
      status: "not-found",
      finalText: "",
      available,
      resultChars: 0,
      toolCallCount: 0,
      durationMs: 0,
    }
  }

  const subLog = log.child({ subAgentExternalId: sub.externalId })
  const startedAt = Date.now()

  // 2. Open the nested run row.
  let nestedRunId: string
  try {
    nestedRunId = await ctx.persistence.start({
      subAgentExternalId: sub.externalId,
      model: ctx.llm.model,
    })
  } catch (err) {
    subLog.error(
      { err },
      "dispatchSubagent: nested-run start persistence failed",
    )
    return {
      name: p.name,
      status: "persist-start-failed",
      finalText: "",
      errorText: err instanceof Error ? err.message : String(err),
      resultChars: 0,
      toolCallCount: 0,
      durationMs: 0,
    }
  }

  ctx.onSubAgentStatus?.({
    parentToolCallId,
    index: dispatchIndex,
    subAgentName: sub.name,
    subAgentExternalId: sub.externalId,
    status: "started",
    nestedRunId,
  })

  subLog.info(
    {
      nestedRunId,
      queryChars: p.query.length,
      subToolsCount: sub.tools.length,
    },
    "dispatchSubagent: nested run starting",
  )

  // 3. Build the sub-agent's tools. `[]` is literal — NO tools at run
  //    time. Names resolve through the parent's registry (unknown
  //    dropped); the dispatch tool isn't in it, so flat hierarchy holds.
  const subTools = buildToolsForRun(sub.tools, {
    userEmail: ctx.userEmail,
    logger: subLog,
    conversationId: ctx.conversationId,
    ...(ctx.agentScope ? { agentScope: ctx.agentScope } : {}),
  })

  // 4. Spin the nested session (debug mode wires a per-sub-agent capture).
  const subSession = SessionManager.inMemory()
  const subDebug = ctx.makeSubAgentDebug?.(nestedRunId, sub.name)
  const subAgent: RAGAgent<unknown> = await createRAGAgent({
    model: ctx.llm.model,
    baseUrl: ctx.llm.baseUrl,
    apiKey: ctx.llm.apiKey,
    tools: subTools,
    systemPrompt: sub.systemPrompt,
    sessionManager: subSession,
    settingsManager: SettingsManager.inMemory({
      compaction: {
        enabled: true,
        reserveTokens: ctx.reserveTokens ?? 40192,
        keepRecentTokens: ctx.keepRecentTokens ?? 50000,
      },
      retry: { enabled: true, maxRetries: 2 },
    }),
    modelOptions: {
      contextWindow: ctx.contextWindow ?? 100000,
      maxTokens: ctx.maxTokens ?? 64000,
      reasoning: true,
    },
    thinkingLevel: sub.thinkingLevel,
    extensions: [],
    timeoutMs: ctx.timeoutMs ?? 10 * 60 * 1000,
    ...(subDebug ? { debug: subDebug } : {}),
  })

  // 5. Iterate to completion, collecting every event into a trace for
  //    persistence under the nested run id.
  let finalText = ""
  let thinkingText = ""
  let error: string | undefined
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  // Keyed by toolCallId to stitch tool_call / tool_result into one row each.
  const pendingByCallId = new Map<
    string,
    {
      toolName: string
      toolCallId: string
      args: unknown
      startedAt: number
    }
  >()
  const completedToolCalls: NestedRunBatch["toolCalls"][number][] = []

  try {
    for await (const event of subAgent.run(`${p.query}${CITATION_REMINDER}`)) {
      if (event.type === "raw") {
        // Token usage lives only on the raw message_end; the mapped RAGEvent
        // doesn't carry it.
        const e = event.event as {
          type?: string
          message?: {
            role?: string
            usage?: {
              input?: number
              output?: number
              cacheRead?: number
              cacheWrite?: number
            }
          }
        }
        if (
          e.type === "message_end" &&
          e.message?.role === "assistant" &&
          e.message.usage
        ) {
          const u = e.message.usage
          tokens.input += u.input ?? 0
          tokens.output += u.output ?? 0
          tokens.cacheRead += u.cacheRead ?? 0
          tokens.cacheWrite += u.cacheWrite ?? 0
        }
        continue
      }
      switch (event.type) {
        case "text_delta": {
          if (event.delta) finalText += event.delta
          break
        }
        case "thinking_delta": {
          if (event.delta) thinkingText += event.delta
          break
        }
        case "tool_call": {
          const startedAt = Date.now()
          pendingByCallId.set(event.toolCallId, {
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            args: event.args,
            startedAt,
          })
          // The runner's tool-call wrapping (which emits these) doesn't cover
          // sub-agents — they run via createRAGAgent directly.
          subDebug?.emitToolCallStart({
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            args: event.args,
            startedAt,
          })
          ctx.onSubAgentActivity?.({
            parentToolCallId,
            index: dispatchIndex,
            subAgentName: sub.name,
            label: describeToolCall(event.toolName, event.args),
          })
          break
        }
        case "tool_result": {
          const pending = pendingByCallId.get(event.toolCallId)
          if (pending) {
            const completedAt = Date.now()
            completedToolCalls.push({
              toolName: pending.toolName,
              toolCallId: pending.toolCallId,
              args: pending.args,
              result: event.result,
              isError: event.isError,
              startedAt: pending.startedAt,
              completedAt,
            })
            subDebug?.emitToolCallEnd({
              toolName: pending.toolName,
              toolCallId: pending.toolCallId,
              durationMs: completedAt - pending.startedAt,
              isError: event.isError,
              result: event.result,
            })
            pendingByCallId.delete(event.toolCallId)
          }
          break
        }
        case "message_end": {
          // Pi-mono sometimes fills full content only on message_end (no
          // text_delta stream); pick it up so finalText isn't empty.
          if (
            event.message.role === "assistant" &&
            !finalText.trim() &&
            event.message.content
          ) {
            const content = event.message.content
            if (typeof content === "string") {
              const trimmed = content.trim()
              if (trimmed) finalText = trimmed
            }
          }
          break
        }
        case "error": {
          error = event.error.message
          subLog.warn(
            { errorMessage: event.error.message, code: event.error.code },
            "dispatchSubagent: sub-agent stream error",
          )
          break
        }
        default:
          break
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    subLog.error({ err }, "dispatchSubagent: nested iteration threw")
  } finally {
    subAgent.dispose()
  }

  // Record any tool_call lacking a tool_result as abandoned — otherwise it's
  // lost from the trace.
  for (const [, pending] of pendingByCallId) {
    completedToolCalls.push({
      toolName: pending.toolName,
      toolCallId: pending.toolCallId,
      args: pending.args,
      result: { abandoned: true },
      isError: true,
      startedAt: pending.startedAt,
      completedAt: Date.now(),
    })
  }

  const endedAt = Date.now()
  const status: NestedRunBatch["status"] = error ? "errored" : "completed"

  // 6. Persist the trace + close the nested run row.
  try {
    await ctx.persistence.finish(nestedRunId, {
      status,
      endedAt,
      tokens,
      ...(error ? { error } : {}),
      finalText,
      thinkingText,
      toolCalls: completedToolCalls,
    })
  } catch (persistErr) {
    // A persist failure must NOT block the parent from getting the answer;
    // log loudly and ship the result anyway.
    subLog.error(
      { err: persistErr, nestedRunId },
      "dispatchSubagent: nested-run finish persistence failed (sub-agent text still returned to parent)",
    )
  }

  ctx.onSubAgentStatus?.({
    parentToolCallId,
    index: dispatchIndex,
    subAgentName: sub.name,
    subAgentExternalId: sub.externalId,
    status: error ? "errored" : "completed",
    nestedRunId,
    durationMs: endedAt - startedAt,
    ...(error ? { error } : {}),
  })

  subLog.info(
    {
      nestedRunId,
      status,
      durationMs: endedAt - startedAt,
      finalTextChars: finalText.length,
      toolCallCount: completedToolCalls.length,
      tokens,
    },
    "dispatchSubagent: nested run done",
  )

  return {
    name: p.name,
    status,
    finalText,
    ...(error ? { errorText: error } : {}),
    nestedRunId,
    resultChars: finalText.length,
    toolCallCount: completedToolCalls.length,
    durationMs: endedAt - startedAt,
  }
}

// ── Tool builders ───────────────────────────────────────────────────────────

const renderSingle = (o: DispatchOutcome) => {
  if (o.status === "not-found") {
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Sub-agent "${o.name}" not found. Available sub-agents: ` +
            `${o.available || "(none)"}.`,
        },
      ],
      details: {
        error: "not-found",
        requested: o.name,
        available: o.available,
      },
      isError: true,
    }
  }
  if (o.status === "persist-start-failed") {
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Sub-agent "${o.name}" could not be dispatched — persistence ` +
            `setup failed: ${o.errorText}`,
        },
      ],
      details: { error: "persistence-start-failed", name: o.name },
      isError: true,
    }
  }
  if (o.status !== "completed") {
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Sub-agent "${o.name}" failed: ${o.errorText}` +
            (o.finalText
              ? `\n\n— Partial response below —\n${o.finalText}`
              : ""),
        },
      ],
      details: {
        error: o.errorText,
        name: o.name,
        nestedRunId: o.nestedRunId,
        partialChars: o.finalText.length,
      },
      isError: true,
    }
  }
  return {
    content: [{ type: "text" as const, text: o.finalText }],
    details: {
      name: o.name,
      nestedRunId: o.nestedRunId,
      resultChars: o.resultChars,
      toolCallCount: o.toolCallCount,
      durationMs: o.durationMs,
    },
  }
}

export const buildDispatchSubagentTool = (
  ctx: DispatchToolCtx,
): ReturnType<typeof defineTool> =>
  defineTool<typeof params, DispatchDetails>({
    name: "dispatchSubagent",
    label: "Dispatch sub-agent",
    description: DESCRIPTION,
    promptSnippet:
      "Use `dispatchSubagent({name, query})` when the user's question " +
      "fits one of the sub-agents above. Pick the sub-agent whose " +
      "description matches; pass a focused query.",
    parameters: params,
    async execute(toolCallId, p) {
      // SDK's AgentToolResult dropped isError; render* predates it but is
      // runtime-correct — cast at the boundary.
      return renderSingle(
        await runOneDispatch(ctx, p, toolCallId, 0),
      ) as AgentToolResult<DispatchDetails>
    },
  })

// ── Parallel batch dispatch ─────────────────────────────────────────────────

const BATCH_DESCRIPTION = [
  "Dispatch SEVERAL sub-agents IN PARALLEL — one focused query each — and get ",
  "all their answers back together. Use this to cover multiple independent ",
  "angles of a question at once: pass one dispatch per angle, each a ",
  "self-contained query the chosen sub-agent can answer end-to-end without ",
  "follow-ups. Each sub-agent runs in its OWN isolated session (its working ",
  "memory does not enter your context) and returns a concise summary; you ",
  "receive one labelled block per sub-agent. Preserve every summary's citations ",
  "verbatim. Prefer this over many sequential dispatchSubagent calls when the ",
  "angles are independent.",
].join("")

const batchParams = Type.Object({
  dispatches: Type.Array(
    Type.Object({
      name: Type.String({
        description:
          "Slug of the sub-agent to dispatch to. Must match a `name` on one " +
          "of the <subagent> entries above.",
        minLength: 1,
      }),
      query: Type.String({
        description:
          "Self-contained, single-topic question this sub-agent can answer " +
          "end-to-end without needing follow-ups from you.",
        minLength: 1,
      }),
    }),
    {
      description:
        "1–6 dispatches to run concurrently. Include only the angles the " +
        "question actually needs.",
      minItems: 1,
      maxItems: 6,
    },
  ),
})

type BatchDetails = {
  dispatched?: number
  failed?: number
  results?: ReadonlyArray<{
    name: string
    nestedRunId?: string
    isError: boolean
  }>
}

export const buildDispatchSubagentBatchTool = (
  ctx: DispatchToolCtx,
): ReturnType<typeof defineTool> =>
  defineTool<typeof batchParams, BatchDetails>({
    name: "dispatchSubagentBatch",
    label: "Dispatch sub-agents (parallel)",
    description: BATCH_DESCRIPTION,
    promptSnippet:
      "Use `dispatchSubagentBatch({dispatches:[{name,query}, …]})` to fan out " +
      "to several specialists at once; you get one labelled summary per " +
      "sub-agent back together.",
    parameters: batchParams,
    async execute(toolCallId, p) {
      const settled = await Promise.allSettled(
        p.dispatches.map((d, i) => runOneDispatch(ctx, d, toolCallId, i)),
      )
      const outcomes: DispatchOutcome[] = settled.map((s, i) =>
        s.status === "fulfilled"
          ? s.value
          : {
              name: p.dispatches[i]?.name ?? `dispatch-${String(i)}`,
              status: "errored" as const,
              finalText: "",
              errorText:
                s.reason instanceof Error ? s.reason.message : String(s.reason),
              resultChars: 0,
              toolCallCount: 0,
              durationMs: 0,
            },
      )
      const blocks = outcomes.map((o) => {
        const body =
          o.status === "completed"
            ? o.finalText || "(empty response)"
            : o.status === "not-found"
              ? `(not dispatched — sub-agent not found; available: ${o.available || "none"})`
              : o.status === "persist-start-failed"
                ? `(not dispatched — persistence failed: ${o.errorText})`
                : `(failed: ${o.errorText})${o.finalText ? `\n— partial —\n${o.finalText}` : ""}`
        return `### ${o.name}\n${body}`
      })
      const failed = outcomes.filter((o) => o.status !== "completed").length
      ctx.logger.info(
        { dispatched: outcomes.length, failed },
        "dispatchSubagentBatch: fan-out complete",
      )
      // SDK's AgentToolResult dropped isError; this shape predates it but is
      // runtime-correct — cast at the boundary.
      return {
        content: [{ type: "text" as const, text: blocks.join("\n\n") }],
        details: {
          dispatched: outcomes.length,
          failed,
          results: outcomes.map((o) => ({
            name: o.name,
            nestedRunId: o.nestedRunId,
            isError: o.status !== "completed",
          })),
        },
        isError: failed === outcomes.length,
      } as AgentToolResult<BatchDetails>
    },
  })
