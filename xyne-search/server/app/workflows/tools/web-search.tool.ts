// `web_search` workflow agent tool — wraps the shared research engine as a
// WorkflowTool so the RUN_AGENT step can search the public web.
//
// Backend clients aren't injected via ToolExecutionContext (it carries only
// signal/log/sandbox/addArtifact), so this tool closes over the engine directly.
// Use the SDK's own bundled zod (3.25), not our root zod 4 /v3 shim — a zod
// type-identity mismatch makes tsc blow up (TS2589). See tsconfig "zodsdk".

import { z } from "zodsdk"
import type { WorkflowTool } from "@xyne/workflow-sdk/agents"
import { webSearch } from "@/app/services/research"

const WebSearchInput = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "The web search query. Be specific for better results, e.g. 'React 19 release date'.",
    ),
})

export function makeWebSearchTool(): WorkflowTool<typeof WebSearchInput> {
  return {
    name: "web_search",
    description:
      "Search the public web (Brave) for current information — recent events, news, " +
      "prices, release dates, docs. Returns ranked results with titles, URLs, and snippets.",
    inputSchema: WebSearchInput,
    async execute(args, ctx): Promise<unknown> {
      try {
        const { results } = await webSearch(args.query, { signal: ctx.signal })
        ctx.log.info(
          `web_search: ${results.length} result(s) for "${args.query.slice(0, 80)}"`,
        )
        return { results }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown web search error"
        ctx.log.error(`web_search failed: ${msg}`)
        return { error: msg, results: [] }
      }
    },
  }
}
