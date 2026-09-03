// web search — the surface the tool adapters call. Thin wrapper over the Brave
// client, plus a shared formatter so chat and workflow render sources the same way.

import { braveWebSearch, type BraveSearchOptions } from "./brave"
import type { WebSearchResult } from "./types"

export interface WebSearchResponse {
  results: WebSearchResult[]
}

export async function webSearch(
  query: string,
  opts: BraveSearchOptions = {},
): Promise<WebSearchResponse> {
  const results = await braveWebSearch(query, opts)
  return { results }
}

/** Render results as a numbered, URL-cited block for an LLM tool result. */
export function formatWebResults(results: readonly WebSearchResult[]): string {
  if (results.length === 0) return "No web results found."
  const body = results
    .map((r, i) => {
      const age = r.age ? ` (${r.age})` : ""
      return `[${i + 1}] ${r.title}${age}\nURL: ${r.url}\n${r.snippet}`
    })
    .join("\n\n")
  return `Found ${results.length} web result(s):\n\n${body}`
}
