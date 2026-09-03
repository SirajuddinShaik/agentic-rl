import type { Model } from "@earendil-works/pi-ai"
import {
  type AgentSessionEvent,
  type ExtensionFactory,
  AuthStorage,
  calculateContextTokens,
  type CreateAgentSessionOptions,
  DefaultResourceLoader,
  ModelRegistry,
  type AgentSession as PiMonoAgentSession,
  SessionManager,
  SettingsManager,
  createAgentSession,
  estimateTokens,
  shouldCompact,
} from "@earendil-works/pi-coding-agent"

import { ragCompactionExtension } from "./rag-compaction-extension"
import type { RAGAgent, RAGAgentConfig, RAGEvent, RunOptions } from "./types"
import { getLogger } from "@/platform/logger"
import { Subsystem } from "@/types"

const CLog = getLogger(Subsystem.Chat)

const DEFAULT_TIMEOUT_MS = 8 * 60 * 60 * 1000 // 8h (SEBI fix: 20m aborted every agent turn under load)

export function resolveModel(
  modelInput: string | Model<any>,
  baseUrl?: string,
  options?: {
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
  },
): Model<"openai-completions"> {
  if (typeof modelInput !== "string") return modelInput

  return {
    id: modelInput,
    name: modelInput,
    api: "openai-completions",
    provider: "litellm",
    baseUrl: baseUrl ?? "",
    reasoning: options?.reasoning ?? false,
    input: options?.input ?? ["text", "image"],
    cost: options?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: options?.contextWindow ?? 100000,
    maxTokens: options?.maxTokens ?? 4096,
    compat: {
      supportsStore: false,
      supportsStreaming: true,
      supportsToolStreaming: true,
      supportsDeveloperRole: false,
    },
  } as Model<"openai-completions">
}

// Injected after the mid-turn-stop soft cap. Wording is deliberately a hard
// constraint, not a suggestion — vague phrasing gets ignored for "one more search".
const FINAL_ANSWER_STEER_TEXT =
  "[system steering] You have reached the maximum number of search/tool iterations for this turn. " +
  "Do NOT issue any more tool calls. Using ONLY the Key findings already gathered in the compaction summary above, " +
  "produce the final answer for the user now. " +
  "If some specific sub-question can't be answered from what you already have, say so explicitly in the answer — " +
  "but do not search further. Synthesize a complete response from the existing findings."

/** Append the final-answer steer to both the pi-mono session history (persistence
 *  + next compaction) and the in-memory agent state (so the next
 *  `agent.continue()` LLM call sees it). Both writes best-effort. */
function injectFinalAnswerSteer(
  piSession: PiMonoAgentSession,
  // pi's AgentSession type exposes state.model but not state.messages, though
  // messages exist at runtime (SDK type drift); cast for injectSteerUserMessage.
  agent: unknown,
  stopCount: number,
): void {
  injectSteerUserMessage(
    piSession,
    agent as { state: { messages?: unknown[] } },
    `${FINAL_ANSWER_STEER_TEXT} (Triggered after ${stopCount} mid-turn compactions.)`,
  )
}

// Recovery steer for the Nemotron "stop with empty text but huge thinking"
// failure mode (provider returns stopReason="stop", text="\n" mid-thought).
// Caught in the patched _checkCompaction, then forces one more continue.
const TRUNCATION_RECOVERY_STEER_TEXT =
  "[system steering] Your previous response was cut off — you produced reasoning but no visible answer. " +
  "Write the final answer for the user now, directly and concisely, using the reasoning you already worked out. " +
  "Do NOT re-derive everything from scratch and do NOT call any more tools. " +
  "Just state the answer."

/** Appends `text` as a user message to both the persistent session and the
 *  in-memory agent state. Shared by the mid-turn-cap and truncation steers. */
function injectSteerUserMessage(
  piSession: PiMonoAgentSession,
  // agent.state.messages exists at runtime but isn't in pi's static
  // AgentSession.state type (SDK drift); accessed defensively below.
  agent: unknown,
  text: string,
): void {
  const userMsg = {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp: Date.now(),
  }
  try {
    ;(
      piSession.sessionManager as unknown as {
        appendMessage: (m: unknown) => unknown
      }
    ).appendMessage(userMsg)
  } catch {}
  try {
    const messages = (agent as { state?: { messages?: unknown[] } }).state
      ?.messages
    if (Array.isArray(messages)) {
      messages.push(userMsg)
    }
  } catch {}
}

/** Aggregate an assistant message's text + thinking and flag any tool_use block. */
function readAssistantContent(msg: { content?: unknown }): {
  text: string
  thinking: string
  hasToolUse: boolean
} {
  let text = ""
  let thinking = ""
  let hasToolUse = false
  const content = msg.content
  if (typeof content === "string") {
    text = content
  } else if (Array.isArray(content)) {
    for (const b of content as Array<{
      type?: string
      text?: string
      thinking?: string
    }>) {
      if (!b || typeof b !== "object") continue
      if (b.type === "text" && typeof b.text === "string") text += b.text
      else if (b.type === "thinking" && typeof b.thinking === "string")
        thinking += b.thinking
      else if (b.type === "toolCall" || b.type === "tool_use") hasToolUse = true
    }
  }
  return { text, thinking, hasToolUse }
}

/** Detect the Nemotron truncation failure mode: loop genuinely ending without a
 *  visible answer. Requires stopReason="stop" (model declared done), no tool_use
 *  (else the loop hasn't ended — don't steer), empty text, and non-empty thinking
 *  (distinguishes a cut-off answer from a wire-level failure a retry won't fix).
 *  No minimum thinking length — the mode appears at any reasoning-budget tier. */
function looksTruncated(msg: {
  stopReason?: string
  content?: unknown
}): boolean {
  if (msg.stopReason !== "stop") return false
  const { text, thinking, hasToolUse } = readAssistantContent(msg)
  if (hasToolUse) return false
  return text.trim().length === 0 && thinking.length > 0
}

function mapEvent(event: AgentSessionEvent): RAGEvent[] {
  const events: RAGEvent[] = []
  const e = event as any

  switch (e.type) {
    case "agent_start":
      events.push({ type: "agent_start" })
      break

    case "agent_end":
      events.push({ type: "agent_end" })
      break

    case "turn_start":
      events.push({ type: "turn_start", turnIndex: e.turnIndex ?? 0 })
      break

    case "turn_end":
      events.push({ type: "turn_end", turnIndex: e.turnIndex ?? 0 })
      break

    case "tool_execution_start":
      events.push({
        type: "tool_call",
        toolName: e.toolName,
        toolCallId: e.toolCallId ?? "",
        args: e.args,
      })
      break

    case "tool_execution_end":
      // pi-coding-agent only sets top-level `isError` when the tool *throws*.
      // Tools that catch a 4xx/5xx and return `textResult(text, details, true)`
      // arrive with `e.isError === false` (renders as a tick); read the flag off
      // the result body too so caught-and-returned errors surface as errors.
      events.push({
        type: "tool_result",
        toolName: e.toolName,
        toolCallId: e.toolCallId ?? "",
        result: e.result,
        isError: e.isError || (e.result as { isError?: boolean })?.isError === true,
      })
      break

    case "message_update": {
      const assistantEvent = e.assistantMessageEvent
      if (assistantEvent?.type === "text_delta" && assistantEvent.delta) {
        events.push({ type: "text_delta", delta: assistantEvent.delta })
      } else if (
        assistantEvent?.type === "thinking_delta" &&
        assistantEvent.delta
      ) {
        events.push({
          type: "thinking_delta",
          delta: assistantEvent.delta,
          contentIndex: assistantEvent.contentIndex,
        })
      } else if (assistantEvent?.type === "thinking_start") {
        events.push({
          type: "thinking_start",
          contentIndex: assistantEvent.contentIndex,
        })
      } else if (assistantEvent?.type === "thinking_end") {
        events.push({
          type: "thinking_end",
          contentIndex: assistantEvent.contentIndex,
        })
      }
      break
    }

    case "thinking_start":
      events.push({
        type: "thinking_start",
        contentIndex: e.contentIndex,
      })
      break

    case "thinking_end":
      events.push({
        type: "thinking_end",
        contentIndex: e.contentIndex,
        contentSignature: e.contentSignature,
      })
      break

    case "message_end":
      events.push({
        type: "message_end",
        message: {
          role: e.message?.role ?? "assistant",
          content: e.message?.content,
          stopReason: e.message?.stopReason,
        },
      })
      break

    case "error":
      events.push({
        type: "error",
        error: { message: e.error?.message ?? String(e.error) },
      })
      break
  }

  events.push({ type: "raw", event })

  return events
}

export async function createRAGAgent<TState = unknown>(
  config: RAGAgentConfig<TState>,
): Promise<RAGAgent<TState>> {
  // --- Auth ---
  const authStorage = config.authStorage ?? AuthStorage.create()
  if (config.apiKey && !config.authStorage) {
    authStorage.set("litellm", { type: "api_key", key: config.apiKey })
  }
  const modelRegistry =
    config.modelRegistry ?? ModelRegistry.inMemory(authStorage)

  const model = resolveModel(config.model, config.baseUrl, config.modelOptions)

  // RAG-flavored compaction summarizer. Pi's built-in template ("Goal / Done /
  // Next Steps / file paths") is wrong for research turns and yields empty
  // `(none)` summaries, stranding the model with zero context. Returning
  // `{compaction: {summary, ...}}` makes pi use ours instead of its own
  // compact(). See rag-compaction-extension.ts.
  const ragCompactionFactory = ragCompactionExtension({
    model,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.sessionId
      ? { headers: { "x-session-id": config.sessionId } }
      : {}),
    ...(config.thinkingLevel !== undefined &&
    (config.thinkingLevel as string) !== "off"
      ? { thinkingLevel: config.thinkingLevel }
      : {}),
  })

  let resourceLoader = config.resourceLoader
  if (!resourceLoader) {
    resourceLoader = new DefaultResourceLoader({
      // `agentDir` became required in 0.74.x — where pi looks for on-disk
      // extensions/skills/themes. We disable all of those below
      // (noExtensions/noSkills/noThemes/noPromptTemplates), so it never has to
      // exist; /tmp is a safe always-present sentinel.
      cwd: "/tmp",
      agentDir: "/tmp",
      noExtensions: true,
      systemPrompt: config.systemPrompt,
      ...(config.appendSystemPrompt !== undefined && {
        appendSystemPrompt: Array.isArray(config.appendSystemPrompt)
          ? config.appendSystemPrompt
          : [config.appendSystemPrompt],
      }),
      extensionFactories: [
        // pi's ExtensionFactory expects ExtensionAPI; our factory is typed
        // against a local ExtensionAPILike approximation (SDK type drift).
        ragCompactionFactory as ExtensionFactory,
        ...(config.extensions ?? []),
      ],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
    })
    await resourceLoader.reload()
  }

  // --- Session ---
  const sessionManager = config.sessionManager ?? SessionManager.inMemory()

  // --- Settings ---
  const settingsManager =
    config.settingsManager ??
    SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
    })

  // --- Create pi-mono session ---
  // `tools: []` in 0.74+ is an empty *allowlist* that suppresses
  // every tool including customTools. `noTools: "builtin"` disables
  // pi's defaults (read/bash/edit/write) but leaves customTools
  // registered.
  const sessionOptions: CreateAgentSessionOptions = {
    model: model,
    noTools: "builtin",
    customTools: config.tools,
    resourceLoader,
    authStorage,
    modelRegistry,
    sessionManager,
    settingsManager,
    ...(config.thinkingLevel !== undefined && {
      thinkingLevel: config.thinkingLevel,
    }),
    ...(config.scopedModels !== undefined && {
      scopedModels: config.scopedModels,
    }),
  }

  const { session: piSession } = await createAgentSession(sessionOptions)

  // Mid-turn compaction workaround for earendil-works/pi#4325 (and #2871).
  // Pi's auto-compaction only fires after a full agent_end, so a long tool loop
  // can balloon past contextWindow before any check runs. The `shouldStopAfterTurn`
  // hook that would fix this exists in 0.74+ but isn't exposed on `Agent` / wired by
  // coding-agent. We monkey-patch `agent.createLoopConfig` to inject it: returning
  // true emits a clean agent_end, after which pi's existing
  // `_runAgentPrompt → _handlePostAgentRun → _checkCompaction → agent.continue()`
  // (agent-session.js:642) compacts and resumes on the compacted history.
  // Kill-switch: `BACKENDV2_PI_MID_TURN_COMPACTION=false`.
  if (process.env["BACKENDV2_PI_MID_TURN_COMPACTION"] !== "false") {
    type ShouldStopCtx = {
      message: { stopReason?: string; usage?: unknown }
      toolResults?: unknown[]
    }
    type LoopCfg = { shouldStopAfterTurn?: (ctx: ShouldStopCtx) => boolean }
    const agent = piSession.agent as unknown as {
      createLoopConfig: (opts?: unknown) => LoopCfg
      state: { model?: { contextWindow?: number } }
    }
    const origCreateLoopConfig = agent.createLoopConfig.bind(agent)
    const debugSink = config.debug

    // Trailing tool-results token estimate stashed by shouldStopAfterTurn,
    // consumed+cleared by _checkCompaction so its threshold math agrees with ours.
    let pendingTrailingTokens = 0
    // Soft-cap on mid-turn stops per `prompt()` call. Past the cap the model tends
    // to tool-spam (re-searching with slight rewordings); _checkCompaction then
    // compacts one last time and injects a "produce final answer now" steer.
    // Configurable via `BACKENDV2_PI_MAX_MID_TURN_STOPS`.
    const maxMidTurnStops = Math.max(
      1,
      Number(process.env["BACKENDV2_PI_MAX_MID_TURN_STOPS"] ?? "5"),
    )
    let midTurnStopCount = 0
    // Inject the steer at most ONCE per run — re-injecting on every compaction
    // past the cap piles up steer messages that each drive another turn (a loop).
    let steerInjected = false
    const maybeSteer = (): void => {
      if (steerInjected) return
      if (midTurnStopCount < maxMidTurnStops) return
      steerInjected = true
      injectFinalAnswerSteer(piSession, agent, midTurnStopCount)
    }
    agent.createLoopConfig = (opts?: unknown): LoopCfg => {
      const cfg = origCreateLoopConfig(opts)
      cfg.shouldStopAfterTurn = (ctx): boolean => {
        const settings = piSession.settingsManager.getCompactionSettings()
        if (!settings.enabled) return false
        const { message } = ctx
        // ONLY force a mid-turn stop on `toolUse`. Terminal reasons mean the turn
        // is done: on stop/endTurn the model already produced its final answer, so
        // compact+continue loops forever and the answer never surfaces (the "result
        // comes but doesn't surface" bug); error/aborted has nothing to compact.
        if (message.stopReason !== "toolUse") {
          return false
        }
        const ctxWindow = agent.state.model?.contextWindow ?? 0
        if (ctxWindow <= 0) return false
        if (!message.usage) return false
        const baseTokens = calculateContextTokens(
          message.usage as Parameters<typeof calculateContextTokens>[0],
        )
        const toolResults = Array.isArray(ctx.toolResults) ? ctx.toolResults : []
        let trailing = 0
        for (const t of toolResults) {
          trailing += estimateTokens(t as Parameters<typeof estimateTokens>[0])
        }
        const contextTokens = baseTokens + trailing
        const stop = shouldCompact(contextTokens, ctxWindow, settings)
        CLog.info(
          {
            phase: "shouldStopAfterTurn",
            stopReason: message.stopReason,
            baseTokens,
            trailing,
            contextTokens,
            ctxWindow,
            threshold: ctxWindow - settings.reserveTokens,
            stop,
            midTurnStopCountBefore: midTurnStopCount,
          },
          "RCA: shouldStopAfterTurn",
        )
        if (stop) {
          midTurnStopCount += 1
          pendingTrailingTokens = trailing
          if (debugSink) {
            debugSink.emitMidTurnStop({
              contextTokens,
              contextWindow: ctxWindow,
              reserveTokens: settings.reserveTokens,
              at: Date.now(),
            })
          }
        }
        return stop
      }
      return cfg
    }

    // Patch _checkCompaction to agree with our hook: pi's default uses
    // assistantMessage.usage only, missing tool results that landed after the
    // assistant call, so fold our stashed trailing tokens into the threshold check.
    // See earendil-works/pi#4550 (auto-closed) for the equivalent upstream fix.
    const session = piSession as unknown as {
      _checkCompaction: (
        msg: { stopReason?: string; usage?: unknown },
        skipAbortedCheck?: boolean,
      ) => Promise<boolean>
      _runAutoCompaction: (
        reason: string,
        willRetry: boolean,
      ) => Promise<boolean>
      settingsManager: typeof piSession.settingsManager
    }
    // Track _runAutoCompaction success via the `compaction_end` event: its return
    // value is `hasQueuedMessages()` (agent-session.js:1580), false when nothing's
    // queued, so it can't distinguish success from failure.
    let lastCompactionSucceeded = false
    let insideOrigCheck = false
    let compactionStartCount = 0
    piSession.subscribe((evt: { type: string; aborted?: boolean; result?: unknown }) => {
      if (evt.type === "compaction_start") {
        lastCompactionSucceeded = false
        compactionStartCount += 1
        CLog.info(
          { phase: "compaction_start", n: compactionStartCount, insideOrigCheck },
          "RCA: compaction_start fired",
        )
      } else if (evt.type === "compaction_end") {
        const ok = !evt.aborted && evt.result !== undefined
        if (ok) lastCompactionSucceeded = true
        CLog.info(
          { phase: "compaction_end", n: compactionStartCount, insideOrigCheck, ok },
          "RCA: compaction_end fired",
        )
      }
    })
    // Cap on truncation-recovery retries (see _checkCompaction below). If the
    // model truncates again on the continue, one more shot usually suffices;
    // beyond that we give up so we don't loop on a genuinely stuck model.
    const maxTruncationRecoveries = Math.max(
      0,
      Number(process.env["BACKENDV2_PI_MAX_TRUNCATION_RECOVERIES"] ?? "2"),
    )
    let truncationRecoveryCount = 0
    const origCheckCompaction = session._checkCompaction.bind(session)
    let checkCompactionCalls = 0
    session._checkCompaction = async (msg, skipAbortedCheck = true): Promise<boolean> => {
      const callNo = ++checkCompactionCalls
      // Detect the Nemotron truncation cliff and force one more continue. Must run
      // BEFORE the trailing/compaction checks: the failed message's usage is small
      // enough that shouldCompact would skip, ending the turn with empty text.
      if (
        looksTruncated(msg as { stopReason?: string; content?: unknown }) &&
        truncationRecoveryCount < maxTruncationRecoveries
      ) {
        truncationRecoveryCount += 1
        injectSteerUserMessage(piSession, agent, TRUNCATION_RECOVERY_STEER_TEXT)
        // Skip compaction — context isn't the problem. Returning true makes
        // `_handlePostAgentRun` call agent.continue() with the steer appended.
        return true
      }

      const trailing = pendingTrailingTokens
      pendingTrailingTokens = 0
      CLog.info(
        {
          phase: "_checkCompaction:enter",
          callNo,
          stopReason: msg.stopReason,
          hasUsage: !!msg.usage,
          trailing,
          midTurnStopCount,
        },
        "RCA: _checkCompaction enter",
      )
      const startCountBefore = compactionStartCount
      insideOrigCheck = true
      const ranNative = await origCheckCompaction(msg, skipAbortedCheck)
      insideOrigCheck = false
      // Native returns `hasQueuedMessages()`, FALSE even after a successful
      // threshold compaction, so `ranNative` alone misses native compactions;
      // detect them via the compaction_start counter + our success flag. If native
      // already compacted, DON'T fall through to our _runAutoCompaction —
      // prepareCompaction() returns null and we'd emit a spurious empty compaction.
      const nativeCompacted =
        compactionStartCount > startCountBefore && lastCompactionSucceeded
      CLog.info(
        {
          phase: "_checkCompaction:afterNative",
          callNo,
          ranNative,
          nativeCompacted,
          lastCompactionSucceeded,
        },
        "RCA: native path result",
      )
      if (ranNative || nativeCompacted) {
        // Force a continue ONLY mid-turn (toolUse). On a terminal message the model
        // already answered; forcing agent.continue() would regenerate it forever, so
        // return the native result and let the turn finalize.
        const isMidTurn = msg.stopReason === "toolUse"
        if (!isMidTurn) {
          CLog.info(
            { phase: "_checkCompaction:terminalNoCont", callNo, stopReason: msg.stopReason, nativeCompacted },
            "RCA: terminal stop — compacted but NOT forcing continue",
          )
          return ranNative
        }
        if (nativeCompacted) {
          maybeSteer()
        }
        return true
      }
      // Native skipped — re-evaluate with our stashed trailing tokens folded in.
      if (trailing <= 0) {
        CLog.info({ phase: "_checkCompaction:skip", callNo, why: "trailing<=0" }, "RCA: our path skipped")
        return false
      }
      const settings = session.settingsManager.getCompactionSettings()
      if (!settings.enabled) return false
      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        CLog.info({ phase: "_checkCompaction:skip", callNo, why: `stopReason=${msg.stopReason}` }, "RCA: our path skipped")
        return false
      }
      if (!msg.usage) {
        CLog.info({ phase: "_checkCompaction:skip", callNo, why: "no usage" }, "RCA: our path skipped")
        return false
      }
      const ctxWindow = agent.state.model?.contextWindow ?? 0
      if (ctxWindow <= 0) return false
      const base = calculateContextTokens(
        msg.usage as Parameters<typeof calculateContextTokens>[0],
      )
      if (!shouldCompact(base + trailing, ctxWindow, settings)) {
        CLog.info({ phase: "_checkCompaction:skip", callNo, why: "under threshold", base, trailing }, "RCA: our path skipped")
        return false
      }
      CLog.info({ phase: "_checkCompaction:ourCompact", callNo, base, trailing }, "RCA: running our compaction")
      const r = await session._runAutoCompaction("threshold", false)
      // Our mid-turn stop means the model hasn't yet responded to the compacted
      // tool result, but _runAutoCompaction's `hasQueuedMessages()` return makes
      // `_handlePostAgentRun` skip the follow-up continue — correct after a natural
      // post-agent_end compaction, but here it'd end the run on a tool_result with no
      // text. Force a continue when compaction wrote a summary.
      if (lastCompactionSucceeded) {
        maybeSteer()
        return true
      }
      return r
    }
  }

  // Wrap streamFn for per-model sampler params (temperature/topP) and per-turn
  // debug capture. Both optional — skipped entirely otherwise (zero overhead).
  const wantedTemp = config.streamOptions?.temperature
  const wantedTopP = config.streamOptions?.topP
  const debug = config.debug
  if (
    wantedTemp !== undefined ||
    wantedTopP !== undefined ||
    debug ||
    config.sessionId !== undefined
  ) {
    const innerStreamFn = piSession.agent.streamFn
    piSession.agent.streamFn = async (model, context, options) => {
      const priorOnPayload = options?.onPayload
      const onPayload = async (
        payload: unknown,
        m: unknown,
      ): Promise<unknown> => {
        // Chain the upstream hook first (pi dispatches before_provider_request there).
        const next = priorOnPayload
          ? await priorOnPayload(payload as never, m as never)
          : payload
        // Inject top_p — pi-ai's StreamOptions doesn't expose it; the
        // openai-completions provider reads it from the final body.
        if (wantedTopP !== undefined && next && typeof next === "object") {
          ;(next as Record<string, unknown>)["top_p"] = wantedTopP
        }
        // Captured post-mutation so the sink matches what hits the wire.
        if (debug) {
          const payloadObj =
            next && typeof next === "object" ? (next as Record<string, unknown>) : {}
          const msgs = payloadObj["messages"]
          const systemPromptChars = Array.isArray(msgs)
            ? msgs.reduce((acc: number, msg: unknown): number => {
                if (!msg || typeof msg !== "object") return acc
                const role = (msg as Record<string, unknown>)["role"]
                if (role !== "system") return acc
                const content = (msg as Record<string, unknown>)["content"]
                return acc + (typeof content === "string" ? content.length : 0)
              }, 0)
            : 0
          const modelId =
            typeof (model as { id?: unknown })?.id === "string"
              ? ((model as { id: string }).id)
              : "unknown"
          debug.emitRequest({
            sentAt: Date.now(),
            model: modelId,
            sampler: {
              ...(wantedTemp !== undefined ? { temperature: wantedTemp } : {}),
              ...(wantedTopP !== undefined ? { topP: wantedTopP } : {}),
              ...(typeof payloadObj["max_tokens"] === "number"
                ? { maxTokens: payloadObj["max_tokens"] as number }
                : typeof payloadObj["max_completion_tokens"] === "number"
                  ? { maxTokens: payloadObj["max_completion_tokens"] as number }
                  : {}),
            },
            systemPromptChars,
            payload: next,
          })
        }
        return next
      }
      return innerStreamFn(model, context, {
        ...options,
        ...(wantedTemp !== undefined ? { temperature: wantedTemp } : {}),
        headers: {
          ...(options?.headers ?? {}),
          ...(config.sessionId ? { "x-session-id": config.sessionId } : {}),
        },
        onPayload,
      })
    }
  }

  // --- State ---
  let userState = config.state

  const agent: RAGAgent<TState> = {
    run(message: string, options?: RunOptions): AsyncIterable<RAGEvent> {
      return (async function* () {
        const timeoutMs =
          options?.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS

        const eventQueue: RAGEvent[] = []
        let done = false
        let resolveWaiting: (() => void) | null = null
        let rejectWaiting: ((err: Error) => void) | null = null

        function push(event: RAGEvent) {
          eventQueue.push(event)
          if (resolveWaiting) {
            const r = resolveWaiting
            resolveWaiting = null
            rejectWaiting = null
            r()
          }
        }

        // When a debug sink is wired, tee assistant `message_end` into it as one
        // `response` event so the panel pairs each request with its full response.
        // Per-chunk streaming is intentionally not surfaced — too noisy.
        const debugSink = config.debug
        const unsubscribe = piSession.subscribe((rawEvent) => {
          if (debugSink) {
            const e = rawEvent as {
              type?: string
              message?: {
                role?: string
                content?: unknown
                stopReason?: string
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
              e.message?.role === "assistant"
            ) {
              const content = e.message.content
              // Sum text + thinking from Anthropic-style block arrays; fall back to
              // plain string for non-block content.
              let text: string | undefined
              let thinking: string | undefined
              if (typeof content === "string") {
                text = content
              } else if (Array.isArray(content)) {
                const textParts: string[] = []
                const thinkingParts: string[] = []
                for (const b of content as Array<{
                  type?: string
                  text?: string
                  thinking?: string
                }>) {
                  if (b && typeof b === "object") {
                    if (b.type === "text" && typeof b.text === "string") {
                      textParts.push(b.text)
                    } else if (
                      b.type === "thinking" &&
                      typeof b.thinking === "string"
                    ) {
                      thinkingParts.push(b.thinking)
                    }
                  }
                }
                if (textParts.length > 0) text = textParts.join("\n")
                if (thinkingParts.length > 0) thinking = thinkingParts.join("\n")
              }
              const usage = e.message.usage
              debugSink.emitResponse({
                receivedAt: Date.now(),
                ...(e.message.stopReason
                  ? { stopReason: e.message.stopReason }
                  : {}),
                ...(text !== undefined && text.length > 0 ? { text } : {}),
                ...(thinking !== undefined && thinking.length > 0
                  ? { thinking }
                  : {}),
                ...(usage
                  ? {
                      tokenUsage: {
                        input: usage.input ?? 0,
                        output: usage.output ?? 0,
                        cacheRead: usage.cacheRead ?? 0,
                        cacheWrite: usage.cacheWrite ?? 0,
                      },
                    }
                  : {}),
              })
            }
          }
          const mapped = mapEvent(rawEvent as AgentSessionEvent)
          for (const evt of mapped) {
            push(evt)
            // `agent_end` is intentionally NOT terminal: the mid-turn compaction
            // workaround emits it mid-run, with more turns (the final answer) to
            // follow. The run ends only when `promptPromise` settles (.finally
            // below); returning on `agent_end` would drop the answer (blank turn).
          }
        })

        const promptPromise = piSession
          .prompt(
            message,
            options?.images && options.images.length > 0
              ? { images: options.images }
              : undefined,
          )
          .catch((err: any) => {
            push({
              type: "error",
              error: { message: err?.message ?? String(err) },
            })
          })
          .finally(() => {
            // Run is complete only once `prompt()` settles (after every mid-turn
            // compaction cycle). Wake any waiter so the generator drains all
            // remaining events (including the post-compaction answer) first.
            done = true
            if (resolveWaiting) {
              const r = resolveWaiting
              resolveWaiting = null
              rejectWaiting = null
              r()
            }
          })

        const timeoutId = setTimeout(() => {
          push({
            type: "error",
            error: { message: `Agent timed out after ${timeoutMs}ms` },
          })
          done = true
          if (rejectWaiting) {
            rejectWaiting(new Error("timeout"))
            resolveWaiting = null
            rejectWaiting = null
          }
        }, timeoutMs)

        try {
          while (true) {
            while (eventQueue.length > 0) {
              const evt = eventQueue.shift()!
              yield evt
              // Do NOT return on `agent_end` — under mid-turn compaction it is
              // followed by more turns; the generator ends below via `done`.
            }

            if (done) return

            await new Promise<void>((resolve, reject) => {
              resolveWaiting = resolve
              rejectWaiting = reject
            })
          }
        } finally {
          clearTimeout(timeoutId)
          unsubscribe()
          await promptPromise.catch(() => {})
        }
      })()
    },

    async stop() {
      await piSession.abort()
    },

    getSession() {
      return piSession
    },

    getState() {
      return userState
    },

    dispose() {
      piSession.dispose()
    },
  }

  return agent
}
