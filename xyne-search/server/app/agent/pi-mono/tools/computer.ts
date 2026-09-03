// computer — one persistent Linux sandbox, four actions (bash/write/read/edit).
// The sandbox is leased per conversation, so the filesystem persists across
// calls (write a file in one call, run it in the next); no in-memory state.
// Format competence lives in /opt/skills, reached through these actions.

import { defineTool } from "@earendil-works/pi-coding-agent"
import { Type } from "@sinclair/typebox"

import {
  ChatAttachmentError,
  uploadChatAttachment,
} from "@/app/agent/services/chatAttachments"
import { getSandboxManager } from "@/platform/lib/sandbox/manager"
import type { ExecResult, SandboxArtifact } from "@/platform/lib/sandbox/types"

import type { Log } from "../../log"

const ARTIFACT_UPLOADER = "assistant"

const DESCRIPTION = [
  "A persistent Linux computer for this conversation — your hands for ",
  "everything beyond search. Four actions: ",
  "• bash — run a shell command (python, node, `soffice`, `pandoc`, any ",
  "/opt/skills script, file ops). ",
  "• write — create/overwrite a file at `path` with `content`; use this for ",
  "multi-line scripts/SVG/data rather than heredoc-ing into bash. ",
  "• read — read a text file (optional `offset`/`limit` lines). ",
  "• edit — replace `old_str` with `new_str` in a file (`old_str` must be ",
  "unique in the file). ",
  "The FILESYSTEM persists across calls (same sandbox per conversation) — ",
  "write a file in one call, run it in the next. No in-memory state; persist ",
  "data to disk. ",
  "Pre-installed: Python (pandas, numpy, scipy, matplotlib, seaborn, plotly, ",
  "scikit-learn, openpyxl, Pillow, pdfplumber, pypdf, python-docx, pytesseract, ",
  "reportlab, lxml), Node 20 (`docx` / docx-js, `pptxgenjs`), LibreOffice ",
  "(`soffice`), pandoc. NO network — pip/npm install fail; the libs above are ",
  "baked in. ",
  "Paths: user uploads are at `/mnt/files/`; write deliverables to ",
  "`/mnt/output/<name>.<ext>` — anything there is auto-attached to your reply ",
  "(images render inline, others as a download card). Do NOT paste file ",
  "contents or base64 into your text answer. Put scratch scripts and ",
  "intermediate files in `/tmp` (or the working dir), NOT `/mnt/output/` — ",
  "only final deliverables belong there, since everything in it is attached. ",
  "SKILLS — production guidance + scripts live at `/opt/skills/`, one folder ",
  "per capability. READ `/opt/skills/<name>/SKILL.md` first, then follow it: ",
  "docx / pptx / xlsx / pdf (create & edit Office/PDF docs — docx-js, ",
  "pptxgenjs, openpyxl; unpack→edit→pack; recalc; form-fill). To CREATE a PDF, ",
  "author a .docx then convert it with `soffice --convert-to pdf` (LibreOffice's ",
  "layout beats hand-built reportlab); use reportlab only for forms / precise ",
  "canvas layout. visualization ",
  "(charts & illustrations — matplotlib/seaborn/plotly/SVG), file-reading / ",
  "pdf-reading (analyse uploaded PDFs/Excel/DOCX/CSV/images). ",
  "Each bash call is wall-clock-capped (default 30s; pass `timeout` up to 600s ",
  "for a slow LibreOffice conversion — do that in its own call). Use this for ",
  "computation, parsing, analysis, file work, and generating deliverables. Do ",
  "NOT use it for retrieval (use `vespaSearch`) or for code the user could run ",
  "themselves.",
].join("")

const params = Type.Object(
  {
    action: Type.Union(
      [
        Type.Literal("bash"),
        Type.Literal("write"),
        Type.Literal("read"),
        Type.Literal("edit"),
      ],
      { description: "Which operation to perform." },
    ),
    command: Type.Optional(
      Type.String({
        description: "action=bash: the shell command to run.",
        maxLength: 16_384,
      }),
    ),
    path: Type.Optional(
      Type.String({
        description:
          "action=write|read|edit: absolute file path inside the sandbox " +
          "(e.g. /tmp/gen.py, /mnt/output/report.docx).",
        maxLength: 4_096,
      }),
    ),
    content: Type.Optional(
      Type.String({
        description: "action=write: the full file contents to write.",
        maxLength: 262_144,
      }),
    ),
    old_str: Type.Optional(
      Type.String({
        description:
          "action=edit: exact text to replace. Must appear EXACTLY once in " +
          "the file — include surrounding context to make it unique.",
        maxLength: 100_000,
      }),
    ),
    new_str: Type.Optional(
      Type.String({
        description: "action=edit: the replacement text.",
        maxLength: 100_000,
      }),
    ),
    timeout: Type.Optional(
      Type.Number({
        description: "action=bash: wall-clock seconds (default 30, max 600).",
        minimum: 1,
        maximum: 600,
      }),
    ),
    offset: Type.Optional(
      Type.Number({ description: "action=read: 1-based start line.", minimum: 1 }),
    ),
    limit: Type.Optional(
      Type.Number({
        description: "action=read: number of lines to read from `offset`.",
        minimum: 1,
      }),
    ),
  },
  { additionalProperties: false },
)

type Params = {
  action: "bash" | "write" | "read" | "edit"
  command?: string
  path?: string
  content?: string
  old_str?: string
  new_str?: string
  timeout?: number
  offset?: number
  limit?: number
}

export type ComputerToolArgs = {
  conversationId: string
  userEmail: string
  logger: Log
  onProgress?: (
    toolCallId: string,
    label: string,
    level?: "info" | "ok" | "error",
  ) => void
}

const MAX_STDOUT_BYTES = 8 * 1024
const MAX_STDERR_BYTES = 4 * 1024
// Cap a `read` so a giant file can't flood context.
const MAX_READ_BYTES = 32 * 1024

const EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".json": "application/json",
  ".txt": "text/plain",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

const mimeFromExt = (path: string): string | undefined => {
  const dot = path.lastIndexOf(".")
  if (dot < 0) return undefined
  return EXT_TO_MIME[path.slice(dot).toLowerCase()]
}

function truncate(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false }
  return {
    text: s.slice(0, max) + `\n... [truncated ${String(s.length - max)} chars]`,
    truncated: true,
  }
}

type PersistedArtifact = {
  id?: string
  path: string
  fileName: string
  mimeType?: string
  sizeBytes?: number
  persistError?: string
}

/** Push artifact bytes into the chat-attachments store for the UI. Best-effort
 *  — a failed persist doesn't fail the tool call. */
async function persistArtifacts(
  conversationId: string,
  artifacts: SandboxArtifact[],
  log: Log,
): Promise<PersistedArtifact[]> {
  const out: PersistedArtifact[] = []
  for (const a of artifacts) {
    const fileName = a.path.split("/").pop() ?? "artifact"
    const base: PersistedArtifact = {
      path: a.path,
      fileName,
      ...(a.mimeType ? { mimeType: a.mimeType } : {}),
      ...(a.data ? { sizeBytes: a.data.byteLength } : {}),
    }
    if (!a.data || a.data.byteLength === 0) {
      out.push(base)
      continue
    }
    try {
      const att = await uploadChatAttachment({
        conversationId,
        uploadedBy: ARTIFACT_UPLOADER,
        fileName,
        ...(a.mimeType ? { headerMime: a.mimeType } : {}),
        bytes: a.data,
      })
      out.push({ ...base, id: att.id, sizeBytes: att.sizeBytes })
    } catch (err) {
      const msg =
        err instanceof ChatAttachmentError
          ? `${err.code}: ${err.message}`
          : (err as Error)?.message ?? "unknown"
      log.warn({ path: a.path, err: msg }, "tool: artifact persist failed")
      out.push({ ...base, persistError: msg })
    }
  }
  return out
}

/** Shape a bash/exec result into text + structured details for the LLM and
 *  the debug panel. */
function shapeResult(
  r: ExecResult,
  persisted: PersistedArtifact[],
): { text: string; details: Record<string, unknown>; isError: boolean } {
  const stdout = truncate(r.stdout, MAX_STDOUT_BYTES)
  const stderr = truncate(r.stderr, MAX_STDERR_BYTES)
  const lines: string[] = []
  if (stdout.text) lines.push(`stdout:\n${stdout.text}`)
  if (stderr.text) lines.push(`stderr:\n${stderr.text}`)
  if (typeof r.exitCode === "number" && r.exitCode !== 0) {
    lines.push(`exit code: ${String(r.exitCode)}`)
  }
  if (r.error) {
    lines.push(`error: ${r.error.name}: ${r.error.value}`)
    if (r.error.traceback) lines.push(`traceback:\n${r.error.traceback}`)
  }
  if (persisted.length > 0) {
    const summary = persisted
      .map((a) => `${a.fileName}${a.mimeType ? ` (${a.mimeType})` : ""}`)
      .join(", ")
    lines.push(`artifacts: ${summary}`)
  }
  if (lines.length === 0) lines.push("(no output)")
  lines.push(`durationMs: ${String(r.durationMs)}`)
  return {
    text: lines.join("\n\n"),
    details: {
      stdout: stdout.text,
      stderr: stderr.text,
      ...(stdout.truncated ? { stdoutTruncated: true } : {}),
      ...(stderr.truncated ? { stderrTruncated: true } : {}),
      ...(typeof r.exitCode === "number" ? { exitCode: r.exitCode } : {}),
      ...(r.error ? { error: r.error } : {}),
      artifacts: persisted,
      durationMs: r.durationMs,
    },
    isError: !!r.error,
  }
}

const text = (s: string): { type: "text"; text: string } => ({ type: "text", text: s })

const badArgs = (
  msg: string,
): { content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError: true } => ({
  content: [text(msg)],
  details: { error: "invalid_arguments", detail: msg },
  isError: true,
})

// ── skill-read gate ──────────────────────────────────────────────────────────
// Hard precondition: refuse a format-generation call until the model has read
// the matching skill in this conversation (read SKILL.md or ran anything under
// /opt/skills/<name>/). In-memory, per process — resets on restart. Triggers are
// heuristic, so it's near-deterministic: it can miss an exotic path but never
// blocks a correct result — at most it forces one extra skill read.

const skillsReadByConv = new Map<string, Set<string>>()
const SKILL_PATH_RE = /\/opt\/skills\/([a-z][a-z0-9-]*)\//g

/** Record every skill referenced by this call's path/command (reading a
 *  SKILL.md or invoking a skill script both count as "engaged with it"). */
function markSkillsRead(conversationId: string, ...texts: (string | undefined)[]): void {
  for (const t of texts) {
    if (!t) continue
    for (const m of t.matchAll(SKILL_PATH_RE)) {
      const set = skillsReadByConv.get(conversationId) ?? new Set<string>()
      set.add(m[1]!)
      skillsReadByConv.set(conversationId, set)
    }
  }
}

const hasReadSkill = (conversationId: string, skill: string): boolean =>
  skillsReadByConv.get(conversationId)?.has(skill) ?? false

/** The skill a bash/write call must have read first, or null. */
function requiredSkillFor(p: Params): string | null {
  if (p.action !== "bash" && p.action !== "write") return null
  const hay = `${p.path ?? ""}\n${p.command ?? ""}\n${p.content ?? ""}`
  // Gate only on a deliverable WRITTEN under /mnt/output/ or an authoring lib.
  // Never gate a bare `.docx`/`.pdf`/… that's an INPUT being read — reading an
  // upload needs pdf-reading/file-reading, not the creation skill, and must pass.
  if (/\/mnt\/output\/\S+\.docx/.test(hay) || /require\(['"]docx['"]\)/.test(hay)) return "docx"
  if (/\/mnt\/output\/\S+\.pptx/.test(hay) || /\bpptxgenjs\b/.test(hay)) return "pptx"
  if (/\/mnt\/output\/\S+\.xlsx/.test(hay)) return "xlsx"
  // Any PDF route (deliverable, reportlab, or docx→pdf via soffice convert).
  if (
    /\/mnt\/output\/\S+\.pdf/.test(hay) ||
    /\breportlab\b/.test(hay) ||
    /convert-to\s+pdf/.test(hay)
  )
    return "pdf"
  // Specialised viz where the API is error-prone (e.g. networkx edge_color);
  // plain matplotlib/seaborn charts are NOT gated.
  if (/\bnetworkx\b|\bgraphviz\b/.test(hay)) return "visualization"
  return null
}

const skillGateError = (
  skill: string,
): { content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError: true } => ({
  content: [
    text(
      `Read \`/opt/skills/${skill}/SKILL.md\` before generating a ${skill} ` +
        `deliverable — use action=read with that exact path, then retry this ` +
        `call. The skill has the correct API and avoids common rendering bugs.`,
    ),
  ],
  details: { error: "skill_not_read", skill },
  isError: true,
})

// `read` returns UTF-8, so binary files come back as garbage — steer the model
// to the right extractor. `{p}` is substituted with the actual path.
const BINARY_READ_HINTS: Record<string, string> = {
  ".pdf":
    "`{p}` is a PDF (binary) — `read` returns garbage. Extract its text with " +
    "action=bash: `python3 -c \"import pdfplumber; print(chr(10).join((pg.extract_text() or '') " +
    "for pg in pdfplumber.open('{p}').pages))\"` (if it's scanned, OCR with " +
    "pdf2image + pytesseract). See /opt/skills/pdf-reading/SKILL.md.",
  ".docx":
    "`{p}` is a DOCX (binary zip) — use action=bash `extract-text {p}` (or python-docx), " +
    "not `read`. See /opt/skills/file-reading/SKILL.md.",
  ".doc": "`{p}` is a legacy .doc (binary) — `extract-text {p}`, or convert with soffice first.",
  ".xlsx":
    "`{p}` is an XLSX (binary) — read it with action=bash `python3 -c \"import pandas as pd; " +
    "print(pd.read_excel('{p}'))\"`.",
  ".xls": "`{p}` is a legacy .xls (binary) — use pandas `read_excel('{p}')` via action=bash.",
  ".pptx":
    "`{p}` is a PPTX (binary zip) — use python-pptx or unpack it via action=bash, not `read`. " +
    "See /opt/skills/file-reading/SKILL.md.",
  ".png": "`{p}` is an image (binary) — OCR it (pytesseract) or analyse visually, don't `read` it.",
  ".jpg": "`{p}` is an image (binary) — OCR it (pytesseract) or analyse visually, don't `read` it.",
  ".jpeg": "`{p}` is an image (binary) — OCR it (pytesseract) or analyse visually, don't `read` it.",
  ".gif": "`{p}` is an image (binary) — not readable as text.",
  ".zip": "`{p}` is a zip — `unzip -l {p}` via action=bash to list it, then read individual entries.",
}

const binaryReadHint = (path: string): string | null => {
  const dot = path.lastIndexOf(".")
  if (dot < 0) return null
  const hint = BINARY_READ_HINTS[path.slice(dot).toLowerCase()]
  return hint ? hint.replace(/\{p\}/g, path) : null
}

export const buildComputerTool = (
  args: ComputerToolArgs,
): ReturnType<typeof defineTool> =>
  defineTool({
    name: "computer",
    label: "Computer",
    description: DESCRIPTION,
    promptSnippet:
      "Use `computer` for any computation, file analysis, document/chart " +
      "generation, or scripting. The filesystem persists across calls — " +
      "`write` a script then `bash` it. Read a skill's SKILL.md before " +
      "generating that format.",
    parameters: params,
    async execute(toolCallId, raw) {
      const p = raw as Params
      const log = args.logger.child({ toolName: "computer", toolCallId, action: p.action })
      const manager = getSandboxManager()
      if (!manager) {
        log.warn("tool: computer called but sandbox manager is not configured")
        return {
          content: [
            text(
              "The computer sandbox is not available on this deployment. " +
                "Continue without it.",
            ),
          ],
          details: { unavailable: true },
          isError: true,
        }
      }
      const onProgress = args.onProgress
        ? (label: string, level?: "info" | "ok" | "error"): void => {
            args.onProgress?.(toolCallId, label, level)
          }
        : undefined
      const common = {
        conversationId: args.conversationId,
        userEmail: args.userEmail,
        ...(onProgress ? { onProgress } : {}),
      }

      // Skill-read gate: record skills used, then refuse format-generation until
      // the matching skill is read. Self-correcting — the error says what to read.
      markSkillsRead(args.conversationId, p.path, p.command)
      const needsSkill = requiredSkillFor(p)
      if (needsSkill && !hasReadSkill(args.conversationId, needsSkill)) {
        log.info({ skill: needsSkill }, "tool: computer gated — skill not read yet")
        return skillGateError(needsSkill)
      }

      try {
        switch (p.action) {
          case "bash": {
            if (!p.command) return badArgs("action=bash requires `command`.")
            log.info({ commandChars: p.command.length }, "tool: computer bash start")
            const result = await manager.bash({
              ...common,
              command: p.command,
              ...(p.timeout ? { opts: { timeoutMs: p.timeout * 1000 } } : {}),
            })
            const persisted = await persistArtifacts(args.conversationId, result.artifacts, log)
            const shaped = shapeResult(result, persisted)
            return { content: [text(shaped.text)], details: shaped.details, isError: shaped.isError }
          }

          case "write": {
            if (!p.path || p.content === undefined) {
              return badArgs("action=write requires `path` and `content`.")
            }
            const bytes = new TextEncoder().encode(p.content)
            await manager.writeFile({ ...common, path: p.path, bytes })
            // A write directly under /mnt/output/ is a deliverable — surface it.
            let persisted: PersistedArtifact[] = []
            if (p.path.startsWith("/mnt/output/")) {
              const mime = mimeFromExt(p.path)
              persisted = await persistArtifacts(
                args.conversationId,
                [{ path: p.path, data: bytes, ...(mime ? { mimeType: mime } : {}) }],
                log,
              )
            }
            const note = persisted.length ? ` (attached: ${persisted[0]!.fileName})` : ""
            return {
              content: [text(`Wrote ${String(bytes.byteLength)} bytes to ${p.path}${note}`)],
              details: { path: p.path, bytes: bytes.byteLength, artifacts: persisted },
              isError: false,
            }
          }

          case "read": {
            if (!p.path) return badArgs("action=read requires `path`.")
            const binHint = binaryReadHint(p.path)
            if (binHint) return badArgs(binHint)
            let content: string
            try {
              content = await manager.readFile({ ...common, path: p.path })
            } catch (err) {
              return badArgs(`Could not read ${p.path}: ${(err as Error)?.message ?? "not found"}`)
            }
            // Safety net for a binary file with no known extension: NUL / U+FFFD
            // density means garbage — point the model at a real extractor instead.
            const sniff = content.slice(0, 4096)
            if (
              sniff.length > 0 &&
              (sniff.match(/[\u0000\uFFFD]/g)?.length ?? 0) / sniff.length > 0.1
            ) {
              return badArgs(
                `\`${p.path}\` looks like a binary file — read as text it's garbled. ` +
                  "Use action=bash with the right extractor (pdfplumber / pandas / " +
                  "python-docx / OCR) to get its content.",
              )
            }
            let body = content
            if (p.offset || p.limit) {
              const all = content.split("\n")
              const start = p.offset ? p.offset - 1 : 0
              const end = p.limit ? start + p.limit : all.length
              body = all.slice(start, end).join("\n")
            }
            const trimmed = truncate(body, MAX_READ_BYTES)
            return {
              content: [text(trimmed.text || "(empty file)")],
              details: {
                path: p.path,
                bytes: content.length,
                ...(trimmed.truncated ? { truncated: true } : {}),
              },
              isError: false,
            }
          }

          case "edit": {
            if (!p.path || p.old_str === undefined || p.new_str === undefined) {
              return badArgs("action=edit requires `path`, `old_str`, and `new_str`.")
            }
            let content: string
            try {
              content = await manager.readFile({ ...common, path: p.path })
            } catch (err) {
              return badArgs(`Could not read ${p.path}: ${(err as Error)?.message ?? "not found"}`)
            }
            const count = content.split(p.old_str).length - 1
            if (count === 0) {
              return badArgs(`\`old_str\` not found in ${p.path}.`)
            }
            if (count > 1) {
              return badArgs(
                `\`old_str\` appears ${String(count)} times in ${p.path}; add ` +
                  "surrounding context so it matches exactly once.",
              )
            }
            const updated = content.replace(p.old_str, p.new_str)
            await manager.writeFile({
              ...common,
              path: p.path,
              bytes: new TextEncoder().encode(updated),
            })
            return {
              content: [text(`Edited ${p.path} (1 replacement).`)],
              details: { path: p.path },
              isError: false,
            }
          }

          default:
            return badArgs(`Unknown action: ${String((p as Params).action)}`)
        }
      } catch (err) {
        log.error({ err: (err as Error)?.message }, "tool: computer failed (lease / transport)")
        return {
          content: [
            text(`Computer sandbox error: ${(err as Error)?.message ?? "unknown error"}`),
          ],
          details: { sandboxError: true },
          isError: true,
        }
      }
    },
  })
