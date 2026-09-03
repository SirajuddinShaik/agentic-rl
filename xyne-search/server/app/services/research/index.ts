// Research engine — single source of truth shared by the chat + workflow tool
// adapters. Web search today; a `deep-research.ts` will land beside it later.

export { webSearch, formatWebResults } from "./web-search"
export type { WebSearchResponse } from "./web-search"
export { braveWebSearch, isWebSearchConfigured, WebSearchError } from "./brave"
export type { BraveSearchOptions } from "./brave"
export type { WebSearchResult } from "./types"
export { deepResearch, isDeepResearchConfigured, DeepResearchError } from "./deep-research"
export type { DeepResearchOptions, DeepResearchResult } from "./deep-research"
