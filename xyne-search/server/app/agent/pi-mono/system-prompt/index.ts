// Public surface for the system-prompt module: `assembleSystemPrompt` for
// runtime composition, the `DEFAULT_SYSTEM_PROMPT_*` constants for showing
// canonical defaults (e.g. the agent-form "Use default" button).

import { DEFAULT_SYSTEM_PROMPT_MAIN } from "./defaults/main"
import { DEFAULT_SYSTEM_PROMPT_SUBAGENTS } from "./defaults/subagents"
import { DEFAULT_SYSTEM_PROMPT_TOOLS } from "./defaults/tools"
import { assembleSystemPrompt } from "./assemble"

export {
  DEFAULT_SYSTEM_PROMPT_MAIN,
  DEFAULT_SYSTEM_PROMPT_TOOLS,
  DEFAULT_SYSTEM_PROMPT_SUBAGENTS,
}
export {
  assembleSystemPrompt,
  type SystemPromptSections,
  type SubAgentSummary,
  type SkillSummary,
} from "./assemble"

// Back-compat single-string default (pre three-section refactor): assembled
// with no overrides and no sub-agents.
export const DEFAULT_SYSTEM_PROMPT = assembleSystemPrompt({})

// Prompt-resolution inputs — the AgentScope projection agent-scope.ts builds.
export type AgentPromptInputs = {
  systemPromptMain?: string | null | undefined
  systemPromptTools?: string | null | undefined
  systemPromptSubagents?: string | null | undefined
  subAgents?: ReadonlyArray<SubAgentSummary>
  skills?: ReadonlyArray<SkillSummary>
}

// Resolve the prompt for an agent. Since the legacy `prompt` column was
// migrated into `system_prompt_main` (scripts/migrate-prompt-to-main.sql),
// there's a single path: assemble main + tools + sub-agents from the row's
// per-section overrides, workspace defaults filling any null/empty slot.
export const resolveAgentSystemPrompt = (inputs: AgentPromptInputs): string =>
  assembleSystemPrompt(
    {
      main: inputs.systemPromptMain ?? null,
      tools: inputs.systemPromptTools ?? null,
      subagents: inputs.systemPromptSubagents ?? null,
    },
    inputs.subAgents ?? [],
    inputs.skills ?? [],
  )

// Late import to keep the type circular-ref clean (SubAgentSummary is
// re-exported above from ./assemble).
import type { SkillSummary, SubAgentSummary } from "./assemble"
