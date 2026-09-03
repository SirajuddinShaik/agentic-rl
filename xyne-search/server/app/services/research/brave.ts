// Brave Search API client. Lifted from xyne-claw-shared's web-search tool but
// returns STRUCTURED results (WebSearchResult[]) instead of a pre-formatted
// string, so callers (chat + workflow tool adapters) own their own formatting.

import config from "@/config"
import type { WebSearchResult } from "./types"

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search"
const WEB_SEARCH_TIMEOUT_MS = 30_000

// Field names mirror Brave's API response verbatim.
/* eslint-disable @typescript-eslint/naming-convention */
interface BraveWebResult {
  title: string
  url: string
  description: string
  page_age?: string
  extra_snippets?: string[]
}
/* eslint-enable @typescript-eslint/naming-convention */

interface BraveResponse {
  web?: { results?: BraveWebResult[] }
}

/** Thrown for any web-search failure; adapters convert it to a model-readable error. */
export class WebSearchError extends Error {
  override readonly name = "WebSearchError"
}

export interface BraveSearchOptions {
  /** Number of results to request (Brave default cap applies). */
  count?: number
  /** Caller abort signal — composed with the internal 30s timeout. */
  signal?: AbortSignal
}

function braveApiKey(): string {
  return config.braveSearchApiKey || process.env["BRAVE_SEARCH_API_KEY"] || ""
}

/** Whether web search is configured (used to gate tool registration). */
export function isWebSearchConfigured(): boolean {
  return braveApiKey().length > 0
}

export async function braveWebSearch(
  query: string,
  opts: BraveSearchOptions = {},
): Promise<WebSearchResult[]> {
  const q = query.trim()
  if (!q) throw new WebSearchError("query is required")

  const apiKey = braveApiKey()
  if (!apiKey) throw new WebSearchError("BRAVE_SEARCH_API_KEY is not configured")

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), WEB_SEARCH_TIMEOUT_MS)
  const onAbort = (): void => controller.abort()
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort()
    else opts.signal.addEventListener("abort", onAbort, { once: true })
  }

  try {
    const url = new URL(BRAVE_SEARCH_URL)
    url.searchParams.set("q", q)
    url.searchParams.set("count", String(opts.count ?? 20))

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        // eslint-disable-next-line @typescript-eslint/naming-convention -- HTTP header names
        "Accept-Encoding": "gzip",
        // eslint-disable-next-line @typescript-eslint/naming-convention -- HTTP header names
        "X-Subscription-Token": apiKey,
      },
      signal: controller.signal,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      if (res.status === 401) {
        throw new WebSearchError(
          "Brave Search authentication failed — check BRAVE_SEARCH_API_KEY",
        )
      }
      if (res.status === 429) {
        throw new WebSearchError("Brave Search rate limit exceeded — try again later")
      }
      if (res.status >= 500) {
        throw new WebSearchError(`Brave Search server error ${res.status}`)
      }
      throw new WebSearchError(`Brave Search returned status ${res.status}: ${body}`)
    }

    const data = (await res.json()) as BraveResponse
    const results = data.web?.results ?? []

    return results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: [r.description, ...(r.extra_snippets ?? [])].filter(Boolean).join(" "),
      ...(r.page_age ? { age: r.page_age } : {}),
    }))
  } catch (err) {
    if (err instanceof WebSearchError) throw err
    if (err instanceof Error && err.name === "AbortError") {
      throw new WebSearchError("Web search timed out after 30 seconds")
    }
    throw new WebSearchError(
      err instanceof Error ? err.message : "Unknown web search error",
    )
  } finally {
    clearTimeout(timeoutId)
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort)
  }
}
