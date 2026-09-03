// Pre-flight stage: two parallel LLM passes before the main pi-mono turn, folded
// in as one non-persisted <system-reminder>.
//   • Relevance — name relevant skills + recap context (1-2 lines).
//   • Decompose — for large/multi-part requests, emit an ordered sub-problem list.
// Gated by a size/complexity heuristic so trivial messages skip both calls.
// Best-effort: any failure yields "" and the main turn proceeds normally.

import { getActualNameFromEnum, getModelConfiguration } from "@/platform/ai/modelConfig"
import config from "@/config"

import { baseLogger, type Log } from "../log"

const Logger = baseLogger("backendv2/preflight")

export type PreflightSkill = {
  alias: string
  name: string
  description: string
}

export type PreflightArgs = {
  userMessage: string
  /** Recent turns (oldest→newest), already flattened to text. */
  history: { role: "user" | "assistant"; text: string }[]
  skills: PreflightSkill[]
  toolNames: ReadonlyArray<string>
  logger?: Log
  signal?: AbortSignal
}

const MAX_SNIPPET = 1200

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, max) + "…"

/** Gate: spend the two LLM calls only when the message looks non-trivial (long,
 *  multi-part, sequenced, or multi-question). */
export const shouldPreflight = (text: string): boolean => {
  const t = text.trim()
  if (t.length >= 200) return true
  if (/\n|;|\b(then|also|steps?|first|second|third|finally|and then)\b/i.test(t)) {
    return true
  }
  return (t.match(/\?/g)?.length ?? 0) >= 2
}

const RELEVANCE_PROMPT = [
  "You are a pre-flight assistant. Given the recent conversation and a catalog",
  "of available skills, do TWO things, tersely:",
  "1) Name which skills (by alias) are relevant to the user's latest request,",
  "   or say none are.",
  "2) Recap in 1-2 lines the prior context that matters for answering it.",
  "Output a few plain lines, no preamble. If nothing is relevant and there is",
  "no useful prior context, output exactly: NONE",
].join(" ")

const DECOMPOSE_PROMPT = [
  "You are a pre-flight planner. If the user's latest request is large or",
  "multi-part, break it into an ordered list of smaller, independently-solvable",
  "sub-problems the assistant should tackle (it may dispatch sub-agents per",
  "item). Keep items short and concrete. If the request is a single simple",
  "task, output exactly: NONE",
].join(" ")

const llmConfig = (): { baseUrl: string; apiKey: string; model: string } | null => {
  const baseUrl = config.LiteLLMBaseUrl?.endsWith("/v1")
    ? config.LiteLLMBaseUrl
    : `${config.LiteLLMBaseUrl ?? ""}/v1`
  const apiKey = config.LiteLLMApiKey ?? ""
  if (!baseUrl || !apiKey) return null
  const modelId = (process.env["PREFLIGHT_MODEL"] ||
    config.defaultFastModel ||
    config.defaultBestModel) as typeof config.defaultFastModel
  const model = getActualNameFromEnum(modelId) ?? modelId
  if (!getModelConfiguration(modelId)) return null
  return { baseUrl, apiKey, model }
}

/** One-shot LiteLLM call returning trimmed text, or "" on NONE / error. */
const callPass = async (
  systemPrompt: string,
  userPayload: string,
  logger: Log,
  signal: AbortSignal | undefined,
  label: string,
): Promise<string> => {
  const cfg = llmConfig()
  if (!cfg) {
    logger.warn(`preflight(${label}): LiteLLM not configured; skipping`)
    return ""
  }
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: `detailed thinking off\n\n${systemPrompt}` },
          { role: "user", content: userPayload },
        ],
        // eslint-disable-next-line @typescript-eslint/naming-convention
        max_tokens: 1024,
        temperature: 0.2,
        stream: false,
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      logger.warn({ status: res.status }, `preflight(${label}): LiteLLM rejected`)
      return ""
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>
    }
    const raw = (json.choices?.[0]?.message?.content ?? "").trim()
    if (!raw || /^none$/i.test(raw)) return ""
    return raw
  } catch (err) {
    logger.warn(
      { err: (err as Error)?.message },
      `preflight(${label}): call failed`,
    )
    return ""
  }
}

const historyText = (history: PreflightArgs["history"]): string =>
  history
    .slice(-6)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${truncate(m.text, 600)}`)
    .join("\n\n")

const skillsCatalog = (skills: PreflightSkill[]): string =>
  skills.length === 0
    ? "(no skills available)"
    : skills
        .map((s) => `- ${s.alias} (${s.name}): ${s.description}`)
        .join("\n")

/** Run the gated pre-flight; returns a <system-reminder> block or "". */
export const runPreflight = async (args: PreflightArgs): Promise<string> => {
  const logger = args.logger ?? Logger
  if (!shouldPreflight(args.userMessage)) return ""

  const latest = truncate(args.userMessage, MAX_SNIPPET)
  const hist = historyText(args.history)

  const relevancePayload = [
    "Conversation so far:",
    hist || "(none)",
    "",
    "Available skills:",
    skillsCatalog(args.skills),
    "",
    `Latest user request:\n${latest}`,
  ].join("\n")

  const decomposePayload = [
    hist ? `Conversation so far:\n${hist}\n` : "",
    `Latest user request:\n${latest}`,
  ].join("\n")

  const [relevance, decompose] = await Promise.all([
    callPass(RELEVANCE_PROMPT, relevancePayload, logger, args.signal, "relevance"),
    callPass(DECOMPOSE_PROMPT, decomposePayload, logger, args.signal, "decompose"),
  ])

  if (!relevance && !decompose) return ""

  const lines = ["", "<system-reminder>"]
  if (relevance) lines.push(`Relevant skills & context: ${relevance}`)
  if (decompose) {
    lines.push(
      "Suggested plan (break the work down; dispatch sub-agents where useful):",
      decompose,
    )
  }
  lines.push("The user's message above is the primary instruction.")
  lines.push("</system-reminder>")
  logger.info(
    { hasRelevance: !!relevance, hasPlan: !!decompose },
    "preflight: reminder assembled",
  )
  return lines.join("\n")
}
