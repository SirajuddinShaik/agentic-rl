// Joins the system prompt from independently-editable sections in a fixed
// order: main → tools → sub-agents → skills. Caller resolves override-vs-default
// strings; this assembler stays DB-agnostic. Sections are suppressed when empty
// (e.g. advertising dispatchSubagent with no sub-agents only confuses the LLM).

import { DEFAULT_SYSTEM_PROMPT_MAIN } from "./defaults/main"
import { DEFAULT_SYSTEM_PROMPT_SUBAGENTS } from "./defaults/subagents"
import { DEFAULT_SYSTEM_PROMPT_TOOLS } from "./defaults/tools"

export type SystemPromptSections = {
  main?: string | null
  tools?: string | null
  subagents?: string | null
}

export type SubAgentSummary = {
  name: string
  description: string
}

export type SkillSummary = {
  id: string
  /** Short unique handle the LLM passes to the `skill` tool. */
  alias: string
  name: string
  description: string
}

// Resolve a section value: use the override when it is a non-empty string,
// otherwise fall back to the default. `null` and empty strings are treated
// as "no override" so the UI can clear a field back to the default by
// blanking the textarea.
const resolve = (
  override: string | null | undefined,
  fallback: string,
): string => {
  if (typeof override === "string" && override.trim().length > 0) {
    return override
  }
  return fallback
}

// Render the `<subagents>` catalog appended after the sub-agents instruction
// text. We use XML-ish tags because the rest of the prompt (citations, tool
// outputs) already speaks the same shape — keeps formatting consistent for
// the LLM.
const renderSubAgentCatalog = (subAgents: SubAgentSummary[]): string => {
  if (subAgents.length === 0) {
    return ""
  }
  const items = subAgents.map(
    (s) => `  <subagent name="${s.name}">${s.description}</subagent>`,
  )
  return ["<subagents>", ...items, "</subagents>"].join("\n")
}

// Fixed instruction text for the skills section (no per-agent override).
const SKILLS_INSTRUCTIONS = [
  "You have access to SKILLS — reusable, vetted instruction snippets attached",
  "to this agent. Each skill below lists only an alias, name, and short",
  "description. When the user's task matches a skill, call the `skill` tool",
  "with that skill's alias to load its full instructions BEFORE you act, then",
  "follow them. Do not guess a skill's contents from its name — fetch it. If no",
  "skill is relevant, ignore them and proceed normally.",
].join(" ")

// Render the <skills> manifest — alias/name/description only, never the body.
const renderSkillCatalog = (skills: SkillSummary[]): string => {
  if (skills.length === 0) {
    return ""
  }
  const items = skills.map(
    (s) =>
      `  <skill alias="${s.alias}" name="${s.name}">${s.description}</skill>`,
  )
  return ["<skills>", ...items, "</skills>"].join("\n")
}

export const assembleSystemPrompt = (
  sections: SystemPromptSections,
  subAgents: ReadonlyArray<SubAgentSummary> = [],
  skills: ReadonlyArray<SkillSummary> = [],
): string => {
  const main = resolve(sections.main, DEFAULT_SYSTEM_PROMPT_MAIN)
  const tools = resolve(sections.tools, DEFAULT_SYSTEM_PROMPT_TOOLS)

  // Sub-agents section: only render when there is at least one sub-agent.
  // The instruction text (about how to dispatch) is paired with the catalog
  // of available sub-agents — both come together or both stay out.
  let subAgentBlock = ""
  if (subAgents.length > 0) {
    const instructions = resolve(
      sections.subagents,
      DEFAULT_SYSTEM_PROMPT_SUBAGENTS,
    )
    const catalog = renderSubAgentCatalog([...subAgents])
    subAgentBlock = [instructions, catalog].filter((s) => s.length > 0).join(
      "\n\n",
    )
  }

  // Skills section: only when the agent has at least one visible skill.
  let skillBlock = ""
  if (skills.length > 0) {
    const catalog = renderSkillCatalog([...skills])
    skillBlock = [SKILLS_INSTRUCTIONS, catalog]
      .filter((s) => s.length > 0)
      .join("\n\n")
  }

  return [main, tools, subAgentBlock, skillBlock]
    .filter((s) => s.length > 0)
    .join("\n\n")
}
