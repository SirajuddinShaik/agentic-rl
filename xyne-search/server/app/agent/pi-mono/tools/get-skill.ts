// The `skill` tool: the model fetches an attached skill's content by alias.

import { defineTool } from "@earendil-works/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import { eq } from "drizzle-orm"

import { db } from "@/platform/db/client"
import { skills as skillsTable } from "@/platform/db/schema"

import type { Log } from "../../log"

const DESCRIPTION = [
  "Fetch the full instructions/content of a skill by its alias. Call this ",
  "after matching the user's task to one of the skills listed in the system ",
  "prompt, before acting on it. Pass the skill's `alias` exactly as it appears ",
  "in the <skills> manifest; the returned content is the authoritative ",
  "instructions to follow for that task.",
].join("")

const params = Type.Object({
  alias: Type.String({
    description:
      "Alias of the skill to fetch. Must match the `alias` attribute on one " +
      "of the <skill> entries in the system prompt's <skills> manifest.",
    minLength: 1,
  }),
})

export type GetSkillToolArgs = {
  /** The agent's allowed skill manifest, pre-filtered to what the viewer may
   *  see. Aliases outside this list are rejected before any DB read. */
  skills: ReadonlyArray<{
    id: string
    alias: string
    name: string
    description: string
  }>
  logger: Log
}

// Explicit union of every `details` shape execute() returns (defineTool is
// generic over a single TDetails).
type GetSkillDetails = {
  error?: string
  requested?: string
  available?: string
  alias?: string
  name?: string
  contentChars?: number
}

export const buildGetSkillTool = (
  args: GetSkillToolArgs,
): ReturnType<typeof defineTool> =>
  defineTool<typeof params, GetSkillDetails>({
    name: "skill",
    label: "Skill",
    description: DESCRIPTION,
    promptSnippet:
      "Use `skill({alias})` to load a skill's full instructions when " +
      "the user's task matches one of the skills listed above. Fetch before " +
      "you act — don't guess the contents from the name.",
    parameters: params,
    async execute(toolCallId, p) {
      const log = args.logger.child({
        toolName: "skill",
        toolCallId,
        alias: p.alias,
      })

      // Access gate: reject aliases outside the viewer-visible manifest.
      const allowed = args.skills.find((s) => s.alias === p.alias)
      if (!allowed) {
        const available = args.skills
          .map((s) => `${s.alias} (${s.name})`)
          .join(", ")
        log.warn({ available }, "skill: alias not in manifest")
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Skill "${p.alias}" is not one of the skills available to ` +
                `you. Available skills: ${available || "(none)"}.`,
            },
          ],
          details: { error: "not-allowed", requested: p.alias, available },
          isError: true,
        }
      }

      // Missing row → skill was deleted since session start.
      const rows = await db
        .select({ name: skillsTable.name, content: skillsTable.content })
        .from(skillsTable)
        .where(eq(skillsTable.alias, p.alias))
        .limit(1)
      const row = rows[0]
      if (!row) {
        log.warn("skill: skill row not found (deleted since session start?)")
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Skill "${allowed.name}" (${p.alias}) no longer exists. ` +
                `Proceed without it.`,
            },
          ],
          details: { error: "not-found", alias: p.alias },
          isError: true,
        }
      }

      log.info(
        { name: row.name, contentChars: row.content.length },
        "skill: skill content returned",
      )
      return {
        content: [{ type: "text" as const, text: row.content }],
        details: {
          alias: p.alias,
          name: row.name,
          contentChars: row.content.length,
        },
      }
    },
  })
