// Central registry of pi-mono tools available to backendv2 agents.
//
// No side effects at import time — `build` runs per-turn so each tool closes
// over the active user + optional agent scope. Tools that only apply when
// other state is present (e.g. dispatchSubagent with sub-agents) are still
// declared here but filtered by the runner before reaching pi-mono.

import { defineTool } from "@earendil-works/pi-coding-agent"

import type { AgentScope } from "../../agent-scope"
import type { Log } from "../../log"
import { buildGetChunksTool } from "./vespa/getChunks"
import { buildGetFolderTreeTool } from "./vespa/getFolderTree"
import { buildVespaSearchTool } from "./vespa/search"
import { buildDocumentSearchTool } from "./vespa/documentSearch"
import { buildProximitySearchTool } from "./vespa/proximitySearch"
import { buildSearchWithinDocTool } from "./vespa/searchWithinDoc"
import { compactForLlm } from "./llmCompact"
import { buildComputerTool } from "./computer"
import { getSandboxManager } from "@/platform/lib/sandbox/manager"

// Context every tool builder receives; subset-specific fields are optional and
// builders pick what they need.
export type ToolBuildCtx = {
  userEmail: string
  logger: Log
  /** Stateful tools key per-conversation state on this (e.g. computer sandbox REPL). */
  conversationId: string
  agentScope?: AgentScope
  /** LiteLLM config for tools that issue their own LLM calls (e.g. in-tool
   *  relevance filter). Same model as the main agent turn. */
  llm?: { model: string; baseUrl: string; apiKey: string }
  /** Lifecycle progress sink for long-running tools (e.g. sandbox); status
   *  lines are published on the SSE stream. */
  onToolProgress?: (
    toolCallId: string,
    label: string,
    level: "info" | "ok" | "error",
  ) => Promise<void> | void
}

export type ToolCategory = "retrieval" | "compute"

export type ToolDescriptor = {
  name: string
  label: string
  description: string
  category: ToolCategory
  /** Part of a brand-new agent's default tool set (see `defaultAgentToolNames`).
   *  Defaults to true; false = opt-in, user enables per agent (e.g. `computer`). */
  defaultEnabled?: boolean
  /** Runtime availability gate: returns false → tool skipped at build time even
   *  if selected, so a tool whose runtime isn't configured (e.g. sandbox without
   *  `E2B_API_KEY`) is hidden rather than exposed broken to the model. */
  available?: (ctx: ToolBuildCtx) => boolean
  build: (ctx: ToolBuildCtx) => ReturnType<typeof defineTool>
}

export const TOOL_REGISTRY: ReadonlyArray<ToolDescriptor> = [
  {
    name: "vespaSearch",
    label: "Search",
    description:
      "Unified semantic + structured search across the ingested knowledge base. " +
      "One tool for both topic/keyword discovery (pass `query`) and concrete " +
      "lookups (pass any of `documentId`, `pan`, `entities`, `references`, " +
      "`dateFrom`/`dateTo`, `folder`), or both together. Optional in-tool " +
      "LLM relevance filter via `filter` + `questionContext`.",
    category: "retrieval",
    build: (ctx) =>
      buildVespaSearchTool({
        userEmail: ctx.userEmail,
        logger: ctx.logger,
        ...(ctx.agentScope ? { agentScope: ctx.agentScope } : {}),
        ...(ctx.llm ? { llm: ctx.llm } : {}),
      }),
  },
  // Rank-profile variants of vespaSearch: same execute path, only the pinned
  // Vespa rank profile differs (the LLM never picks one). Opt-in so existing
  // agents are unaffected.
  {
    name: "documentSearch",
    label: "Document search",
    description:
      "Variant of the main search whose ranking is balanced across " +
      "filename/title, top body chunks, and AI summary, fused via Relative " +
      "Score Fusion. General-purpose default; strong on framework / " +
      "named-document questions.",
    category: "retrieval",
    defaultEnabled: false,
    build: (ctx) =>
      buildDocumentSearchTool({
        userEmail: ctx.userEmail,
        logger: ctx.logger,
        ...(ctx.agentScope ? { agentScope: ctx.agentScope } : {}),
        ...(ctx.llm ? { llm: ctx.llm } : {}),
      }),
  },
  {
    name: "proximitySearch",
    label: "Proximity search (exact string)",
    description:
      "NARROW exact-string lookup — NOT a " +
      "general-purpose search. Use only to pin a literal value that must " +
      "match verbatim in body text (circular/regulation/order/PAN/ISIN " +
      "numbers, section refs, a precise named entity or quoted phrase). For " +
      "topical / conceptual / 'find all' / title-finding questions, use " +
      "documentSearch.",
    category: "retrieval",
    defaultEnabled: false,
    build: (ctx) =>
      buildProximitySearchTool({
        userEmail: ctx.userEmail,
        logger: ctx.logger,
        ...(ctx.agentScope ? { agentScope: ctx.agentScope } : {}),
        ...(ctx.llm ? { llm: ctx.llm } : {}),
      }),
  },
  {
    name: "getFolderTree",
    label: "KB folder tree",
    description:
      "List the collection → folder tree so the agent can pick an exact " +
      "folder path to scope vespaSearch / metadataSearch with. Use before a " +
      "scoped search when the user names a folder or section.",
    category: "retrieval",
    build: (ctx) =>
      buildGetFolderTreeTool({
        logger: ctx.logger,
        ...(ctx.agentScope ? { agentScope: ctx.agentScope } : {}),
      }),
  },
  {
    name: "getChunks",
    label: "Chunk reader",
    description:
      "Read a contiguous chunk range from a specific document. Use to " +
      "expand context around a hit found by vespaSearch / metadataSearch.",
    category: "retrieval",
    build: (ctx) => buildGetChunksTool(ctx.userEmail, ctx.agentScope, ctx.logger),
  },
  {
    name: "searchWithinDoc",
    label: "Within-document search",
    description:
      "Semantic search constrained to a single docId. Use to find other " +
      "relevant passages (definitions, exceptions, cross-references) inside " +
      "a document already located.",
    category: "retrieval",
    build: (ctx) => buildSearchWithinDocTool(ctx.userEmail, ctx.agentScope, ctx.logger),
  },
  {
    name: "computer",
    label: "Computer",
    description:
      "A persistent Linux sandbox the agent drives: run shell commands, " +
      "author/read/edit files, analyse uploaded documents (PDF/DOCX/Excel/" +
      "CSV/images), and generate downloadable deliverables (Office/PDF docs, " +
      "charts, exports) using the skills at /opt/skills. Opt-in — enable per " +
      "agent. Requires the sandbox runtime (E2B) to be configured.",
    category: "compute",
    defaultEnabled: false,
    // Hidden when the sandbox runtime (E2B) isn't configured.
    available: () => getSandboxManager() !== undefined,
    build: (ctx) =>
      buildComputerTool({
        conversationId: ctx.conversationId,
        userEmail: ctx.userEmail,
        logger: ctx.logger,
        ...(ctx.onToolProgress
          ? {
              onProgress: (toolCallId, label, level): void => {
                void ctx.onToolProgress?.(toolCallId, label, level ?? "info")
              },
            }
          : {}),
      }),
  },
]

const toolByName: ReadonlyMap<string, ToolDescriptor> = new Map(
  TOOL_REGISTRY.map((t) => [t.name, t]),
)

export const getToolDescriptor = (
  name: string,
): ToolDescriptor | undefined => toolByName.get(name)

// Build tool instances for a turn. `names` is taken literally (no "[] = all"
// wildcard) — an empty array means zero tools; callers pass the explicit list
// from the agent/sub-agent row. Order preserved; unknown names silently dropped
// (validated at the API layer on save).
export const buildToolsForRun = (
  names: ReadonlyArray<string>,
  ctx: ToolBuildCtx,
): ReturnType<typeof defineTool>[] => {
  const built: ReturnType<typeof defineTool>[] = []
  for (const n of names) {
    const d = toolByName.get(n)
    if (!d) continue
    // Skip a selected-but-unavailable tool (e.g. computer without the sandbox runtime).
    if (d.available && !d.available(ctx)) continue
    built.push(compactForLlm(d.build(ctx)))
  }
  return built
}

// Every tool in the registry. Use sparingly — run-time selection should come
// from the agent row, not the registry, so new tools don't start firing on
// existing agents.
export const allRegisteredToolNames = (): string[] =>
  TOOL_REGISTRY.map((t) => t.name)

// Tool set seeding a brand-new agent when the create payload omits one.
// Excludes opt-in tools (`defaultEnabled: false`, e.g. `computer`).
export const defaultAgentToolNames = (): string[] =>
  TOOL_REGISTRY.filter((t) => t.defaultEnabled !== false).map((t) => t.name)
