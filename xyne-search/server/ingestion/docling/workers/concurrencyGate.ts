export type ConcurrencyGateSnapshot = {
  limit: number
  active: number
  queued: number
}

export const createConcurrencyGate = (limit: number) => {
  const effectiveLimit =
    Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1
  let active = 0
  const waiters: Array<() => void> = []

  const acquire = async () => {
    if (active < effectiveLimit) {
      active += 1
      return
    }

    await new Promise<void>((resolve) => {
      waiters.push(resolve)
    })
  }

  const release = () => {
    const next = waiters.shift()
    if (next) {
      next()
      return
    }

    active = Math.max(active - 1, 0)
  }

  return {
    run: async <T>(fn: () => Promise<T>): Promise<T> => {
      await acquire()
      try {
        return await fn()
      } finally {
        release()
      }
    },
    snapshot: (): ConcurrencyGateSnapshot => ({
      limit: effectiveLimit,
      active,
      queued: waiters.length,
    }),
  }
}
