// Per-conversation sandbox lifecycle: one sandbox per conversation, kept alive
// for IDLE_TTL_MS after the last exec, swept when expired.
// In-memory map only works single-process; swap for Redis when xyne-app scales
// to multiple replicas (public API unchanged).

import { getLogger } from "@/platform/logger"
import { Subsystem } from "@/types"

import {
  listChatAttachments,
  readChatAttachmentBytes,
} from "@/app/agent/services/chatAttachments"

import type {
  ExecOpts,
  ExecResult,
  SandboxClient,
  SandboxHandle,
} from "./types"

// Also referenced in the system prompt; keep in sync so the two don't drift.
export const SANDBOX_FILES_DIR = "/mnt/files"

// Mirrors the constant in e2b.ts — keep in sync. Assistant artifacts are
// re-pushed here on boot so they survive idle evictions.
export const SANDBOX_OUTPUT_DIR = "/mnt/output"

const Logger = getLogger(Subsystem.Chat)

// Idle eviction window: 15 min covers the iterate-then-refine pattern. Env-tunable.
const DEFAULT_IDLE_TTL_MS = 15 * 60 * 1000

const SWEEP_INTERVAL_MS = 60 * 1000

interface SandboxLease {
  conversationId: string
  userEmail: string
  handle: SandboxHandle
  lastUsedAt: number
  createdAt: number
  // Attachments pushed lazily on first exec, so unused conversations pay nothing.
  filesSynced: boolean
  // Manifest snapshot from sync time, used to build the system-prompt file list.
  syncedFiles: { fileName: string; sizeBytes: number; mimeType: string }[]
}

export interface SandboxManagerOpts {
  client: SandboxClient
  idleTtlMs?: number
}

export class SandboxManager {
  private readonly client: SandboxClient
  private readonly idleTtlMs: number
  private readonly leases = new Map<string, SandboxLease>()
  // Coalesces concurrent create() calls so one conversation boots one sandbox.
  private readonly pendingCreates = new Map<string, Promise<SandboxLease>>()
  private sweeperHandle: ReturnType<typeof setInterval> | undefined

  public constructor(opts: SandboxManagerOpts) {
    this.client = opts.client
    this.idleTtlMs = opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS
    this.startSweeper()
  }

  /** Lease the conversation's sandbox, creating it on first call and refreshing
   *  the idle clock thereafter. */
  public async lease(args: {
    conversationId: string
    userEmail: string
    onProgress?: (label: string, level?: "info" | "ok" | "error") => void
  }): Promise<SandboxHandle> {
    const key = this.keyFor(args.conversationId)
    const existing = this.leases.get(key)
    if (existing) {
      // Provider may have evicted it out from under us; drop and recreate if dead.
      if (await existing.handle.isAlive()) {
        existing.lastUsedAt = Date.now()
        return existing.handle
      }
      Logger.info(
        {
          conversationId: args.conversationId,
          sandboxId: existing.handle.id,
        },
        "sandbox: stale lease detected — creating fresh sandbox",
      )
      this.leases.delete(key)
    }

    const pending = this.pendingCreates.get(key)
    if (pending) {
      const lease = await pending
      lease.lastUsedAt = Date.now()
      return lease.handle
    }
    const createPromise = (async (): Promise<SandboxLease> => {
      const bootStartedAt = Date.now()
      args.onProgress?.("Starting computer sandbox…")
      const handle = await this.client.create()
      const bootMs = Date.now() - bootStartedAt
      args.onProgress?.(`Sandbox ready in ${(bootMs / 1000).toFixed(1)}s`, "ok")
      const lease: SandboxLease = {
        conversationId: args.conversationId,
        userEmail: args.userEmail,
        handle,
        lastUsedAt: Date.now(),
        createdAt: Date.now(),
        filesSynced: false,
        syncedFiles: [],
      }
      this.leases.set(key, lease)
      Logger.info(
        {
          conversationId: args.conversationId,
          userEmail: args.userEmail,
          sandboxId: handle.id,
          activeLeases: this.leases.size,
        },
        "sandbox: lease taken",
      )
      return lease
    })()
    this.pendingCreates.set(key, createPromise)
    try {
      const lease = await createPromise
      return lease.handle
    } finally {
      this.pendingCreates.delete(key)
    }
  }

  /** Lease + sync files + exec in one shot, so tools needn't touch the
   *  SandboxClient. `onProgress` streams boot/upload steps to the SSE stream;
   *  it must never throw into us. */
  public async exec(args: {
    conversationId: string
    userEmail: string
    code: string
    opts?: ExecOpts
    onProgress?: (label: string, level?: "info" | "ok" | "error") => void
  }): Promise<ExecResult> {
    const progress = (l: string, lvl: "info" | "ok" | "error" = "info"): void => {
      try {
        args.onProgress?.(l, lvl)
      } catch {
        /* never let UI plumbing break a tool call */
      }
    }
    const handle = await this.lease({
      conversationId: args.conversationId,
      userEmail: args.userEmail,
      onProgress: progress,
    })
    await this.ensureFilesSynced(args.conversationId, progress)
    return this.client.exec(handle, args.code, args.opts ?? {})
  }

  /** Lease + sync files + run a shell command. Same handle as `exec`, so the
   *  filesystem persists across calls. */
  public async bash(args: {
    conversationId: string
    userEmail: string
    command: string
    opts?: ExecOpts
    onProgress?: (label: string, level?: "info" | "ok" | "error") => void
  }): Promise<ExecResult> {
    const progress = (l: string, lvl: "info" | "ok" | "error" = "info"): void => {
      try {
        args.onProgress?.(l, lvl)
      } catch {
        /* never let UI plumbing break a tool call */
      }
    }
    const handle = await this.lease({
      conversationId: args.conversationId,
      userEmail: args.userEmail,
      onProgress: progress,
    })
    await this.ensureFilesSynced(args.conversationId, progress)
    return this.client.bash(handle, args.command, args.opts ?? {})
  }

  /** Lease + write a file into the sandbox (create or overwrite). */
  public async writeFile(args: {
    conversationId: string
    userEmail: string
    path: string
    bytes: Uint8Array
    onProgress?: (label: string, level?: "info" | "ok" | "error") => void
  }): Promise<void> {
    const progress = (l: string, lvl: "info" | "ok" | "error" = "info"): void => {
      try {
        args.onProgress?.(l, lvl)
      } catch {
        /* never let UI plumbing break a tool call */
      }
    }
    const handle = await this.lease({
      conversationId: args.conversationId,
      userEmail: args.userEmail,
      onProgress: progress,
    })
    await this.ensureFilesSynced(args.conversationId, progress)
    await this.client.uploadFiles(handle, [{ path: args.path, bytes: args.bytes }])
  }

  /** Lease + read a UTF-8 text file from the sandbox. */
  public async readFile(args: {
    conversationId: string
    userEmail: string
    path: string
    onProgress?: (label: string, level?: "info" | "ok" | "error") => void
  }): Promise<string> {
    const progress = (l: string, lvl: "info" | "ok" | "error" = "info"): void => {
      try {
        args.onProgress?.(l, lvl)
      } catch {
        /* never let UI plumbing break a tool call */
      }
    }
    const handle = await this.lease({
      conversationId: args.conversationId,
      userEmail: args.userEmail,
      onProgress: progress,
    })
    await this.ensureFilesSynced(args.conversationId, progress)
    return this.client.readFile(handle, args.path)
  }

  /** Push the conversation's attachments into its sandbox on first exec.
   *  Idempotent. Upload failures bubble so the user sees a clear error rather
   *  than a silently missing file. */
  private async ensureFilesSynced(
    conversationId: string,
    onProgress?: (label: string, level?: "info" | "ok" | "error") => void,
  ): Promise<void> {
    const lease = this.leases.get(this.keyFor(conversationId))
    if (!lease || lease.filesSynced) return
    const attachments = await listChatAttachments(conversationId)
    if (attachments.length === 0) {
      lease.filesSynced = true
      lease.syncedFiles = []
      return
    }
    const formatBytes = (n: number): string => {
      if (n < 1024) return `${String(n)} B`
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
      return `${(n / (1024 * 1024)).toFixed(1)} MB`
    }
    onProgress?.(
      attachments.length === 1
        ? `Uploading ${attachments[0]!.fileName} (${formatBytes(attachments[0]!.sizeBytes)})…`
        : `Uploading ${String(attachments.length)} files…`,
    )
    // Bytes live on local disk, so this fan-out is cheap; the client batches the upload.
    const blobs = await Promise.all(
      attachments.map(async (a) => {
        const { bytes } = await readChatAttachmentBytes(conversationId, a.id)
        return { attachment: a, bytes }
      }),
    )
    // Route by uploader: user files to /mnt/files (where the prompt points the
    // model), prior assistant artifacts back to /mnt/output so they survive an
    // idle eviction that wiped the sandbox.
    const uploadEntries = blobs.map((b) => ({
      path:
        b.attachment.uploadedBy === "assistant"
          ? `${SANDBOX_OUTPUT_DIR}/${b.attachment.fileName}`
          : `${SANDBOX_FILES_DIR}/${b.attachment.fileName}`,
      bytes: b.bytes,
    }))
    const uploadStartedAt = Date.now()
    await this.client.uploadFiles(lease.handle, uploadEntries)
    const uploadMs = Date.now() - uploadStartedAt
    onProgress?.(
      `Files ready (${(uploadMs / 1000).toFixed(1)}s)`,
      "ok",
    )
    lease.filesSynced = true
    lease.syncedFiles = blobs.map((b) => ({
      fileName: b.attachment.fileName,
      sizeBytes: b.attachment.sizeBytes,
      mimeType: b.attachment.mimeType,
    }))
    Logger.info(
      {
        conversationId,
        fileCount: blobs.length,
        totalBytes: blobs.reduce((acc, b) => acc + b.bytes.byteLength, 0),
      },
      "sandbox: synced attachments",
    )
  }

  /** Manifest captured at sync time, for the system prompt's file list. Empty
   *  until files are synced (or if none are attached). */
  public filesSyncedFor(
    conversationId: string,
  ): { fileName: string; sizeBytes: number; mimeType: string }[] {
    const lease = this.leases.get(this.keyFor(conversationId))
    return lease?.syncedFiles ?? []
  }

  /** Manually release a conversation's sandbox. The sweeper covers the common
   *  case; this is for an explicit end-of-chat (not yet wired to the UI). */
  public async release(conversationId: string): Promise<void> {
    const key = this.keyFor(conversationId)
    const lease = this.leases.get(key)
    if (!lease) return
    this.leases.delete(key)
    await this.client.destroy(lease.handle)
  }

  /** Stop the sweeper and tear down all live sandboxes. Called on graceful
   *  shutdown so we don't leak E2B/Docker resources. */
  public async shutdown(): Promise<void> {
    if (this.sweeperHandle) clearInterval(this.sweeperHandle)
    this.sweeperHandle = undefined
    const all = Array.from(this.leases.values())
    this.leases.clear()
    await Promise.allSettled(all.map((l) => this.client.destroy(l.handle)))
  }

  public activeLeaseCount(): number {
    return this.leases.size
  }

  private keyFor(conversationId: string): string {
    return conversationId
  }

  private startSweeper(): void {
    if (this.sweeperHandle) return
    this.sweeperHandle = setInterval(() => {
      void this.sweep()
    }, SWEEP_INTERVAL_MS)
    // unref so the sweeper alone can't keep the process alive (clean test exit).
    const h = this.sweeperHandle as unknown as { unref?: () => void }
    h.unref?.()
  }

  private async sweep(): Promise<void> {
    const now = Date.now()
    const expired: SandboxLease[] = []
    for (const [key, lease] of this.leases) {
      if (now - lease.lastUsedAt > this.idleTtlMs) {
        expired.push(lease)
        this.leases.delete(key)
      }
    }
    if (expired.length === 0) return
    Logger.info(
      {
        evictedCount: expired.length,
        activeLeases: this.leases.size,
      },
      "sandbox: sweeping idle leases",
    )
    await Promise.allSettled(
      expired.map((l) => this.client.destroy(l.handle)),
    )
  }
}

// Lazy singleton: importing this module is free until a chat actually runs code.
// Gated on backend config (e.g. E2B_API_KEY); returns undefined when unset so the
// tool factory can skip registration.
let singleton: SandboxManager | undefined
let initFailed = false

export function getSandboxManager(): SandboxManager | undefined {
  if (singleton) return singleton
  if (initFailed) return undefined

  // SANDBOX_BACKEND=docker runs containers on any Docker host; anything else uses
  // E2B. Dynamic require() below so the unselected SDK is never pulled in.
  const backend = (process.env["SANDBOX_BACKEND"] ?? "e2b").toLowerCase()
  let client: SandboxClient

  if (backend === "docker") {
    const image = process.env["DOCKER_SANDBOX_IMAGE"]
    if (!image) {
      Logger.warn(
        "sandbox: SANDBOX_BACKEND=docker but DOCKER_SANDBOX_IMAGE not set — computer tool unavailable",
      )
      initFailed = true
      return undefined
    }
    // Dedicated host var so it doesn't perturb other docker usage; falls back to
    // DOCKER_HOST, then the local daemon.
    const dockerHost =
      process.env["DOCKER_SANDBOX_HOST"] ?? process.env["DOCKER_HOST"]
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { DockerSandboxClient } = require("./docker") as typeof import("./docker")
    client = new DockerSandboxClient({
      image,
      ...(dockerHost ? { dockerHost } : {}),
      ...(process.env["DOCKER_SANDBOX_MEMORY"]
        ? { memory: process.env["DOCKER_SANDBOX_MEMORY"] }
        : {}),
      ...(process.env["DOCKER_SANDBOX_CPUS"]
        ? { cpus: process.env["DOCKER_SANDBOX_CPUS"] }
        : {}),
    })
    Logger.info(
      { image, dockerHost: dockerHost ?? "(local)" },
      "sandbox: using Docker backend",
    )
  } else {
    const apiKey = process.env["E2B_API_KEY"]
    if (!apiKey) {
      Logger.warn(
        "sandbox: E2B_API_KEY not set — computer tool will be unavailable",
      )
      initFailed = true
      return undefined
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { E2BSandboxClient } = require("./e2b") as typeof import("./e2b")
    const template = process.env["E2B_TEMPLATE"]
    client = new E2BSandboxClient({
      apiKey,
      ...(template ? { template } : {}),
    })
    if (template) {
      Logger.info({ template }, "sandbox: using custom E2B template")
    }
  }

  const idleTtlEnv = process.env["BACKENDV2_SANDBOX_IDLE_TTL_MS"]
  const idleTtlMs = idleTtlEnv ? Number(idleTtlEnv) : undefined
  singleton = new SandboxManager({
    client,
    ...(idleTtlMs && idleTtlMs > 0 ? { idleTtlMs } : {}),
  })
  return singleton
}
