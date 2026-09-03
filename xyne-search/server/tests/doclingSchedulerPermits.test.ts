import { beforeEach, describe, expect, mock, test } from "bun:test"

process.env.ENCRYPTION_KEY ??= "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

type HashValue = Record<string, string>

class FakeRedis {
  zsets = new Map<string, Map<string, number>>()
  hashes = new Map<string, HashValue>()

  private zset(key: string) {
    let zset = this.zsets.get(key)
    if (!zset) {
      zset = new Map()
      this.zsets.set(key, zset)
    }
    return zset
  }

  private pruneExpired(activeKey: string, nowMs: number, metaPrefix?: string) {
    const zset = this.zset(activeKey)
    for (const [permitId, score] of Array.from(zset.entries())) {
      if (score <= nowMs) {
        zset.delete(permitId)
        if (metaPrefix) {
          this.hashes.delete(`${metaPrefix}${permitId}`)
        }
      }
    }
  }

  private acquireRequestPermit(command: string[]) {
    const activeKey = command[3]!
    const metaKey = command[4]!
    const nowMs = Number(command[5])
    const capacity = Number(command[6])
    const expiresAtMs = Number(command[7])
    const permitId = command[9]!
    const kind = command[10]!
    const owner = command[11]!
    const createdAt = command[12]!
    const metadata = command[14]!

    this.pruneExpired(activeKey, nowMs)
    const zset = this.zset(activeKey)
    if (zset.size >= capacity) {
      return 0
    }

    zset.set(permitId, expiresAtMs)
    this.hashes.set(metaKey, {
      permitId,
      kind,
      owner,
      createdAt,
      expiresAt: command[7]!,
      metadata,
    })
    return 1
  }

  private acquireWeightedPermit(command: string[]) {
    const activeKey = command[3]!
    const metaPrefix = command[4]!
    const nowMs = Number(command[5])
    const capacity = Number(command[6])
    const weight = Number(command[7])
    const expiresAtMs = Number(command[8])
    const permitId = command[10]!
    const kind = command[11]!
    const owner = command[12]!
    const createdAt = command[13]!
    const metadata = command[14]!
    const allowOversizeWhenEmpty = command[15] === "1"

    this.pruneExpired(activeKey, nowMs, metaPrefix)
    const zset = this.zset(activeKey)
    let used = 0
    for (const activePermitId of Array.from(zset.keys())) {
      const metaKey = `${metaPrefix}${activePermitId}`
      const activeWeight = Number(this.hashes.get(metaKey)?.weight)
      if (Number.isFinite(activeWeight) && activeWeight > 0) {
        used += activeWeight
      } else {
        zset.delete(activePermitId)
      }
    }

    if (
      used + weight > capacity &&
      !(allowOversizeWhenEmpty && used === 0)
    ) {
      return 0
    }

    zset.set(permitId, expiresAtMs)
    this.hashes.set(`${metaPrefix}${permitId}`, {
      permitId,
      kind,
      owner,
      createdAt,
      expiresAt: command[8]!,
      metadata,
      weight: String(weight),
    })
    return 1
  }

  private releasePermit(command: string[]) {
    const activeKey = command[3]!
    const metaKey = command[4]!
    const permitId = command[5]!
    const removed = this.zset(activeKey).delete(permitId) ? 1 : 0
    this.hashes.delete(metaKey)
    return removed
  }

  async sendCommand(command: string[]) {
    const script = command[1] || ""
    if (script.includes("allow_oversize")) {
      return this.acquireWeightedPermit(command)
    }
    if (script.includes("ZCARD")) {
      return this.acquireRequestPermit(command)
    }
    if (script.includes("ZREM")) {
      return this.releasePermit(command)
    }
    throw new Error(`Unhandled fake Redis command: ${command.join(" ")}`)
  }
}

let redisRequested = false
let redis: FakeRedis | null = null

mock.module("@/platform/lib/redisClient", () => ({
  getRedisClient: async () => {
    redisRequested = true
    if (!redis) {
      throw new Error("redis should not be requested for zero capacity")
    }
    return redis
  },
}))

const {
  releaseDoclingOcrSubmitPermit,
  tryAcquireDoclingSchedulerPermit,
  tryAcquireDoclingSchedulerWeightedPermit,
} = await import("@/ingestion/docling/scheduler/permits")

describe("Docling scheduler permits", () => {
  beforeEach(() => {
    redisRequested = false
    redis = null
  })

  test("capacity zero blocks acquisition", async () => {
    const permit = await tryAcquireDoclingSchedulerPermit({
      kind: "ocr-submit",
      capacity: 0,
      ttlMs: 1000,
      owner: "test",
    })

    expect(permit).toBeNull()
    expect(redisRequested).toBe(false)
  })

  test("weighted capacity zero blocks acquisition", async () => {
    const permit = await tryAcquireDoclingSchedulerWeightedPermit({
      kind: "ocr-submit-pages",
      permitId: "permit-1",
      capacity: 0,
      weight: 1,
      ttlMs: 1000,
      owner: "test",
    })

    expect(permit).toBeNull()
    expect(redisRequested).toBe(false)
  })

  test("weighted permits sum page weights and reject over capacity", async () => {
    redis = new FakeRedis()

    const first = await tryAcquireDoclingSchedulerWeightedPermit({
      kind: "ocr-submit-pages",
      permitId: "permit-1",
      capacity: 10,
      weight: 6,
      ttlMs: 1000,
      owner: "test",
    })
    const second = await tryAcquireDoclingSchedulerWeightedPermit({
      kind: "ocr-submit-pages",
      permitId: "permit-2",
      capacity: 10,
      weight: 4,
      ttlMs: 1000,
      owner: "test",
    })
    const rejected = await tryAcquireDoclingSchedulerWeightedPermit({
      kind: "ocr-submit-pages",
      permitId: "permit-3",
      capacity: 10,
      weight: 1,
      ttlMs: 1000,
      owner: "test",
    })

    expect(first?.permitId).toBe("permit-1")
    expect(second?.permitId).toBe("permit-2")
    expect(rejected).toBeNull()
    expect(
      redis.zsets.get("docling:scheduler:permit:ocr-submit-pages:active")
        ?.size,
    ).toBe(2)
  })

  test("weighted permits allow one oversize permit only when empty", async () => {
    redis = new FakeRedis()

    const oversize = await tryAcquireDoclingSchedulerWeightedPermit({
      kind: "ocr-submit-pages",
      permitId: "permit-oversize",
      capacity: 10,
      weight: 25,
      ttlMs: 1000,
      owner: "test",
      allowOversizeWhenEmpty: true,
    })
    const rejected = await tryAcquireDoclingSchedulerWeightedPermit({
      kind: "ocr-submit-pages",
      permitId: "permit-extra",
      capacity: 10,
      weight: 1,
      ttlMs: 1000,
      owner: "test",
      allowOversizeWhenEmpty: true,
    })

    expect(oversize?.permitId).toBe("permit-oversize")
    expect(rejected).toBeNull()
  })

  test("OCR submit release removes request and page permits", async () => {
    redis = new FakeRedis()
    const requestPermit = await tryAcquireDoclingSchedulerPermit({
      kind: "ocr-submit",
      capacity: 10,
      ttlMs: 1000,
      owner: "test",
    })
    expect(requestPermit).not.toBeNull()

    const pagePermit = await tryAcquireDoclingSchedulerWeightedPermit({
      kind: "ocr-submit-pages",
      permitId: requestPermit!.permitId,
      capacity: 10,
      weight: 3,
      ttlMs: 1000,
      owner: "test",
    })
    expect(pagePermit).not.toBeNull()

    await releaseDoclingOcrSubmitPermit(requestPermit!)

    expect(redis.zsets.get("docling:scheduler:permit:ocr-submit:active")?.size).toBe(0)
    expect(
      redis.zsets.get("docling:scheduler:permit:ocr-submit-pages:active")
        ?.size,
    ).toBe(0)
    expect(
      redis.hashes.has(
        `docling:scheduler:permit:ocr-submit:${requestPermit!.permitId}`,
      ),
    ).toBe(false)
    expect(
      redis.hashes.has(
        `docling:scheduler:permit:ocr-submit-pages:${requestPermit!.permitId}`,
      ),
    ).toBe(false)
  })
})
