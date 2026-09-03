// Overrides pi-coding-agent's auto-compaction for RAG sessions: its
// coding-assistant summary template is wrong here (vespaSearch calls, not file
// edits), so the model summarizes to "(none)" and loses the user's ask. We
// intercept `session_before_compact` with a RAG-flavored summary.
// Hook: agent-session.js _runAutoCompaction. Docs:
// https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md

import { complete, type Model, type ThinkingLevel } from "@earendil-works/pi-ai"

import { getLogger } from "@/platform/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Chat)

type ExtensionMessage = {
  role?: string
  content?: unknown
  toolName?: string
  toolCallId?: string
  // branchEntries carry the role on `.type`, not `.role` — e.g.
  // { type: "user", message: { role, content } }.
  type?: string
  // Entry id (branchEntries only); used as the firstKeptEntryId cut point.
  id?: string
  // `compaction` entries carry their text on `.summary`, not `.content`.
  summary?: string
  // SessionMessageEntry wraps on `.message`; the event we get flattens it —
  // handle both.
  message?: { role?: string; content?: unknown }
}

const entryRole = (e: ExtensionMessage): string | undefined =>
  e.message?.role ?? e.role ?? e.type

type PreparationLike = {
  firstKeptEntryId: string
  messagesToSummarize: ExtensionMessage[]
  turnPrefixMessages: ExtensionMessage[]
  isSplitTurn: boolean
  tokensBefore: number
  previousSummary?: string
  settings: { reserveTokens: number }
}

type SessionBeforeCompactEvent = {
  preparation: PreparationLike
  branchEntries?: unknown[]
  customInstructions?: string
  signal?: AbortSignal
}

type SessionBeforeCompactResult =
  | { cancel: true }
  | {
      compaction: {
        summary: string
        firstKeptEntryId: string
        tokensBefore: number
        details?: unknown
      }
    }
  | undefined

// Minimal subset of pi-coding-agent's ExtensionAPI we use.
type ExtensionAPILike = {
  on: (
    eventName: string,
    handler: (
      event: SessionBeforeCompactEvent,
    ) => Promise<SessionBeforeCompactResult> | SessionBeforeCompactResult,
  ) => void
}

export type RagCompactionDeps = {
  /** Pass the same Model instance the session uses. */
  model: Model<"openai-completions">
  apiKey?: string
  /** Provider headers from the auth chain (LiteLLM bearer, etc). */
  headers?: Record<string, string>
  thinkingLevel?: ThinkingLevel
}

// chars/4 matches pi-agent-core's own estimateTokens.
const approxTokens = (s: string): number => Math.ceil(s.length / 4)

const SYSTEM_PROMPT = `You are summarizing a research conversation for context-window management.

The conversation is between a user and an AI research assistant that searches a knowledge base via tools (vespaSearch, getChunks, etc.). Your output replaces the older messages in the assistant's context so it can continue answering the user. The assistant relies on what YOU surface — so preserve concrete quotes, doc IDs, and the work that has ALREADY been done so the assistant doesn't repeat it.

Your summary is read by the assistant as guidance on what to do NEXT. Avoid framing that invites more tool calls if the user's question is already answerable.

Do NOT continue the conversation. Do NOT answer the user's question yourself. ONLY output the structured summary.`

const PROMPT = `The messages above are a RAG research session to summarize.

Produce a markdown summary the assistant will use to continue the work, in this exact format:

## User messages
[EVERY message the user sent in this conversation, verbatim and in order — do NOT rephrase, summarize, merge, or drop any of them. Number them 1., 2., 3., … in send order. This includes short follow-ups like "Continue", "go on", or clarifications — they carry intent and MUST be preserved. The assistant relies on this section to know the full ask.]

## Searches already performed (do NOT repeat these)
[Bulleted list of tool calls in order. Each line: \`tool(query/args) — N hits\`. The assistant must NOT issue duplicate or near-duplicate variations of these — they have been tried.]

## Key findings
[The most useful facts/quotes pulled from tool_result content so far. Preserve exact wording where it's a definition or rule, with doc IDs (e.g. \`[doc clf-xxx]\`). Group by topic, not by tool call. Drop anything that turned out to be irrelevant.]

## What is now answerable
[For each part of the user's ask (across ALL their messages), state whether Key findings already contain enough to answer it. If yes, the assistant should STOP searching and produce the final answer using Key findings — do NOT request more searches just to "double-check". Only flag items as unanswered if a specific, named fact (a particular regulation, definition, or quoted clause) is missing AND cannot be inferred from what's already found.]

Be concise but PRESERVE quoted text, doc IDs, regulation numbers, and citation markers verbatim. The assistant cannot re-fetch what you drop.

If a "--- previous summary ---" block appears in the conversation, it is an EARLIER summary of this same session: carry ALL of its User messages, Searches, and Key findings forward into your output (merge, never drop), then fold in anything new from the messages after it.`

// Unifies the flattened vs `.message`-wrapped shapes pi-coding-agent uses
// across versions.
const renderMessage = (m: ExtensionMessage): string => {
  const inner = m.message ?? m
  const role = inner.role ?? m.role ?? m.type ?? "unknown"
  // Render a prior compaction's summary so the new summary folds it in.
  if (m.type === "compaction" && typeof m.summary === "string") {
    return `--- previous summary ---\n${m.summary}`
  }
  const content = inner.content ?? m.content
  let body: string
  if (typeof content === "string") {
    body = content
  } else if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content as Array<Record<string, unknown>>) {
      if (!block || typeof block !== "object") continue
      if (block["type"] === "text" && typeof block["text"] === "string") {
        parts.push(block["text"] as string)
      } else if (
        block["type"] === "thinking" &&
        typeof block["thinking"] === "string"
      ) {
        // Skip thinking — it bloats the prompt and the reasoning is already
        // baked into the tool calls that followed.
        continue
      } else if (block["type"] === "toolCall") {
        const name = block["toolName"] ?? "tool"
        const args = block["args"]
        parts.push(
          `[tool_call ${String(name)}(${
            args !== undefined ? JSON.stringify(args).slice(0, 400) : ""
          })]`,
        )
      } else if (block["type"] === "toolResult") {
        const tool = block["toolName"] ?? "tool"
        const result = block["result"]
        // Per-result truncation so one huge vespaSearch payload doesn't push
        // the summarization prompt past its own budget (~500 tokens).
        const txt =
          typeof result === "string"
            ? result
            : JSON.stringify(result ?? null).slice(0, 2000)
        parts.push(`[tool_result ${String(tool)}]\n${txt}`)
      }
    }
    body = parts.join("\n")
  } else {
    body = JSON.stringify(content ?? null).slice(0, 2000)
  }
  return `--- ${role} ---\n${body}`
}

const serialize = (messages: ExtensionMessage[]): string =>
  messages.map(renderMessage).join("\n\n")

/**
 * pi-coding-agent extension overriding RAG/research session compaction.
 * Register via `extensions: [ragCompactionExtension(deps)]` on createRAGAgent;
 * no-ops outside `session_before_compact`.
 */
export const ragCompactionExtension =
  (deps: RagCompactionDeps) =>
  (pi: ExtensionAPILike): void => {
    let invocationNo = 0
    const log = (msg: string, fields?: Record<string, unknown>): void => {
      Logger.info({ ...(fields ?? {}) }, `rag-compaction: ${msg}`)
    }

    log("registered session_before_compact handler")

    pi.on(
      "session_before_compact",
      async (event: SessionBeforeCompactEvent) => {
        const callNo = ++invocationNo
        const { preparation, signal } = event
        const rawBranch = (event.branchEntries ?? []) as ExtensionMessage[]
        log("RCA handler entry", {
          callNo,
          rawBranchCount: rawBranch.length,
          roles: rawBranch.map((e) => entryRole(e) ?? "?").join(","),
          prepFirstKeptId: preparation?.firstKeptEntryId,
          msgsToSummarize: preparation?.messagesToSummarize?.length ?? 0,
          turnPrefix: preparation?.turnPrefixMessages?.length ?? 0,
        })
        // Summarize the branch and replace it wholesale, so the goal + every
        // user message survive each round, the context actually shrinks, and no
        // dangling tool calls bait the model into more searching. The branch
        // already holds the prior summary as a `compaction` entry, so this folds
        // prior findings + new messages together (no separate plumbing).
        // We ignore the SDK's messagesToSummarize/turnPrefixMessages/
        // firstKeptEntryId: their cut-point logic can't split a single long
        // tool-call turn and often comes back empty, yielding a "Goal: none"
        // summary that never shrinks the context.
        const branch = (event.branchEntries ?? []) as ExtensionMessage[]
        // CRITICAL: summarize only from the LAST prior compaction onward.
        // branchEntries grows unbounded (compaction appends a marker, never
        // deletes); summarizing the whole branch every round balloons the
        // summarizer's OWN input until it 400s ("You passed 229992 input
        // tokens...") and strands the run. The last compaction already
        // condenses everything before it, so [last summary] + [entries since]
        // is equivalent and bounded.
        let lastCompactionIdx = -1
        for (let i = branch.length - 1; i >= 0; i--) {
          if (entryRole(branch[i]!) === "compaction") {
            lastCompactionIdx = i
            break
          }
        }
        const summarizeFrom =
          lastCompactionIdx >= 0 ? branch.slice(lastCompactionIdx) : branch
        const combined = summarizeFrom.filter((e) => {
          const role = entryRole(e)
          return (
            role === "user" ||
            role === "assistant" ||
            role === "toolResult" ||
            role === "compaction" // the last summary — fold it back in
          )
        })
        // Minimal-tail cut: keep the summary + everything from the last
        // user/assistant entry. Keeping only the summary would leave a bare
        // assistant as the resume point, and agent.continue() throws "Cannot
        // continue from message role: assistant". Cutting at the last
        // user/assistant entry lands the tail on a tool_result or user message
        // (both valid resume points). Never cut at a toolResult — it would
        // orphan from its tool call.
        let tailKeptId: string | undefined
        for (let i = branch.length - 1; i >= 0; i--) {
          const role = entryRole(branch[i]!)
          const id = branch[i]!.id
          if ((role === "user" || role === "assistant") && id) {
            tailKeptId = id
            break
          }
        }
        log("handler invoked", {
          hasPreparation: !!preparation,
          branchCount: branch.length,
          combinedCount: combined.length,
          tailKeptId,
        })
        if (combined.length === 0) {
          // Nothing to summarize — let pi-coding-agent's default path run.
          log("nothing to summarize — falling back", {})
          return undefined
        }

        const conversationText = serialize(combined)
        // Always a fresh full summary — the prior summary is embedded in
        // `combined` as a compaction message, so the model folds it in.
        const userPrompt = `<conversation>\n${conversationText}\n</conversation>\n\n${PROMPT}`

        // Mirror pi-agent-core/compaction.js:362 — 80% of reserve, bounded by model maxTokens.
        const modelMax = deps.model.maxTokens > 0 ? deps.model.maxTokens : Number.POSITIVE_INFINITY
        const maxTokens = Math.min(
          Math.floor(0.8 * preparation.settings.reserveTokens),
          modelMax,
        )

        log("invoking custom summarizer", {
          tokensBefore: preparation.tokensBefore,
          approxPromptTokens: approxTokens(userPrompt),
          maxTokens,
        })

        const startedAt = Date.now()
        let summary: string
        try {
          const response = await complete(
            deps.model,
            {
              systemPrompt: SYSTEM_PROMPT,
              messages: [
                {
                  role: "user",
                  content: [{ type: "text", text: userPrompt }],
                  timestamp: Date.now(),
                },
              ],
            },
            {
              maxTokens,
              ...(signal ? { signal } : {}),
              ...(deps.apiKey ? { apiKey: deps.apiKey } : {}),
              ...(deps.headers ? { headers: deps.headers } : {}),
              // Deliberately NO reasoning. On a reasoning model (e.g. nemotron)
              // it rambles and hallucinates fake tool calls that leak into the
              // summary (observed: 76KB of garbage, ~117s). A plain completion
              // extracts the structured summary directly.
            },
          )
          log("RCA summarizer response", {
            callNo,
            stopReason: response.stopReason,
            blockTypes: (response.content ?? [])
              .map(
                (c) =>
                  `${(c as { type?: string }).type}:${
                    JSON.stringify(c).length
                  }`,
              )
              .join(","),
            sysPromptChars: SYSTEM_PROMPT.length,
            userPromptHead: userPrompt.slice(0, 300),
            userPromptTail: userPrompt.slice(-600),
          })
          if (response.stopReason === "aborted") {
            log("aborted", {})
            return { cancel: true }
          }
          if (response.stopReason === "error") {
            log("model error — falling back to default", {
              errorMessage: response.errorMessage,
            })
            // undefined hands control to the built-in compact() — better than
            // killing the run.
            return undefined
          }
          const textParts = response.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
          summary = textParts.join("\n").trim()
          log("RCA summarizer text extracted", {
            callNo,
            textPartCount: textParts.length,
            summaryChars: summary.length,
            summaryHead: summary.slice(0, 200),
          })
        } catch (err) {
          log("threw — falling back to default", {
            error: (err as Error)?.message,
          })
          return undefined
        }

        if (!summary) {
          log("empty response — falling back to default", {})
          return undefined
        }

        log("produced summary", {
          summaryChars: summary.length,
          durationMs: Date.now() - startedAt,
        })

        return {
          compaction: {
            summary,
            // Minimal-tail cut (see above); fall back to the SDK's prepared
            // cut if no user/assistant entry was found.
            firstKeptEntryId: tailKeptId ?? preparation.firstKeptEntryId,
            tokensBefore: preparation.tokensBefore,
            details: { customizer: "rag-compaction-extension" },
          },
        }
      },
    )
  }
