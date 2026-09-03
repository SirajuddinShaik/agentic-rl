// Tees debug events (also streamed live via capture.ts) to disk so the
// DebugPanel can re-seed after a reload/redeploy.
//
// Append-only JSONL, one file per runId: cheap appends with no
// read-modify-write, and a crash mid-run still leaves a valid file (torn
// last line is skipped on read). DEBUG_DIR lives under the bind-mounted
// `pi-mono-sessions` so files outlive container replacement.
//
// Best-effort sidecar: a disk error here must NEVER propagate into the
// SSE publish path. Every write log-and-drops; the caller treats
// appendPersistedEvent as fire-and-forget.

import { promises as fs } from "node:fs"
import path from "node:path"

import { baseLogger } from "../../log"
import type { DebugEvent } from "./types"

const Logger = baseLogger("backendv2/pi-mono/debug-persist")

// DEBUG_EVENTS_DIR overrides (tests/ops); else nested under the
// bind-mounted sessions dir so it survives redeploys.
const DEBUG_DIR =
  process.env.DEBUG_EVENTS_DIR ??
  path.join(
    process.env.XYNE_DATA_DIR ?? "./data",
    "pi-mono-sessions",
    "debug-events",
  )

// Cache the mkdir promise so concurrent first-writers await one creation
// instead of racing N mkdir calls.
let dirReady: Promise<void> | null = null
const ensureDir = (): Promise<void> => {
  if (!dirReady) {
    dirReady = fs.mkdir(DEBUG_DIR, { recursive: true }).then(() => undefined)
  }
  return dirReady
}

// Per-runId append serialization: fs.appendFile calls aren't mutually
// atomic, so concurrent appends to one file could interleave and corrupt
// a line. Thread each runId's writes through a promise chain; keyed by
// runId so distinct runs still write concurrently.
const appendChains = new Map<string, Promise<void>>()

// runIds are `run_<uuid>` (storage newId). Validate before building the path so
// a traversal string ("../…") can never escape DEBUG_DIR — defense in depth
// behind the route's run↔conversation ownership check.
const RUN_ID_RE = /^run_[0-9a-f-]+$/
const filePathFor = (runId: string): string => {
  if (!RUN_ID_RE.test(runId)) {
    throw new Error(`debug-persist: invalid runId ${JSON.stringify(runId)}`)
  }
  return path.join(DEBUG_DIR, `${runId}.jsonl`)
}

/** Append one debug event to the run's JSONL file. Fire-and-forget:
 *  returns synchronously, queues the write on the runId's serialized
 *  chain, and never throws/rejects onto the caller so a disk failure
 *  can't break the live SSE stream the event was just published to. */
export const appendPersistedEvent = (
  runId: string,
  event: DebugEvent,
): void => {
  let line: string
  try {
    line = JSON.stringify(event) + "\n"
  } catch (err) {
    // Non-serializable event: drop it rather than wedge the chain, but
    // log so a lost debug event isn't invisible.
    Logger.warn(
      { err, runId, kind: (event as { kind?: string }).kind },
      "debug-persist: failed to serialize event — dropping it",
    )
    return
  }
  const prev = appendChains.get(runId) ?? Promise.resolve()
  const next = prev
    .then(() => ensureDir())
    .then(() => fs.appendFile(filePathFor(runId), line, "utf8"))
    .catch((err) => {
      // Swallow (never rethrow into the SSE path) but log: a silent drop
      // leaves an empty Debug panel after reload with no clue why.
      Logger.warn(
        { err, runId },
        "debug-persist: append failed — debug event not persisted",
      )
    })
  appendChains.set(runId, next)
}

/** Read back every persisted event for a run, in append order. Returns
 *  [] when the file doesn't exist; malformed lines (torn final line after
 *  a crash, or an unparseable future format) are skipped individually. */
export const readPersistedEvents = async (
  runId: string,
): Promise<DebugEvent[]> => {
  let raw: string
  try {
    raw = await fs.readFile(filePathFor(runId), "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    // Real read error (permissions/IO): degrade to empty rather than
    // throw into the route handler, but log so it's not mistaken for
    // "this run had no events".
    Logger.warn(
      { err, runId },
      "debug-persist: read failed — returning empty event list",
    )
    return []
  }
  const events: DebugEvent[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      events.push(JSON.parse(trimmed) as DebugEvent)
    } catch {
      // Skip the bad line, keep whatever else parsed.
    }
  }
  return events
}
