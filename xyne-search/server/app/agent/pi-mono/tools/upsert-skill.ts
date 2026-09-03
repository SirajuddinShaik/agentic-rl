// `upsertSkill` — reads OR writes the skill in the form. Two modes:
//   • READ  — NO fields: returns the current form (edit mode: existing skill;
//     create mode: what's typed so far, may be empty).
//   • WRITE — any of name / description / content: fills those fields, does NOT
//     save. Over-limit fields are REJECTED (not truncated) so the model rewrites
//     a coherent shorter version.
// The form is client-side: on a WRITE the tool call streams to the client, which
// applies the args; server-side it only validates + echoes.

import { defineTool } from "@earendil-works/pi-coding-agent"
import { Type } from "@sinclair/typebox"

import type { Log } from "../../log"

export type SkillFormSnapshot = {
  mode: "create" | "edit"
  alias: string
  name: string
  description: string
  content: string
}

export type UpsertSkillToolArgs = {
  /** The skill form as it was when the user sent this message (READ source). */
  context: SkillFormSnapshot
  aliasMax: number
  nameMax: number
  descriptionMax: number
  contentMax: number
  logger: Log
}

const buildDescription = (a: {
  aliasMax: number
  nameMax: number
  descriptionMax: number
  contentMax: number
}): string =>
  [
    "Read or write the skill in the form. ",
    "READ: call with NO arguments to get the current alias, name, description, ",
    "and content (edit mode: the existing skill; create mode: what's typed so ",
    "far). Call this first to see what you're working with. ",
    "WRITE: call with any of alias / name / description / content to fill those ",
    "form fields for the user (only the fields you pass are updated). This does ",
    "NOT save — the user reviews and clicks Save. Respect the limits: alias ≤ ",
    String(a.aliasMax),
    " (lowercase ^[a-z0-9][a-z0-9_-]*$), name ≤ ",
    String(a.nameMax),
    ", description ≤ ",
    String(a.descriptionMax),
    ", content ≤ ",
    String(a.contentMax),
    " characters; an over-limit field is rejected and must be rewritten shorter.",
  ].join("")

const params = Type.Object({
  alias: Type.Optional(
    Type.String({
      description:
        "Unique handle, lowercase ^[a-z0-9][a-z0-9_-]*$ e.g. summarize-quarterly-report (omit to READ).",
    }),
  ),
  name: Type.Optional(
    Type.String({ description: "Skill name / short title (omit to READ)." }),
  ),
  description: Type.Optional(
    Type.String({ description: "One or two sentence summary (omit to READ)." }),
  ),
  content: Type.Optional(
    Type.String({
      description: "Full skill instructions, markdown (omit to READ).",
    }),
  ),
})

type UpsertSkillDetails = {
  op: "read" | "write"
  mode?: string
  applied?: string[]
  over?: string[]
  invalid?: string[]
  aliasChars?: number
  nameChars?: number
  descriptionChars?: number
  contentChars?: number
}

export const buildUpsertSkillTool = (
  args: UpsertSkillToolArgs,
): ReturnType<typeof defineTool> =>
  defineTool<typeof params, UpsertSkillDetails>({
    name: "upsertSkill",
    label: "Skill",
    description: buildDescription(args),
    promptSnippet:
      "Use `upsertSkill()` (no args) to READ the current form, and " +
      "`upsertSkill({alias?, name?, description?, content?})` to WRITE/fill it " +
      "when the user asks you to write/update the skill. Writing does not save.",
    parameters: params,
    async execute(toolCallId, p) {
      const log = args.logger.child({ toolName: "upsertSkill", toolCallId })

      // WRITE if any field is supplied: a non-empty alias/name, or a
      // description/content string (empty string is a valid clear of those).
      const isWrite =
        (typeof p.alias === "string" && p.alias.trim().length > 0) ||
        (typeof p.name === "string" && p.name.trim().length > 0) ||
        typeof p.description === "string" ||
        typeof p.content === "string"

      if (!isWrite) {
        const { mode, alias, name, description, content } = args.context
        log.info(
          {
            op: "read",
            mode,
            aliasChars: alias.length,
            nameChars: name.length,
            descriptionChars: description.length,
            contentChars: content.length,
          },
          "upsertSkill: returned current form snapshot",
        )
        const text = [
          `Current skill (${mode} mode):`,
          `Alias: ${alias || "(empty)"}`,
          `Name: ${name || "(empty)"}`,
          `Description: ${description || "(empty)"}`,
          "Content:",
          content || "(empty)",
        ].join("\n")
        return {
          content: [{ type: "text" as const, text }],
          details: {
            op: "read",
            mode,
            aliasChars: alias.length,
            nameChars: name.length,
            descriptionChars: description.length,
            contentChars: content.length,
          },
        }
      }

      // WRITE — over-limit fields are REJECTED so the model rewrites shorter
      // rather than the form getting a cut-off-mid-sentence value.
      const applied: string[] = []
      const over: string[] = []
      const check = (
        field: string,
        value: string | undefined,
        max: number,
      ): void => {
        if (typeof value !== "string") return
        if ((field === "name" || field === "alias") && value.trim().length === 0)
          return
        if (value.length > max) {
          over.push(
            `${field} is ${String(value.length)} characters — ${String(
              value.length - max,
            )} over the ${String(max)} limit`,
          )
        } else {
          applied.push(field)
        }
      }
      check("alias", p.alias, args.aliasMax)
      check("name", p.name, args.nameMax)
      check("description", p.description, args.descriptionMax)
      check("content", p.content, args.contentMax)

      // Alias must match the server's handle format; reject so the model fixes
      // it rather than the save failing later.
      const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]*$/
      const invalid: string[] = []
      if (
        typeof p.alias === "string" &&
        p.alias.trim().length > 0 &&
        p.alias.length <= args.aliasMax &&
        !ALIAS_PATTERN.test(p.alias)
      ) {
        invalid.push(
          `alias "${p.alias}" is not a valid handle — use only lowercase ` +
            "letters, digits, hyphens, and underscores, starting with a letter " +
            "or digit (e.g. summarize-quarterly-report)",
        )
        // Don't apply an invalid alias.
        const idx = applied.indexOf("alias")
        if (idx >= 0) applied.splice(idx, 1)
      }

      if (over.length > 0 || invalid.length > 0) {
        const problems = [...over, ...invalid]
        log.warn({ over, invalid }, "upsertSkill: rejected invalid fields")
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Not applied — ${problems.join("; ")}. ` +
                "Fix the field(s): for length, rewrite shorter (count ALL " +
                "characters incl. spaces/newlines, don't truncate mid-sentence); " +
                "for the alias, use the lowercase handle format. Then call " +
                "upsertSkill again.",
            },
          ],
          details: { op: "write", applied: [], over, invalid },
          isError: true,
        }
      }

      const details: UpsertSkillDetails = { op: "write", applied }
      if (typeof p.alias === "string" && p.alias.trim().length > 0)
        details.aliasChars = p.alias.length
      if (typeof p.name === "string" && p.name.trim().length > 0)
        details.nameChars = p.name.length
      if (typeof p.description === "string")
        details.descriptionChars = p.description.length
      if (typeof p.content === "string")
        details.contentChars = p.content.length
      log.info({ applied }, "upsertSkill: filled form fields")
      return {
        content: [
          {
            type: "text" as const,
            text: `Filled the form (${applied.join(", ")}). The user can review and save.`,
          },
        ],
        details,
      }
    },
  })
