// Shared types for the research engine (web search today; deep research later).

export interface WebSearchResult {
  /** Page title. */
  title: string
  /** Canonical URL of the result. */
  url: string
  /** Description + any extra snippets, joined into one blurb. */
  snippet: string
  /** Brave's freshness hint (e.g. "2 days ago"), when present. */
  age?: string
}
