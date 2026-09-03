// E2B implementation of SandboxClient. Self-contained so swapping to a
// self-hosted runtime later is a single-file change. Mostly translates the
// SDK's Execution shape into our flatter ExecResult.

import { Sandbox, type Execution } from "@e2b/code-interpreter"

import { getLogger } from "@/platform/logger"
import { Subsystem } from "@/types"

import type {
  ExecOpts,
  ExecResult,
  SandboxArtifact,
  SandboxClient,
  SandboxFileUpload,
  SandboxHandle,
} from "./types"

const Logger = getLogger(Subsystem.Chat)

// Aligned to the attachment service's cap (BACKENDV2_CHAT_ATTACHMENT_MAX_BYTES,
// default 50 MB) so large deliverables still persist. These bytes only feed the
// attachment store, never the LLM, so there's no context cost. A smaller cap
// silently dropped over-cap files: captured path-only, then un-persistable.
const MAX_ARTIFACT_BYTES = Number(
  process.env["BACKENDV2_CHAT_ATTACHMENT_MAX_BYTES"] ?? 50 * 1024 * 1024,
)

// SandboxHandle.id → live SDK instance. Kept off the handle itself so the SDK
// instance stays scoped here even as callers persist handles across modules.
const liveSandboxes = new Map<string, Sandbox>()

// Mirrors the description in computer.ts — keep in sync.
const OUTPUT_DIR = "/mnt/output"

interface E2BSandboxClientOpts {
  apiKey: string
  // Per-exec wall-clock default. Pi-mono enforces a 10-min hard timeout above us.
  defaultExecTimeoutMs?: number
  // Custom E2B template (see /e2b-template) baking in pdfplumber/pypdf/pytesseract
  // etc. so the model can inspect uploaded documents.
  template?: string
}

export class E2BSandboxClient implements SandboxClient {
  private readonly apiKey: string
  private readonly defaultExecTimeoutMs: number
  private readonly template?: string
  private readonly sandboxTimeoutMs: number
  private readonly allowInternet: boolean

  public constructor(opts: E2BSandboxClientOpts) {
    this.apiKey = opts.apiKey
    this.defaultExecTimeoutMs = opts.defaultExecTimeoutMs ?? 30_000
    this.sandboxTimeoutMs = Number(
      process.env["E2B_SANDBOX_TIMEOUT_MS"] ?? 30 * 60 * 1000,
    )
    // Deny sandbox internet egress unless explicitly opted in.
    this.allowInternet = process.env["E2B_ALLOW_INTERNET"] === "true"
    if (opts.template) this.template = opts.template
  }

  public async create(): Promise<SandboxHandle> {
    const startedAt = Date.now()
    // Untrusted code runs here. On a self-hosted E2B inside the VPC, internet
    // egress lets it reach cloud metadata (169.254.169.254) or internal services
    // → SSRF / credential theft. Deny egress by default (allowInternetAccess
    // false ≡ denyOut 0.0.0.0/0), matching the Docker adapter's --network=none;
    // set E2B_ALLOW_INTERNET=true only where the sandbox genuinely needs the net.
    const createOpts = {
      apiKey: this.apiKey,
      timeoutMs: this.sandboxTimeoutMs,
      allowInternetAccess: this.allowInternet,
    }
    const sb = this.template
      ? await Sandbox.create(this.template, createOpts)
      : await Sandbox.create(createOpts)
    const id = sb.sandboxId
    liveSandboxes.set(id, sb)
    try {
      // runCode is root (Jupyter kernel) but bash runs as non-root `user`; make
      // the dir world-writable or bash hits PermissionError saving artifacts.
      await sb.runCode(
        `import os; os.makedirs("${OUTPUT_DIR}", exist_ok=True); os.chmod("${OUTPUT_DIR}", 0o777)`,
      )
    } catch (err) {
      Logger.warn(
        { sandboxId: id, err: (err as Error)?.message },
        "sandbox: failed to mkdir output dir on create",
      )
    }
    Logger.info(
      {
        sandboxId: id,
        bootMs: Date.now() - startedAt,
      },
      "sandbox: created",
    )
    return {
      id,
      isAlive: async (): Promise<boolean> => {
        const s = liveSandboxes.get(id)
        if (!s) return false
        try {
          // Treat any throw / false as "needs fresh sandbox".
          return await (s as unknown as { isRunning(): Promise<boolean> }).isRunning()
        } catch {
          return false
        }
      },
    }
  }

  public async exec(
    handle: SandboxHandle,
    code: string,
    opts: ExecOpts = {},
  ): Promise<ExecResult> {
    const sb = liveSandboxes.get(handle.id)
    if (!sb) {
      throw new Error(`sandbox handle ${handle.id} is no longer tracked`)
    }
    const startedAt = Date.now()
    const timeoutMs = opts.timeoutMs ?? this.defaultExecTimeoutMs
    // Snapshot /mnt/output/ before exec so the post-exec diff captures only
    // newly-written files; otherwise manager-re-pushed prior artifacts get
    // mis-captured as fresh outputs and persisted twice.
    const preExecPaths = await snapshotOutputPaths(sb, handle.id)
    let execution: Execution
    try {
      execution = await sb.runCode(code, { timeoutMs })
    } catch (err) {
      // Transport failure: surface as a synthetic-error ExecResult so the tool
      // result still renders.
      Logger.warn(
        {
          sandboxId: handle.id,
          err: (err as Error)?.message,
        },
        "sandbox: runCode threw",
      )
      return {
        stdout: "",
        stderr: "",
        error: {
          name: "SandboxTransportError",
          value: (err as Error)?.message ?? String(err),
          traceback: "",
        },
        artifacts: [],
        durationMs: Date.now() - startedAt,
      }
    }

    // Only files written under /mnt/output/ count as artifacts. We dropped
    // Jupyter REPL display capture because the template's e2b_charts startup
    // emits a display result on every matplotlib import, producing spurious
    // result_0.png cards unrelated to the question.
    const fileArtifacts = await collectOutputDirArtifacts(
      sb,
      handle.id,
      preExecPaths,
    )
    return {
      stdout: (execution.logs?.stdout ?? []).join(""),
      stderr: (execution.logs?.stderr ?? []).join(""),
      ...(execution.error
        ? {
            error: {
              name: execution.error.name,
              value: execution.error.value,
              traceback: execution.error.traceback,
            },
          }
        : {}),
      artifacts: fileArtifacts,
      durationMs: Date.now() - startedAt,
    }
  }

  public async bash(
    handle: SandboxHandle,
    command: string,
    opts: ExecOpts = {},
  ): Promise<ExecResult> {
    const sb = liveSandboxes.get(handle.id)
    if (!sb) {
      throw new Error(`sandbox handle ${handle.id} is no longer tracked`)
    }
    const startedAt = Date.now()
    const timeoutMs = opts.timeoutMs ?? this.defaultExecTimeoutMs
    const preExecPaths = await snapshotOutputPaths(sb, handle.id)

    // commands.run throws CommandExitError on non-zero exit, but it still carries
    // stdout/stderr/exitCode, so treat it as a failed result, not a transport error.
    let out: { stdout: string; stderr: string; exitCode: number }
    try {
      const r = await (
        sb as unknown as {
          commands: {
            run: (
              cmd: string,
              o: { timeoutMs: number },
            ) => Promise<{ stdout?: string; stderr?: string; exitCode?: number }>
          }
        }
      ).commands.run(command, { timeoutMs })
      out = { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 }
    } catch (err) {
      const e = err as {
        exitCode?: number
        stdout?: string
        stderr?: string
        message?: string
      }
      if (typeof e.exitCode === "number") {
        out = { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.exitCode }
      } else {
        Logger.warn(
          { sandboxId: handle.id, err: e.message },
          "sandbox: commands.run threw (transport)",
        )
        return {
          stdout: "",
          stderr: "",
          error: {
            name: "SandboxTransportError",
            value: e.message ?? String(err),
            traceback: "",
          },
          artifacts: [],
          durationMs: Date.now() - startedAt,
        }
      }
    }

    const artifacts = await collectOutputDirArtifacts(sb, handle.id, preExecPaths)
    return {
      stdout: out.stdout,
      stderr: out.stderr,
      exitCode: out.exitCode,
      ...(out.exitCode !== 0
        ? {
            error: {
              name: "CommandFailed",
              value: `command exited with code ${out.exitCode}`,
              traceback: out.stderr,
            },
          }
        : {}),
      artifacts,
      durationMs: Date.now() - startedAt,
    }
  }

  public async readFile(handle: SandboxHandle, path: string): Promise<string> {
    const sb = liveSandboxes.get(handle.id)
    if (!sb) {
      throw new Error(`sandbox handle ${handle.id} is no longer tracked`)
    }
    return (await (
      sb as unknown as {
        files: { read: (p: string, o: { format: "text" }) => Promise<string> }
      }
    ).files.read(path, { format: "text" }))
  }

  public async uploadFiles(
    handle: SandboxHandle,
    files: SandboxFileUpload[],
  ): Promise<void> {
    if (files.length === 0) return
    const sb = liveSandboxes.get(handle.id)
    if (!sb) {
      throw new Error(`sandbox handle ${handle.id} is no longer tracked`)
    }
    const startedAt = Date.now()
    // files.write multi-entry overload: one round-trip for all attachments.
    // Cast through `unknown` since the overload doesn't surface through the
    // Sandbox subclass type.
    const entries = files.map((f) => {
      // Copy the Uint8Array into a fresh ArrayBuffer so it carries only this
      // view's bytes (no parent tail) and is a guaranteed ArrayBuffer (not
      // SharedArrayBuffer), which is what E2B's wire format requires.
      const data = new ArrayBuffer(f.bytes.byteLength)
      new Uint8Array(data).set(f.bytes)
      return { path: f.path, data }
    })
    await (
      sb as unknown as {
        files: {
          write: (entries: { path: string; data: ArrayBuffer }[]) => Promise<unknown>
        }
      }
    ).files.write(entries)
    Logger.info(
      {
        sandboxId: handle.id,
        fileCount: files.length,
        totalBytes: files.reduce((acc, f) => acc + f.bytes.byteLength, 0),
        durationMs: Date.now() - startedAt,
      },
      "sandbox: uploaded files",
    )
  }

  public async destroy(handle: SandboxHandle): Promise<void> {
    const sb = liveSandboxes.get(handle.id)
    liveSandboxes.delete(handle.id)
    if (!sb) return
    try {
      await sb.kill()
      Logger.info({ sandboxId: handle.id }, "sandbox: destroyed")
    } catch (err) {
      // Already gone / expired — swallow.
      Logger.warn(
        {
          sandboxId: handle.id,
          err: (err as Error)?.message,
        },
        "sandbox: destroy threw — sandbox may already be gone",
      )
    }
  }
}

const EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".txt": "text/plain",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

const mimeFromExt = (path: string): string | undefined => {
  const dot = path.lastIndexOf(".")
  if (dot < 0) return undefined
  return EXT_TO_MIME[path.slice(dot).toLowerCase()]
}

/** Snapshot /mnt/output/ as path → mtime (epoch ms; -1 when unreported) before
 *  each exec. The post-exec scan diffs sandbox-mtime vs sandbox-mtime (no
 *  host/sandbox clock skew) to find new/modified files. Empty map on failure. */
async function snapshotOutputPaths(
  sb: Sandbox,
  handleId: string,
): Promise<Map<string, number>> {
  try {
    const entries = (await sb.files.list(OUTPUT_DIR)) as Array<{
      path: string
      type?: unknown
      modifiedTime?: Date
    }>
    const out = new Map<string, number>()
    for (const e of entries) {
      if (e.type !== undefined && e.type !== "file") continue
      out.set(e.path, e.modifiedTime ? e.modifiedTime.getTime() : -1)
    }
    return out
  } catch (err) {
    Logger.warn(
      { sandboxId: handleId, err: (err as Error)?.message },
      "sandbox: pre-exec /mnt/output/ snapshot failed",
    )
    return new Map<string, number>()
  }
}

/** Capture files written/re-written under /mnt/output/ this exec by diffing the
 *  pre-exec snapshot: new path → capture; increased mtime → capture (lets a
 *  lingering deliverable re-appear on a later turn, which path-only dedup would
 *  wrongly skip); unchanged mtime (manager-re-pushed) → skip. Falls back to
 *  new-path-only when mtimes are unreported. */
async function collectOutputDirArtifacts(
  sb: Sandbox,
  handleId: string,
  preSnapshot: Map<string, number>,
): Promise<SandboxArtifact[]> {
  let entries: Array<{ name: string; path: string; type?: unknown; modifiedTime?: Date }>
  try {
    entries = (await sb.files.list(OUTPUT_DIR)) as Array<{
      name: string
      path: string
      type?: unknown
      modifiedTime?: Date
    }>
  } catch {
    // Dir missing — model wrote nothing. Not an error.
    return []
  }
  const out: SandboxArtifact[] = []
  for (const e of entries) {
    if (e.type !== undefined && e.type !== "file") continue
    const prevMtime = preSnapshot.get(e.path)
    const curMtime = e.modifiedTime ? e.modifiedTime.getTime() : undefined
    const isNew = prevMtime === undefined
    const isModified =
      !isNew &&
      curMtime !== undefined &&
      prevMtime !== undefined &&
      prevMtime >= 0 &&
      curMtime > prevMtime
    if (!isNew && !isModified) continue
    let bytes: Uint8Array
    try {
      bytes = await sb.files.read(e.path, { format: "bytes" })
    } catch (err) {
      Logger.warn(
        { sandboxId: handleId, path: e.path, err: (err as Error)?.message },
        "sandbox: failed to read output artifact",
      )
      continue
    }
    const mime = mimeFromExt(e.path)
    const artifact: SandboxArtifact = { path: e.path }
    if (mime) artifact.mimeType = mime
    if (bytes.byteLength <= MAX_ARTIFACT_BYTES) artifact.data = bytes
    out.push(artifact)
  }
  return out
}
