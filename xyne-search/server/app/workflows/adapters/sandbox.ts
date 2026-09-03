// SandboxAdapter for the workflow SDK, backed by xyne-search's existing
// SandboxClient (E2B or self-hosted Docker). The workflow model is
// per-execution (one sandbox per agent-step run), so we wrap the low-level
// SandboxClient directly rather than the conversation-scoped SandboxManager.
//
// The SDK's `run_code` tool drives this via `ctx.sandbox`; the agent step
// creates one session per execution, mounts inputs at /mnt/files, and collects
// files written to /mnt/output as artifacts.

import type {
  SandboxAdapter,
  SandboxHandle as SdkSandboxHandle,
  SandboxExecResult,
  SandboxExecOptions,
} from "@xyne/workflow-sdk"
import type {
  SandboxClient,
  SandboxHandle,
  ExecResult,
  ExecOpts,
} from "@/platform/lib/sandbox/types"
import { getLogger } from "@/platform/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Api).child({ module: "workflow-sandbox" })

/** Instantiate the configured sandbox backend (mirrors getSandboxManager's selection). */
function createSandboxClient(): SandboxClient | undefined {
  const backend = (process.env["SANDBOX_BACKEND"] ?? "e2b").toLowerCase()

  if (backend === "docker") {
    const image = process.env["DOCKER_SANDBOX_IMAGE"]
    if (!image) {
      Logger.warn("SANDBOX_BACKEND=docker but DOCKER_SANDBOX_IMAGE not set — run_code unavailable")
      return undefined
    }
    const dockerHost = process.env["DOCKER_SANDBOX_HOST"] ?? process.env["DOCKER_HOST"]
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { DockerSandboxClient } = require("@/platform/lib/sandbox/docker") as typeof import("@/platform/lib/sandbox/docker")
    Logger.info({ image, dockerHost: dockerHost ?? "(local)" }, "workflow sandbox: Docker backend")
    return new DockerSandboxClient({
      image,
      ...(dockerHost ? { dockerHost } : {}),
      ...(process.env["DOCKER_SANDBOX_MEMORY"] ? { memory: process.env["DOCKER_SANDBOX_MEMORY"] } : {}),
      ...(process.env["DOCKER_SANDBOX_CPUS"] ? { cpus: process.env["DOCKER_SANDBOX_CPUS"] } : {}),
    })
  }

  const apiKey = process.env["E2B_API_KEY"]
  if (!apiKey) {
    Logger.warn("E2B_API_KEY not set — run_code unavailable in workflows")
    return undefined
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { E2BSandboxClient } = require("@/platform/lib/sandbox/e2b") as typeof import("@/platform/lib/sandbox/e2b")
  const template = process.env["E2B_TEMPLATE"]
  Logger.info({ template: template ?? "(default)" }, "workflow sandbox: E2B backend")
  return new E2BSandboxClient({ apiKey, ...(template ? { template } : {}) })
}

function toExecOpts(opts?: SandboxExecOptions): ExecOpts | undefined {
  return opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : undefined
}

function mapResult(r: ExecResult): SandboxExecResult {
  return {
    stdout: r.stdout,
    stderr: r.stderr,
    durationMs: r.durationMs,
    ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
    ...(r.error ? { error: r.error } : {}),
    // Only artifacts with inline bytes can become downloadable workflow
    // artifacts; large outputs (path-only) are skipped here.
    artifacts: r.artifacts
      .filter((a): a is typeof a & { data: Uint8Array } => a.data !== undefined)
      .map((a) => ({
        path: a.path,
        bytes: a.data,
        mimeType: a.mimeType ?? "application/octet-stream",
      })),
  }
}

/**
 * Build a workflow-SDK SandboxAdapter, or `undefined` if no backend is
 * configured (caller then skips registering `run_code`).
 */
export function createWorkflowSandboxAdapter(): SandboxAdapter | undefined {
  const client = createSandboxClient()
  if (!client) return undefined

  // Map the SDK's lightweight handle ({ id }) back to the provider's handle
  // (which also carries isAlive()).
  const handles = new Map<string, SandboxHandle>()
  const resolve = (h: SdkSandboxHandle): SandboxHandle => {
    const real = handles.get(h.id)
    if (!real) throw new Error(`Unknown sandbox handle: ${h.id}`)
    return real
  }

  return {
    async create() {
      const handle = await client.create()
      handles.set(handle.id, handle)
      return { id: handle.id }
    },
    async exec(h, code, opts) {
      return mapResult(await client.exec(resolve(h), code, toExecOpts(opts)))
    },
    async bash(h, command, opts) {
      return mapResult(await client.bash(resolve(h), command, toExecOpts(opts)))
    },
    async writeFiles(h, files) {
      await client.uploadFiles(resolve(h), files.map((f) => ({ path: f.path, bytes: f.bytes })))
    },
    async readFile(h, path) {
      return new TextEncoder().encode(await client.readFile(resolve(h), path))
    },
    async destroy(h) {
      try {
        await client.destroy(resolve(h))
      } finally {
        handles.delete(h.id)
      }
    },
  }
}
