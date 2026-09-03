import { HTTPException } from "hono/http-exception"

import config from "@/config"
import {
  getActualNameFromEnum,
  getModelValueFromLabel,
} from "@/platform/ai/modelConfig"
import { Models, type ConverseResponse } from "@/platform/ai/types"
import { db } from "@/platform/db/client"
import {
  getAllFolderIds,
  getRecordBypath,
} from "@/platform/db/knowledgeBase"
import { getUserAndWorkspaceByEmail } from "@/platform/db/user"
import { searchCollectionRAG } from "@/platform/search/vespa"
import { Apps, KnowledgeBaseEntity } from "@/platform/shared/types"
import type { Citation, ImageCitation } from "@/platform/shared/chat/types"
import { splitGroupedCitationsWithSpaces } from "@/utils"
import type { Span } from "@/tracer"
import type { UserMetadataType } from "@/types"
import {
  snippetForChunk,
  titleOf,
  topChunkIndices,
  truncate,
} from "../pi-mono/tools/vespa/util"
import { baseLogger } from "../log"

const Logger = baseLogger("backendv2/non-agentic-ask")

const { defaultBestModel, maxDefaultSummary, maxChunksPerPage } = config

type Hit = {
  relevance?: number
  fields?: Record<string, unknown>
}

export type Message = { role: string; content: Array<{ text: string }> }

type LiteLLMMessage = {
  role: "system" | "user" | "assistant"
  content: string
}

export type NonAgenticAskParams = {
  email: string
  workspaceExternalId: string
  message: string
  path?: string
  modelId?: string
  reasoning?: boolean
  agentPrompt?: string
  passedSpan?: Span
  /** Prior turns for a continued conversation; omitted/empty for a fresh one. */
  messages?: Message[]
  /** External cancel signal (e.g. from ChatService.beginNonAgenticRun), combined
   *  with each LLM call's own timeout so interrupt() actually stops generation. */
  signal?: AbortSignal
}

/** Combines a per-call timeout with an optional external cancel signal, so
 *  aborting mid-stream actually stops the fetch instead of being a no-op. */
const combinedSignal = (timeoutMs: number, external?: AbortSignal): AbortSignal =>
  external
    ? AbortSignal.any([AbortSignal.timeout(timeoutMs), external])
    : AbortSignal.timeout(timeoutMs)

export type NonAgenticAskResult = {
  answer: string
  citations: Citation[]
  citationMap: Record<number, number>
  imageCitations: ImageCitation[]
  thinking?: string
  modelId: string
}

export type NonAgenticAskStreamEvent =
  | { kind: "delta"; text: string }
  | { kind: "reasoning_delta"; text: string }
  | { kind: "citation"; index: number; item: Citation }
  | { kind: "image_citation"; item: ImageCitation }
  | { kind: "done"; result: NonAgenticAskResult }

const textToCitationIndex = /\[(\d+)\]/g
const textToImageCitationIndex = /(?!)/g
const textToChunkCitationIndex = /[K[(]+(\d+_\d+)[\])]/g
const textToChunkCitationIndexWithDocKey =
  /(?:K[(]+|[(]+K|[(]+(?=\d))([A-Za-z0-9_-]+)_([0-9]+)[\])]/g

const safeDecodeURIComponent = (str: string): string => {
  try {
    return decodeURIComponent(str)
  } catch {
    return str
  }
}

const getDateForAI = ({ userTimeZone }: { userTimeZone: string }): string =>
  new Date().toLocaleString("en-US", { timeZone: userTimeZone })

export function cleanBuffer(buffer: string): string {
  let parsableBuffer = buffer
  parsableBuffer = parsableBuffer.replace(/^```(?:json)?[\s\n]*/i, "")
  return parsableBuffer.trim()
}

const searchToCitation = (hit: Hit): Citation => {
  const fields = hit.fields ?? {}
  const docId = typeof fields["docId"] === "string" ? fields["docId"] : ""
  const title = titleOf({
    title: fields["title"] as string | undefined,
    fileName: fields["fileName"] as string | undefined,
    docId,
  })
  const citation: Citation = {
    docId,
    title,
    app: Apps.KnowledgeBase,
    entity: KnowledgeBaseEntity.File,
  }
  const clId = typeof fields["clId"] === "string" ? fields["clId"] : ""
  const itemId = typeof fields["itemId"] === "string" ? fields["itemId"] : ""
  const pageTitle =
    typeof fields["pageTitle"] === "string" ? fields["pageTitle"] : ""
  if (clId) {
    citation.clId = clId
    citation.url = `/cl/${clId}`
  }
  if (itemId) citation.itemId = itemId
  if (pageTitle) citation.page_title = pageTitle
  return citation
}

/** Strips the model's inline `[index]`/`K[index_chunk]` citation markers from
 *  the displayed answer — sources are already returned separately via
 *  `citations`/`citationMap`, so the markers are internal-only bookkeeping,
 *  not part of the user-facing markdown. */
export const processMessage = (text: string): string => {
  if (!text) return ""

  let processed = splitGroupedCitationsWithSpaces(text)
  processed = processed.replace(textToCitationIndex, "")
  processed = processed.replace(textToChunkCitationIndex, "")

  // Tidy whitespace left behind by removed markers (e.g. "stated [1]." -> "stated .").
  return processed
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

const markdownRepairSuffix = (text: string): string => {
  const fenceMatches = text.match(/```/g) ?? []
  if (fenceMatches.length % 2 === 0) {
    return ""
  }

  const suffixParts: string[] = []
  const trimmed = text.trimEnd()
  if (/\{\s*$/u.test(trimmed)) {
    suffixParts.push("\n}")
  }
  suffixParts.push("\n```")
  return suffixParts.join("")
}

const finalizeMarkdown = (text: string): string => {
  if (!text) return ""
  return `${text}${markdownRepairSuffix(text)}`.trim()
}

const checkAndYieldCitations = function* (
  textInput: string,
  yieldedCitations: Set<number>,
  results: Hit[],
  baseIndex: number = 0,
  email: string,
  yieldedImageCitations: Set<number>,
  allowChunkCitations?: boolean,
): Generator<{
  citation?: { index: number; item: Citation }
  imageCitation?: ImageCitation
}> {
  const text = splitGroupedCitationsWithSpaces(textInput)
  let match
  let imgMatch
  let chunkMatch
  let chunkDocKeyMatch

  textToCitationIndex.lastIndex = 0
  textToImageCitationIndex.lastIndex = 0
  textToChunkCitationIndex.lastIndex = 0
  textToChunkCitationIndexWithDocKey.lastIndex = 0

  while (true) {
    match = textToCitationIndex.exec(text)
    if (match) {
      const citationIndex = parseInt(match[1] ?? "", 10)
      if (!yieldedCitations.has(citationIndex)) {
        const item = results[citationIndex - baseIndex]
        if (item) {
          yield {
            citation: {
              index: citationIndex,
              item: searchToCitation(item),
            },
          }
          yieldedCitations.add(citationIndex)
        } else {
          Logger.error(
            { email, citationIndex, resultsLength: results.length },
            "Found a citation but could not map it to a search result",
          )
        }
      }
      continue
    }

    imgMatch = textToImageCitationIndex.exec(text)
    if (imgMatch) {
      const parts = imgMatch[1]?.split("_") ?? []
      if (parts.length >= 2) {
        const docIndex = parseInt(parts[0] ?? "", 10)
        const citationIndex = docIndex + baseIndex
        if (!yieldedImageCitations.has(citationIndex)) {
          yieldedImageCitations.add(citationIndex)
        }
      }
      continue
    }

    if (allowChunkCitations) {
      chunkMatch = textToChunkCitationIndex.exec(text)
      if (chunkMatch) {
        const citationIndex = parseInt(
          chunkMatch[1]?.split("_")[0] ?? "",
          10,
        )
        if (!yieldedCitations.has(citationIndex)) {
          const item = results[citationIndex - baseIndex]
          if (item) {
            yield {
              citation: {
                index: citationIndex,
                item: searchToCitation(item),
              },
            }
            yieldedCitations.add(citationIndex)
          } else {
            Logger.error(
              { email, citationIndex, resultsLength: results.length },
              "Found a chunk citation but could not map it to a search result",
            )
          }
        }
        continue
      }

      chunkDocKeyMatch = textToChunkCitationIndexWithDocKey.exec(text)
      if (chunkDocKeyMatch) {
        const docKey = chunkDocKeyMatch[1] ?? ""
        let citationIndex: number | null
        if (/^\d+$/.test(docKey)) {
          citationIndex = parseInt(docKey, 10)
        } else {
          const docPos = results.findIndex((r) => {
            const fields = r.fields ?? {}
            return fields["docId"] === docKey
          })
          citationIndex = docPos >= 0 ? baseIndex + docPos : null
        }

        if (
          citationIndex === null ||
          Number.isNaN(citationIndex) ||
          citationIndex < 0
        ) {
          Logger.warn(
            { email, rawChunkKey: docKey },
            "[checkAndYieldCitations] Found KB citation but could not resolve numeric index",
          )
          continue
        }

        if (!yieldedCitations.has(citationIndex)) {
          const item = results[citationIndex - baseIndex]
          if (item) {
            yield {
              citation: {
                index: citationIndex,
                item: searchToCitation(item),
              },
            }
            yieldedCitations.add(citationIndex)
          }
        }
        continue
      }
    }

    break
  }
}

const cleanContext = (text: string): string =>
  text
    .replace(/<\/?hi>/g, "")
    .replace(/\s+/g, " ")
    .replace(/[….]{2,}/g, " ")
    // eslint-disable-next-line no-control-regex -- deliberately strips raw control chars
    .replace(/[\x00-\x1F\x7F-\x9F]/g, "")
    .replace(/[\uE907\uFFFD]/g, "")
    .trim()

const answerContextMap = (
  searchResult: Hit,
  maxSummaryChunks?: number,
  _allowChunkCitations?: boolean,
): string => {
  const fields = searchResult.fields ?? {}
  const docId = typeof fields["docId"] === "string" ? fields["docId"] : ""
  const fileName =
    typeof fields["fileName"] === "string"
      ? fields["fileName"]
      : titleOf({
          title: fields["title"] as string | undefined,
          fileName: fields["fileName"] as string | undefined,
          docId,
        })
  const mimeType =
    typeof fields["mimeType"] === "string" ? fields["mimeType"] : "N/A"
  const app = typeof fields["app"] === "string" ? fields["app"] : Apps.KnowledgeBase
  let chunks = topChunkIndices(
    fields,
    maxSummaryChunks ?? maxDefaultSummary,
  )
  if (chunks.length === 0) {
    const summary = fields["chunks_summary"]
    const fallbackCount = Math.min(
      maxSummaryChunks ?? maxDefaultSummary,
      Array.isArray(summary) ? summary.length : 0,
    )
    chunks = Array.from({ length: fallbackCount }, (_, index) => ({
      index,
      score: 0,
    }))
  }
  const content = chunks
    .map((v) => {
      const chunk = snippetForChunk(fields, v.index)
      if (!chunk) return ""
      return chunk
    })
    .filter(Boolean)
    .map((v) => truncate(v, 2500))
    .join("\n")

  return `Title: ${fileName || "N/A"}
  App: ${app}
  Mime Type: ${mimeType}
  ${content ? `Content: ${content}` : ""}`
}

const buildContext = (
  results: Hit[],
  maxSummaryCount: number | undefined,
  startIndex: number,
  chunksPerDoc: number[],
  allowChunkCitations?: boolean,
): string => {
  const contexts = results.map((v, i) => {
    const content = answerContextMap(
      v,
      i < chunksPerDoc.length
        ? chunksPerDoc[i]
        : (maxSummaryCount ?? maxDefaultSummary),
      allowChunkCitations,
    )
    return `Index ${String(i + startIndex)} \n ${content}`
  })
  return cleanContext(contexts.join("\n"))
}

const chunkCountPerDoc = (searchResults: Hit[], topN: number): number[] => {
  if (searchResults.length === 0) return []
  const chunksPerDoc = Math.max(1, Math.ceil(topN / searchResults.length))
  return searchResults.map((result) => {
    const chunks = result.fields?.["chunks_summary"]
    const chunkCount = Array.isArray(chunks) ? chunks.length : chunksPerDoc
    return Math.min(chunksPerDoc, chunkCount)
  })
}

const liteLLMHistoryMessages = (messages?: Message[]): LiteLLMMessage[] =>
  (messages ?? [])
    .slice(-12)
    .flatMap((message): LiteLLMMessage[] => {
      const role = message.role === "assistant" ? "assistant" : "user"
      const content = message.content
        .map((part) => part.text)
        .join("\n")
        .trim()
      return content ? [{ role, content }] : []
    })

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const answerStartIndex = (text: string, query: string): number => {
  const trimmed = text.trimStart()
  const leadingWhitespace = text.length - trimmed.length
  const possiblePreamblePrefixes = [
    "the",
    "the user",
    "user",
    "i",
    "i need",
    "i should",
    "we",
    "we need",
    "let",
    "let's",
    "based",
    "based on",
    "the question",
    "this asks",
    "1",
    "1.",
  ]
  if (
    trimmed.length < 160 &&
    possiblePreamblePrefixes.some((prefix) =>
      prefix.startsWith(trimmed.toLowerCase()) ||
      trimmed.toLowerCase().startsWith(prefix),
    )
  ) {
    return -1
  }

  const leakedPreamble = /^(?:the user|user|i need|i should|we need|let's|based on|the question|this asks|\d+\.\s+\*\*(?:analy[sz]e|draft|review|final polish))\b/i
  if (!leakedPreamble.test(trimmed)) {
    return leadingWhitespace
  }

  const headingMatches = [...text.matchAll(/#{1,3}\s+Dynamic Routing\b/giu)]
  const headingMatch = headingMatches.at(-1)
  if (headingMatch) {
    return headingMatch.index
  }

  const subject = query
    .replace(/^what\s+is\s+/i, "")
    .replace(/^explain\s+/i, "")
    .replace(/[?.!]\s*$/u, "")
    .trim()
  const candidates = [
    subject ? `${subject} is` : "",
    "dynamic routing is",
    "juspay dynamic routing",
    "in juspay",
    "## ",
    "### ",
  ].filter(Boolean)

  const finalDraftIndex = Math.max(
    text.toLowerCase().lastIndexOf("let me structure"),
    text.toLowerCase().lastIndexOf("let me craft"),
    text.toLowerCase().lastIndexOf("final answer"),
    text.toLowerCase().lastIndexOf("final polish"),
    text.toLowerCase().lastIndexOf("*refining for markdown"),
    text.toLowerCase().lastIndexOf("drafting the response"),
  )
  if (finalDraftIndex < 0) {
    return -1
  }
  const minimumIndex = Math.max(160, finalDraftIndex)
  let bestIndex = -1
  for (const candidate of candidates) {
    const matches = [...text.matchAll(new RegExp(`\\b${escapeRegExp(candidate)}\\b`, "gi"))]
    const match = matches.at(-1)
    if (
      match &&
      match.index > minimumIndex &&
      (bestIndex < 0 || match.index < bestIndex)
    ) {
      bestIndex = match.index
    }
  }
  return bestIndex
}

const answerMetaStartIndex = (text: string): number => {
  const match = /(?:\n\s*)?(?:let me refine|let me craft|final polish|draft(?:ing)? the response|review against constraints)\b/iu.exec(
    text,
  )
  return match?.index ?? -1
}

const directRAGMarkdownStream = async function* (
  userQuery: string,
  retrievedCtx: string,
  params: {
    modelId: string
    messages?: Message[]
    agentPrompt?: string
    signal?: AbortSignal
  },
): AsyncIterableIterator<ConverseResponse> {
  const baseUrl = config.LiteLLMBaseUrl?.endsWith("/v1")
    ? config.LiteLLMBaseUrl
    : `${config.LiteLLMBaseUrl ?? ""}/v1`
  const apiKey = config.LiteLLMApiKey ?? ""
  if (!config.LiteLLMBaseUrl || !apiKey) {
    throw new HTTPException(500, { message: "LLM provider not configured" })
  }

  const llmModelName = getActualNameFromEnum(params.modelId) ?? params.modelId
  const historyMessages = liteLLMHistoryMessages(params.messages)
  const systemContent = [
    params.agentPrompt ? `# Agent Instructions\n${params.agentPrompt}` : "",
    "You answer questions from retrieved knowledge-base context. " +
      "The context below is already selected and relevant. " +
      "Return only the final answer in clean GitHub-flavored Markdown. " +
      "Start directly with the answer. " +
      "Use the prior conversation turns for follow-up intent and references like 'that', 'previous', or 'it', while grounding factual claims in the retrieved context. " +
      "Do not dump the raw context. Do not mention missing context. " +
      "Cite the source document with [0] after key claims.",
  ]
    .filter(Boolean)
    .join("\n\n")
  const userContent = `Question:\n${userQuery}\n\nRetrieved context:\n${retrievedCtx}`
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- HTTP header name
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: llmModelName,
      messages: [
        { role: "system", content: systemContent },
        ...historyMessages,
        { role: "user", content: userContent },
      ],
      // eslint-disable-next-line @typescript-eslint/naming-convention -- LiteLLM/OpenAI wire field
      max_tokens: 4096,
      temperature: 0.2,
      stream: true,
    }),
    signal: combinedSignal(20 * 60 * 1000, params.signal),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    Logger.error(
      { status: res.status, body: body.slice(0, 300) },
      "non-agentic: markdown LLM call failed",
    )
    // Surface as a real error instead of silently returning — a caller-side
    // empty answer here used to be indistinguishable from "retrieval found
    // nothing", masking real failures (bad modelId, provider outage, etc.)
    // behind the generic "could not find any information" fallback message.
    throw new HTTPException(502, { message: "LLM provider request failed" })
  }

  if (!res.body) {
    return
  }

  const decoder = new TextDecoder()
  let buffer = ""
  let pendingText = ""
  let answerStarted = false
  let emittedTail = ""
  let suppressRest = false
  const reader = res.body.getReader()

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ""

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("data:")) {
        continue
      }
      const data = trimmed.slice("data:".length).trim()
      if (!data || data === "[DONE]") {
        continue
      }

      try {
        const parsed = JSON.parse(data) as {
          choices?: Array<{
            delta?: {
              content?: string | null
            }
          }>
        }
        const text = parsed.choices?.[0]?.delta?.content ?? ""
        if (!text) {
          continue
        }
        if (suppressRest) {
          continue
        }

        if (!answerStarted) {
          pendingText += text
          const startIndex = answerStartIndex(pendingText, userQuery)
          if (startIndex < 0) {
            continue
          }
          answerStarted = true
          const answerText = pendingText.slice(startIndex).replace(/^\s+/, "")
          pendingText = ""
          if (answerText) {
            const metaIndex = answerMetaStartIndex(answerText)
            const safeText =
              metaIndex >= 0 ? answerText.slice(0, metaIndex).trimEnd() : answerText
            suppressRest = metaIndex >= 0
            emittedTail = safeText.slice(-80)
            if (safeText) {
              yield { text: safeText }
            }
          }
          continue
        }

        const combinedText = `${emittedTail}${text}`
        const metaIndex = answerMetaStartIndex(combinedText)
        if (metaIndex >= 0) {
          suppressRest = true
          const safeText = combinedText.slice(0, metaIndex).slice(emittedTail.length)
          if (safeText) {
            yield { text: safeText.trimEnd() }
          }
          continue
        }

        emittedTail = combinedText.slice(-80)
        yield { text }
      } catch {
        Logger.debug({ data: data.slice(0, 200) }, "Skipping malformed LLM SSE frame")
      }
    }
  }

  if (!answerStarted && pendingText.trim()) {
    yield { text: pendingText.trimStart() }
  }
}

async function* generateAnswerFromGivenContext(
  input: string,
  email: string,
  _userMetadata: UserMetadataType,
  _alpha: number = 0.5,
  fileIds: string[],
  agentPrompt?: string,
  passedSpan?: Span,
  _threadIds?: string[],
  _attachmentFileIds?: string[],
  allowChunkCitations?: boolean,
  modelId?: string,
  isValidPath?: boolean,
  folderIds?: string[],
  messages: Message[] = [],
  signal?: AbortSignal,
): AsyncGenerator<
  ConverseResponse & {
    citation?: { index: number; item: Citation }
    imageCitation?: ImageCitation
  },
  void
> {
  const message = input
  const messageText = message

  const generateAnswerSpan = passedSpan?.startSpan(
    "generateAnswerFromGivenContext",
  )

  const previousResultsLength = 0
  const combinedSearchResponse: Hit[] = []
  let chunksPerDocument: number[] = []
  const targetChunks = maxChunksPerPage

  // TODO(interrupt-retrieval): the external abort `signal` is only threaded into
  // the LLM generation call (directRAGMarkdownStream). The Vespa retrieval below
  // (searchCollectionRAG) doesn't receive it, so interrupting during the
  // retrieval phase is a no-op until generation starts. Thread `signal` into
  // searchCollectionRAG (or check `signal?.aborted` before generating) to make
  // interrupt cover retrieval too.
  if (fileIds.length > 0 || (folderIds && folderIds.length > 0)) {
    allowChunkCitations = true
    const fileSearchSpan = generateAnswerSpan?.startSpan("file_search")
    if (isValidPath) {
      const results = folderIds?.length
        ? await searchCollectionRAG(messageText, undefined, folderIds)
        : await searchCollectionRAG(messageText, fileIds, undefined)
      if (results.root.children) {
        combinedSearchResponse.push(...((results.root.children ?? []) as Hit[]))
      }
    }

    chunksPerDocument = chunkCountPerDoc(combinedSearchResponse, targetChunks)
    fileSearchSpan?.end()
  }

  const startIndex = config.isReasoning ? previousResultsLength : 0
  const initialContext = buildContext(
    combinedSearchResponse,
    maxDefaultSummary,
    startIndex,
    chunksPerDocument,
    allowChunkCitations,
  )

  const contextWithoutImageBlocks = initialContext

  const initialContextSpan = generateAnswerSpan?.startSpan("initialContext")
  initialContextSpan?.setAttribute(
    "context_length",
    contextWithoutImageBlocks?.length || 0,
  )
  initialContextSpan?.setAttribute("context", contextWithoutImageBlocks || "")
  initialContextSpan?.setAttribute(
    "number_of_chunks",
    combinedSearchResponse?.length || 0,
  )
  initialContextSpan?.end()

  Logger.info(
    { email, count: combinedSearchResponse.length },
    "[Selected Context Path] Number of contextual chunks being passed",
  )

  if (contextWithoutImageBlocks && combinedSearchResponse.length > 0) {
    let directAnswer = ""
    for await (const chunk of directRAGMarkdownStream(message, contextWithoutImageBlocks, {
      modelId: modelId || defaultBestModel,
      messages,
      ...(agentPrompt ? { agentPrompt } : {}),
      ...(signal ? { signal } : {}),
    })) {
      if (chunk.text) {
        directAnswer += chunk.text
      }
      yield chunk
    }
    if (directAnswer) {
      const repairSuffix = markdownRepairSuffix(directAnswer)
      if (repairSuffix) {
        directAnswer += repairSuffix
        yield { text: repairSuffix }
      }
      yield* checkAndYieldCitations(
        directAnswer,
        new Set<number>(),
        combinedSearchResponse,
        previousResultsLength,
        email,
        new Set<number>(),
        allowChunkCitations,
      )
      generateAnswerSpan?.setAttribute("answer_found", true)
      generateAnswerSpan?.setAttribute("answer_source", "direct_markdown")
      generateAnswerSpan?.end()
      return
    }
  }

  // One LLM attempt only — matches upstream's single-call design (no
  // JSON-mode retry chain). If it doesn't produce an answer, give up with a
  // static message instead of trying again with a different prompt/format.
  const noAnswerSpan = generateAnswerSpan?.startSpan("no_answer_response")
  yield {
    text: "From the selected context, I could not find any information to answer it, please change your query",
  }
  noAnswerSpan?.end()
  generateAnswerSpan?.end()
}

export async function* UnderstandMessageAndAnswerForGivenContext(
  email: string,
  userMetadata: UserMetadataType,
  message: string,
  alpha: number,
  fileIds: string[],
  userRequestsReasoningAndEnabled: boolean,
  passedSpan?: Span,
  threadIds?: string[],
  attachmentFileIds?: string[],
  agentPrompt?: string,
  allowChunkCitations?: boolean,
  modelId?: string,
  isValidPath?: boolean,
  folderIds?: string[],
  messages: Message[] = [],
  signal?: AbortSignal,
): AsyncGenerator<
  ConverseResponse & {
    citation?: { index: number; item: Citation }
    imageCitation?: ImageCitation
  },
  void
> {
  passedSpan?.setAttribute("email", email)
  passedSpan?.setAttribute("message", message)
  passedSpan?.setAttribute("alpha", alpha)
  passedSpan?.setAttribute("fileIds", JSON.stringify(fileIds))
  passedSpan?.setAttribute("fileIds_count", fileIds?.length)
  passedSpan?.setAttribute("threadIds", JSON.stringify(threadIds))
  passedSpan?.setAttribute("threadIds_count", threadIds?.length || 0)
  passedSpan?.setAttribute(
    "userRequestsReasoningAndEnabled",
    userRequestsReasoningAndEnabled || false,
  )

  return yield* generateAnswerFromGivenContext(
    message,
    email,
    userMetadata,
    alpha,
    fileIds,
    agentPrompt,
    passedSpan,
    threadIds,
    attachmentFileIds,
    allowChunkCitations,
    modelId,
    isValidPath,
    folderIds,
    messages,
    signal,
  )
}

export const answerNonAgentic = async (
  params: NonAgenticAskParams,
): Promise<NonAgenticAskResult> => {
  let result: NonAgenticAskResult | undefined
  for await (const event of streamNonAgenticAnswer(params)) {
    if (event.kind === "done") {
      result = event.result
    }
  }
  if (!result) {
    throw new Error("Non-agentic answer stream ended without a final result")
  }
  return result
}

export async function* streamNonAgenticAnswer(
  params: NonAgenticAskParams,
): AsyncIterableIterator<NonAgenticAskStreamEvent> {
  const { email, workspaceExternalId, modelId, reasoning, passedSpan } = params
  const message = safeDecodeURIComponent(params.message)

  const userAndWorkspace = await getUserAndWorkspaceByEmail(
    db,
    workspaceExternalId,
    email,
  )
  const { user, workspace } = userAndWorkspace
  const userTimezone = user?.timeZone || "Asia/Kolkata"
  const dateForAI = getDateForAI({ userTimeZone: userTimezone })
  const userMetadata: UserMetadataType = {
    userTimezone,
    dateForAI,
    userId: user.id,
    workspaceId: workspace.id,
  }

  // Resolve a friendly model label / raw enum value, falling back to default.
  let actualModelId: string | undefined = undefined
  if (modelId) {
    const converted = getModelValueFromLabel(modelId)
    if (converted) {
      actualModelId = converted
    } else if (Object.values(Models).includes(modelId as Models)) {
      actualModelId = modelId
    } else {
      actualModelId = modelId
    }
  }
  const resolvedModelId = actualModelId || config.defaultBestModel

  // Scope retrieval to a KB path when provided. File filters use Vespa docId,
  // while folder filters use DB item ids because file docs store their direct
  // parent folder in Vespa's clFd field.
  let isValidPath = false
  let fileIds: string[] = []
  let folderIds: string[] = []
  if (params.path) {
    const pathItem = await getRecordBypath(params.path, db, email)
    if (!pathItem) {
      throw new HTTPException(400, {
        message: `The given path: ${params.path} is not a valid collection folder or file`,
      })
    }
    if (pathItem.type === "folder") {
      const subFolderIds = await getAllFolderIds([pathItem.id], db)
      folderIds = [...new Set([pathItem.id, ...subFolderIds])]
    } else if (pathItem.type === "file" && pathItem.vespaDocId) {
      fileIds = [pathItem.vespaDocId]
    } else {
      throw new HTTPException(400, {
        message: `The path '${params.path}' must point to a collection folder or file (collection-root paths are not supported)`,
      })
    }
    isValidPath = true
  }

  const userRequestsReasoningAndEnabled =
    Boolean(reasoning) && config.isReasoning

  const iterator = UnderstandMessageAndAnswerForGivenContext(
    email,
    userMetadata,
    message,
    0.5,
    fileIds,
    userRequestsReasoningAndEnabled,
    passedSpan,
    [],
    [],
    params.agentPrompt,
    isValidPath, // allowChunkCitations
    resolvedModelId,
    isValidPath,
    folderIds,
    params.messages ?? [],
    params.signal,
  )

  let answer = ""
  let thinking = ""
  const citations: Citation[] = []
  const citationMap: Record<number, number> = {}
  const imageCitations: ImageCitation[] = []

  for await (const chunk of iterator) {
    if (chunk.text) {
      if (chunk.reasoning) {
        thinking += chunk.text
        yield { kind: "reasoning_delta", text: chunk.text }
      } else {
        answer += chunk.text
        yield { kind: "delta", text: chunk.text }
      }
    }
    if (chunk.citation) {
      const { index, item } = chunk.citation
      citations.push(item)
      citationMap[index] = citations.length - 1
      yield { kind: "citation", index, item }
    }
    if (chunk.imageCitation) {
      imageCitations.push(chunk.imageCitation)
      yield { kind: "image_citation", item: chunk.imageCitation }
    }
  }

  const finalAnswer = finalizeMarkdown(processMessage(answer))
  passedSpan?.setAttribute("answer_length", finalAnswer.length)
  passedSpan?.setAttribute("citation_count", citations.length)

  yield {
    kind: "done",
    result: {
      answer: finalAnswer,
      citations,
      citationMap,
      imageCitations,
      ...(thinking ? { thinking } : {}),
      modelId: resolvedModelId,
    },
  }
}
