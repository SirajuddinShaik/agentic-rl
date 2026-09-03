// Self-hosted Docker sandbox client — drop-in SandboxClient alternative to the
// E2B client. One container per conversation (manager leases per conv).
//
// Shells out to the `docker` CLI (no SDK) + DOCKER_HOST, so the same code runs
// against a local or remote daemon, e.g. DOCKER_HOST=ssh://user@vm.
//
// Containers run with `--network=none` (E2B parity) and per-container CPU/RAM/PID
// caps so one conversation can't starve the shared host.

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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

const OUTPUT_DIR = "/mnt/output"
const DEFAULT_TIMEOUT_MS = 30_000
// Bytes are only used to upload, never sent to the LLM. Cap matches e2b.ts.
const MAX_ARTIFACT_BYTES = Number(
  process.env["BACKENDV2_CHAT_ATTACHMENT_MAX_BYTES"] ?? 50 * 1024 * 1024,
)

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

const dirname = (p: string): string => {
  const i = p.lastIndexOf("/")
  return i <= 0 ? "/" : p.slice(0, i)
}

type DockerRun = {
  stdout: Uint8Array
  stderr: string
  exitCode: number
  timedOut: boolean
}

export interface DockerSandboxOpts {
  /** Image tag, built from Dockerfile.sandbox. */
  image: string
  /** Remote Docker endpoint. Undefined = local daemon (unix socket). */
  dockerHost?: string
  /** Per-container caps for multi-tenancy fairness on a shared host. */
  memory?: string
  cpus?: string
  pidsLimit?: number
}

export class DockerSandboxClient implements SandboxClient {
  private readonly image: string
  private readonly dockerHost: string | undefined
  private readonly memory: string
  private readonly cpus: string
  private readonly pidsLimit: number

  public constructor(opts: DockerSandboxOpts) {
    this.image = opts.image
    this.dockerHost = opts.dockerHost
    this.memory = opts.memory ?? "2g"
    this.cpus = opts.cpus ?? "2"
    this.pidsLimit = opts.pidsLimit ?? 512
  }

  public async create(): Promise<SandboxHandle> {
    const r = await this.docker([
      "run",
      "-d",
      "--label",
      "xyne-sandbox=1",
      "--network=none",
      `--memory=${this.memory}`,
      `--cpus=${this.cpus}`,
      `--pids-limit=${String(this.pidsLimit)}`,
      this.image,
    ])
    if (r.exitCode !== 0) {
      throw new Error(`docker run failed: ${r.stderr.slice(0, 400)}`)
    }
    const id = decode(r.stdout).trim()
    if (!id) throw new Error("docker run returned no container id")
    Logger.info({ sandboxId: id, image: this.image }, "sandbox(docker): created")
    return {
      id,
      isAlive: async (): Promise<boolean> => {
        const ins = await this.docker([
          "inspect",
          "-f",
          "{{.State.Running}}",
          id,
        ])
        return ins.exitCode === 0 && decode(ins.stdout).trim() === "true"
      },
    }
  }

  public async exec(
    handle: SandboxHandle,
    code: string,
    opts: ExecOpts = {},
  ): Promise<ExecResult> {
    // No in-memory REPL — state lives on disk, per the computer-tool contract.
    return this.runInContainer(handle, ["python3", "-c", code], opts, true)
  }

  public async bash(
    handle: SandboxHandle,
    command: string,
    opts: ExecOpts = {},
  ): Promise<ExecResult> {
    return this.runInContainer(handle, ["bash", "-lc", command], opts, false)
  }

  public async readFile(handle: SandboxHandle, path: string): Promise<string> {
    const r = await this.docker(["exec", handle.id, "cat", path])
    if (r.exitCode !== 0) {
      throw new Error(r.stderr.trim() || `could not read ${path}`)
    }
    return decode(r.stdout)
  }

  public async uploadFiles(
    handle: SandboxHandle,
    files: SandboxFileUpload[],
  ): Promise<void> {
    for (const f of files) {
      const tmp = join(tmpdir(), `xyne-up-${randomUUID()}`)
      await writeFile(tmp, f.bytes)
      try {
        await this.docker(["exec", handle.id, "mkdir", "-p", dirname(f.path)])
        const cp = await this.docker(["cp", tmp, `${handle.id}:${f.path}`])
        if (cp.exitCode !== 0) {
          throw new Error(`docker cp failed for ${f.path}: ${cp.stderr.slice(0, 200)}`)
        }
      } finally {
        await unlink(tmp).catch(() => {})
      }
    }
  }

  public async destroy(handle: SandboxHandle): Promise<void> {
    await this.docker(["rm", "-f", handle.id]).catch(() => {})
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async runInContainer(
    handle: SandboxHandle,
    cmd: string[],
    opts: ExecOpts,
    isPython: boolean,
  ): Promise<ExecResult> {
    const pre = await this.snapshotOutput(handle)
    const startedAt = Date.now()
    const r = await this.docker(["exec", handle.id, ...cmd], {
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
    const durationMs = Date.now() - startedAt
    const artifacts = await this.collectArtifacts(handle, pre)

    const result: ExecResult = {
      stdout: decode(r.stdout),
      stderr: r.stderr,
      artifacts,
      exitCode: r.exitCode,
      durationMs,
    }
    if (r.timedOut) {
      result.error = {
        name: "Timeout",
        value: `command exceeded ${String(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)}ms`,
        traceback: "",
      }
    } else if (isPython && r.exitCode !== 0) {
      // E2B parity: surface python failures via `error`, not exitCode.
      const lines = r.stderr.trimEnd().split("\n")
      const last = lines[lines.length - 1] ?? "error"
      const m = /^([A-Za-z_.]*(?:Error|Exception|Warning))\b:?\s*(.*)$/.exec(last)
      result.error = {
        name: m?.[1] ?? "PythonError",
        value: m?.[2] ?? last,
        traceback: r.stderr,
      }
    }
    return result
  }

  /** path -> mtime (epoch seconds) for everything under /mnt/output. */
  private async snapshotOutput(
    handle: SandboxHandle,
  ): Promise<Map<string, number>> {
    const r = await this.docker([
      "exec",
      handle.id,
      "sh",
      "-c",
      `find ${OUTPUT_DIR} -type f -printf '%T@\\t%p\\n' 2>/dev/null || true`,
    ])
    const map = new Map<string, number>()
    for (const line of decode(r.stdout).split("\n")) {
      const tab = line.indexOf("\t")
      if (tab < 0) continue
      const mtime = Number(line.slice(0, tab))
      const path = line.slice(tab + 1)
      if (path) map.set(path, Number.isFinite(mtime) ? mtime : 0)
    }
    return map
  }

  /** Capture files under /mnt/output that are new OR modified since `pre`. */
  private async collectArtifacts(
    handle: SandboxHandle,
    pre: Map<string, number>,
  ): Promise<SandboxArtifact[]> {
    const post = await this.snapshotOutput(handle)
    const out: SandboxArtifact[] = []
    for (const [path, mtime] of post) {
      const prev = pre.get(path)
      const isNew = prev === undefined
      const isModified = prev !== undefined && mtime > prev
      if (!isNew && !isModified) continue

      const artifact: SandboxArtifact = { path }
      const mime = mimeFromExt(path)
      if (mime) artifact.mimeType = mime
      // Skip giant files; the attachment service caps the real limit anyway.
      const stat = await this.docker([
        "exec",
        handle.id,
        "stat",
        "-c",
        "%s",
        path,
      ])
      const size = Number(decode(stat.stdout).trim())
      if (Number.isFinite(size) && size <= MAX_ARTIFACT_BYTES) {
        const bytes = await this.docker(["exec", handle.id, "cat", path])
        if (bytes.exitCode === 0 && bytes.stdout.byteLength > 0) {
          artifact.data = bytes.stdout
        }
      }
      out.push(artifact)
    }
    return out
  }

  private env(): NodeJS.ProcessEnv {
    return this.dockerHost
      ? { ...process.env, DOCKER_HOST: this.dockerHost }
      : process.env
  }

  /** Run `docker <args>` with an optional wall-clock kill. Never rejects —
   *  errors surface as a non-zero exitCode so callers branch on the result. */
  private docker(
    args: string[],
    o: { input?: Uint8Array; timeoutMs?: number } = {},
  ): Promise<DockerRun> {
    return new Promise<DockerRun>((resolve) => {
      const proc = spawn("docker", args, { env: this.env() })
      const out: Buffer[] = []
      const err: Buffer[] = []
      let timedOut = false
      const timer = o.timeoutMs
        ? setTimeout(() => {
            timedOut = true
            proc.kill("SIGKILL")
          }, o.timeoutMs)
        : undefined
      proc.stdout.on("data", (d: Buffer) => out.push(d))
      proc.stderr.on("data", (d: Buffer) => err.push(d))
      if (o.input) {
        proc.stdin.write(Buffer.from(o.input))
        proc.stdin.end()
      }
      proc.on("error", (e: Error) => {
        if (timer) clearTimeout(timer)
        resolve({
          stdout: new Uint8Array(),
          stderr: e.message,
          exitCode: -1,
          timedOut,
        })
      })
      proc.on("close", (code: number | null) => {
        if (timer) clearTimeout(timer)
        resolve({
          stdout: new Uint8Array(Buffer.concat(out)),
          stderr: Buffer.concat(err).toString("utf8"),
          exitCode: code ?? -1,
          timedOut,
        })
      })
    })
  }
}

const decode = (b: Uint8Array): string => new TextDecoder().decode(b)
