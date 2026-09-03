// Sandbox client interface. Decouples pi-mono's `computer` tool from the
// concrete sandbox provider (E2B today, self-hosted later).

export interface SandboxArtifact {
  path: string
  mimeType?: string
  /** Inline bytes only for small text/image artifacts (< MAX_ARTIFACT_BYTES). */
  data?: Uint8Array
}

export interface ExecResult {
  stdout: string
  stderr: string
  /** Set on unhandled exception. We don't model the provider event stream;
   *  one tool-call → one final outcome. */
  error?: {
    name: string
    value: string
    traceback: string
  }
  artifacts: SandboxArtifact[]
  /** Only set by `bash`; `exec` (Python) reports failure via `error` instead. */
  exitCode?: number
  /** Excludes sandbox boot time — that's measured separately on create. */
  durationMs: number
}

export interface ExecOpts {
  timeoutMs?: number
}

export interface SandboxHandle {
  id: string
  /** Best-effort reachability; stale handles mean "needs fresh sandbox". */
  isAlive(): Promise<boolean>
}

export interface SandboxFileUpload {
  /** Caller picks a safe absolute path — no traversal checks here. */
  path: string
  bytes: Uint8Array
}

export interface SandboxClient {
  /** May return a pre-warmed sandbox from a pool. */
  create(): Promise<SandboxHandle>

  /** Python state (variables, imports, files) persists across calls on the same handle. */
  exec(handle: SandboxHandle, code: string, opts?: ExecOpts): Promise<ExecResult>

  /** Filesystem persists across calls, but no in-memory state like `exec`. */
  bash(handle: SandboxHandle, command: string, opts?: ExecOpts): Promise<ExecResult>

  readFile(handle: SandboxHandle, path: string): Promise<string>

  /** Idempotent. Implementations should batch via the provider's array write (E2B `files.write`). */
  uploadFiles(handle: SandboxHandle, files: SandboxFileUpload[]): Promise<void>

  /** Best-effort — must not throw on already-gone sandboxes. */
  destroy(handle: SandboxHandle): Promise<void>
}
