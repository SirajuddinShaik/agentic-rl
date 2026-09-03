import { describe, expect, test } from "bun:test"
import { createConcurrencyGate } from "@/ingestion/docling/workers/concurrencyGate"

const deferred = () => {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((next) => {
    resolve = next
  })

  return { promise, resolve }
}

const flushAsyncWork = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })

describe("createConcurrencyGate", () => {
  test("limits concurrent work to the configured size", async () => {
    const gate = createConcurrencyGate(2)
    const blockers = [deferred(), deferred(), deferred()]
    const startSignals = [deferred(), deferred(), deferred()]
    let active = 0
    let maxActive = 0
    let started = 0

    const tasks = blockers.map((blocker, index) =>
      gate.run(async () => {
        started += 1
        startSignals[index]!.resolve()
        active += 1
        maxActive = Math.max(maxActive, active)
        await blocker.promise
        active -= 1
      }),
    )

    await Promise.all([
      startSignals[0]!.promise,
      startSignals[1]!.promise,
    ])

    expect(started).toBe(2)
    expect(gate.snapshot()).toEqual({ limit: 2, active: 2, queued: 1 })

    blockers[0]!.resolve()
    await startSignals[2]!.promise

    expect(started).toBe(3)
    expect(gate.snapshot()).toEqual({ limit: 2, active: 2, queued: 0 })

    blockers[1]!.resolve()
    blockers[2]!.resolve()
    await Promise.all(tasks)

    expect(maxActive).toBe(2)
    expect(gate.snapshot()).toEqual({ limit: 2, active: 0, queued: 0 })
  })

  test("releases the next permit when work rejects", async () => {
    const gate = createConcurrencyGate(1)
    const blocker = deferred()
    const first = gate.run(async () => {
      await blocker.promise
      throw new Error("conversion failed")
    })
    const second = gate.run(async () => "next")

    await flushAsyncWork()

    expect(gate.snapshot()).toEqual({ limit: 1, active: 1, queued: 1 })

    blocker.resolve()

    await expect(first).rejects.toThrow("conversion failed")
    await expect(second).resolves.toBe("next")
    expect(gate.snapshot()).toEqual({ limit: 1, active: 0, queued: 0 })
  })
})
