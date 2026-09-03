// Post-stream LLM pass that suggests 0-5 follow-up questions. One-shot
// LiteLLM call, JSON out — same lightweight shape as `title/generate.ts`.

import { parse as parsePartialJson } from "partial-json"
import { z } from "zod"

import {
  getActualNameFromEnum,
  getModelConfiguration,
} from "@/platform/ai/modelConfig"
import config from "@/config"

import { baseLogger, type Log } from "../log"

const Logger = baseLogger("backendv2/follow-ups")

export const FollowUpsSchema = z.object({
  // snake_case matches the JSON the LLM emits (the prompt's contract).
  // eslint-disable-next-line @typescript-eslint/naming-convention
  follow_up_questions: z.array(z.string().min(1).max(140)).max(5),
})

export type FollowUps = z.infer<typeof FollowUpsSchema>

const SYSTEM_PROMPT = [
  "You suggest follow-up questions a user might naturally ask next, after",
  "they just received an answer to a question. Output strict JSON only.",
  "",
  "Shape: {\"follow_up_questions\": string[]} with 0-5 entries.",
  "",
  "RETURN AN EMPTY ARRAY when the exchange was any of:",
  "- A greeting, salutation, or small-talk (\"hi\", \"hello\", \"thanks\",",
  "  \"how are you\", \"what's up\"). The assistant's reply will also be",
  "  social rather than informational. Always [].",
  "- An acknowledgement (\"thanks\", \"got it\", \"ok\", \"cool\").",
  "- A simple yes/no answer with no natural drill-down.",
  "- A trivial single-fact answer (a definition, a single number, a date)",
  "  that doesn't open onto a broader topic.",
  "",
  "DO STILL SUGGEST chips when the assistant said it couldn't fully",
  "answer (\"the corpus doesn't include X\", \"I don't have access to Y\")",
  "but the topic is substantive and the user clearly has more to ask —",
  "suggest adjacent / related questions the assistant CAN help with.",
  "",
  "OTHERWISE, when the answer was substantive, suggest 1-5 questions",
  "following these rules:",
  "1. STAND-ALONE — each question must read clearly on its own as a chip.",
  "   Include the noun explicitly (\"the cache eviction policy\", never",
  "   \"its policy\"). Avoid bare pronouns like \"this\", \"that\".",
  "2. PHRASED AS A QUESTION the user would actually type. Not a section",
  "   header, not a command, not a topic.",
  "3. CONCISE — at most 14 words.",
  "4. DIFFERENT ANGLES — drill-down, alternative, edge case, or related",
  "   concern. Don't restate the same thread three ways.",
  "5. NEVER suggest a question whose answer was already in the assistant's",
  "   reply.",
  "",
  "Examples of when to return []:",
  "- User: \"hi\" / Assistant: \"Hey! How can I help?\" → []",
  "- User: \"thanks!\" / Assistant: \"You're welcome.\" → []",
  "- User: \"what's 2+2\" / Assistant: \"4.\" → []",
  "",
  "Examples of when to suggest chips even though the assistant couldn't",
  "fully answer:",
  "- User asks about a topic the knowledge base doesn't cover; the",
  "  assistant says it only holds documents on a related area. Good chips:",
  "  questions about what those available documents DO cover that stay",
  "  close to the user's intent.",
  "- User asks for something outside scope; assistant explains its limits.",
  "  Good chips: \"Where in the docs is the auth flow described?\",",
  "  \"Which internal services expose a Python SDK?\".",
  "",
  "Output only the JSON object. No prose, no markdown, no commentary.",
].join("\n")

const MAX_SNIPPET = 4000

const truncate = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n - 1)}…`

export async function generateFollowUps(params: {
  userQuestion: string
  assistantAnswer: string
  logger?: Log
  /** Cancels the call when the conversation moves on (user sent a new
   *  message). Combined with the internal timeout. */
  signal?: AbortSignal
}): Promise<FollowUps | null> {
  const logger = params.logger ?? Logger

  const baseUrl = config.LiteLLMBaseUrl?.endsWith("/v1")
    ? config.LiteLLMBaseUrl
    : `${config.LiteLLMBaseUrl ?? ""}/v1`
  const apiKey = config.LiteLLMApiKey ?? ""
  if (!baseUrl || !apiKey) {
    logger.warn("follow-ups: LiteLLM not configured; skipping")
    return null
  }

  // Override via LITELLM_FOLLOWUP_MODEL, else the fast model. (The fast
  // model here is Nemotron — a reasoner — hence "thinking off" below.)
  const followUpEnv = process.env["LITELLM_FOLLOWUP_MODEL"]
  const modelId = (followUpEnv ||
    config.defaultFastModel ||
    config.defaultBestModel) as typeof config.defaultFastModel
  const llmModelName = getActualNameFromEnum(modelId) ?? modelId
  const cfg = getModelConfiguration(modelId)
  if (!cfg) {
    logger.warn({ modelId }, "follow-ups: no model configuration; skipping")
    return null
  }

  const userPayload = [
    "Conversation so far:",
    "",
    `User: ${truncate(params.userQuestion, MAX_SNIPPET)}`,
    "",
    `Assistant: ${truncate(params.assistantAnswer, MAX_SNIPPET)}`,
    "",
    "Generate the JSON object now.",
  ].join("\n")

  const startedAt = Date.now()
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: llmModelName,
        messages: [
          {
            role: "system",
            // Nemotron's toggle to skip chain-of-thought; without it the
            // model spends the whole budget thinking and emits no JSON.
            // No-op for models that don't recognise it.
            content: `detailed thinking off\n\n${SYSTEM_PROMPT}`,
          },
          { role: "user", content: userPayload },
        ],
        // High enough that reasoning overhead doesn't starve the JSON
        // output — 512 was empirically too low (truncated / empty).
        // eslint-disable-next-line @typescript-eslint/naming-convention
        max_tokens: 4096,
        temperature: 0.3,
        stream: false,
        // eslint-disable-next-line @typescript-eslint/naming-convention
        response_format: { type: "json_object" },
      }),
      // Reasoning models can take 20-30s; headroom before timing out. Also
      // abort early if the caller cancels (conversation moved on).
      signal: params.signal
        ? AbortSignal.any([params.signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      logger.warn(
        { status: res.status, body: body.slice(0, 300) },
        "follow-ups: LiteLLM rejected the request",
      )
      return null
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>
    }
    const raw = json.choices?.[0]?.message?.content ?? ""
    if (!raw.trim()) {
      logger.warn("follow-ups: model returned empty content")
      return null
    }

    // partial-json recovers questions from a truncated array; the schema
    // check below drops any incomplete trailing entry.
    let parsed: unknown
    try {
      parsed = parsePartialJson(raw)
    } catch (err) {
      logger.warn(
        { err, snippet: raw.slice(0, 200) },
        "follow-ups: model output was not valid JSON",
      )
      return null
    }

    const result = FollowUpsSchema.safeParse(parsed)
    if (!result.success) {
      logger.warn(
        { err: result.error.message, snippet: raw.slice(0, 200) },
        "follow-ups: model output failed schema validation",
      )
      return null
    }
    logger.info(
      {
        model: llmModelName,
        ms: Date.now() - startedAt,
        count: result.data.follow_up_questions.length,
      },
      "follow-ups: generated",
    )
    return result.data
  } catch (err) {
    logger.warn({ err }, "follow-ups: generation failed")
    return null
  }
}
