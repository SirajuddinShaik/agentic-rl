import { randomUUID } from "node:crypto"
import { getRedisClient } from "@/platform/lib/redisClient"

const PERMIT_PREFIX = "docling:scheduler:permit"

const ACQUIRE_SCRIPT = `
local active_key = KEYS[1]
local meta_key = KEYS[2]
local now_ms = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local expires_at_ms = tonumber(ARGV[3])
local ttl_ms = tonumber(ARGV[4])
local permit_id = ARGV[5]

redis.call("ZREMRANGEBYSCORE", active_key, "-inf", now_ms)

if redis.call("ZCARD", active_key) >= capacity then
  return 0
end

redis.call("ZADD", active_key, expires_at_ms, permit_id)
redis.call("HSET", meta_key, "permitId", permit_id, "kind", ARGV[6], "owner", ARGV[7], "createdAt", ARGV[8], "expiresAt", ARGV[3], "metadata", ARGV[9])
redis.call("PEXPIRE", meta_key, ttl_ms)
return 1
`

const ACQUIRE_WEIGHTED_SCRIPT = `
local active_key = KEYS[1]
local meta_prefix = ARGV[1]
local now_ms = tonumber(ARGV[2])
local capacity = tonumber(ARGV[3])
local weight = tonumber(ARGV[4])
local expires_at_ms = tonumber(ARGV[5])
local ttl_ms = tonumber(ARGV[6])
local permit_id = ARGV[7]
local allow_oversize = ARGV[12] == "1"

local expired = redis.call("ZRANGEBYSCORE", active_key, "-inf", now_ms)
for _, expired_id in ipairs(expired) do
  redis.call("DEL", meta_prefix .. expired_id)
end
redis.call("ZREMRANGEBYSCORE", active_key, "-inf", now_ms)

local used = 0
local active_ids = redis.call("ZRANGE", active_key, 0, -1)
for _, active_id in ipairs(active_ids) do
  local active_weight = tonumber(redis.call("HGET", meta_prefix .. active_id, "weight"))
  if active_weight then
    used = used + active_weight
  else
    redis.call("ZREM", active_key, active_id)
  end
end

if used + weight > capacity and not (allow_oversize and used == 0) then
  return 0
end

local meta_key = meta_prefix .. permit_id
redis.call("ZADD", active_key, expires_at_ms, permit_id)
redis.call("HSET", meta_key, "permitId", permit_id, "kind", ARGV[8], "owner", ARGV[9], "createdAt", ARGV[10], "expiresAt", ARGV[5], "metadata", ARGV[11], "weight", ARGV[4])
redis.call("PEXPIRE", meta_key, ttl_ms)
return 1
`

const RELEASE_SCRIPT = `
local removed = redis.call("ZREM", KEYS[1], ARGV[1])
redis.call("DEL", KEYS[2])
return removed
`

export type DoclingSchedulerPermit = {
  kind: string
  permitId: string
}

const activeKey = (kind: string) => `${PERMIT_PREFIX}:${kind}:active`
const metaKey = (kind: string, permitId: string) =>
  `${PERMIT_PREFIX}:${kind}:${permitId}`

export const tryAcquireDoclingSchedulerPermit = async (input: {
  kind: string
  capacity: number
  ttlMs: number
  owner: string
  metadata?: Record<string, unknown>
}): Promise<DoclingSchedulerPermit | null> => {
  if (input.capacity <= 0) {
    return null
  }

  const now = Date.now()
  const permitId = randomUUID()
  const redis = await getRedisClient()
  const acquired = await redis.sendCommand([
    "EVAL",
    ACQUIRE_SCRIPT,
    "2",
    activeKey(input.kind),
    metaKey(input.kind, permitId),
    String(now),
    String(input.capacity),
    String(now + input.ttlMs),
    String(input.ttlMs),
    permitId,
    input.kind,
    input.owner,
    new Date(now).toISOString(),
    JSON.stringify(input.metadata || {}),
  ])

  return Number(acquired) > 0 ? { kind: input.kind, permitId } : null
}

export const tryAcquireDoclingSchedulerWeightedPermit = async (input: {
  kind: string
  permitId: string
  capacity: number
  weight: number
  ttlMs: number
  owner: string
  allowOversizeWhenEmpty?: boolean
  metadata?: Record<string, unknown>
}): Promise<DoclingSchedulerPermit | null> => {
  const capacity = Math.floor(input.capacity)
  const weight = Math.max(Math.floor(input.weight), 1)
  if (capacity <= 0 || !input.permitId) {
    return null
  }

  const now = Date.now()
  const redis = await getRedisClient()
  const acquired = await redis.sendCommand([
    "EVAL",
    ACQUIRE_WEIGHTED_SCRIPT,
    "1",
    activeKey(input.kind),
    `${PERMIT_PREFIX}:${input.kind}:`,
    String(now),
    String(capacity),
    String(weight),
    String(now + input.ttlMs),
    String(input.ttlMs),
    input.permitId,
    input.kind,
    input.owner,
    new Date(now).toISOString(),
    JSON.stringify(input.metadata || {}),
    input.allowOversizeWhenEmpty ? "1" : "0",
  ])

  return Number(acquired) > 0
    ? { kind: input.kind, permitId: input.permitId }
    : null
}

export const releaseDoclingSchedulerPermit = async (
  permit: DoclingSchedulerPermit | { kind: string; permitId?: string | null },
) => {
  if (!permit.permitId || permit.permitId.startsWith("disabled:")) {
    return
  }

  const redis = await getRedisClient()
  await redis.sendCommand([
    "EVAL",
    RELEASE_SCRIPT,
    "2",
    activeKey(permit.kind),
    metaKey(permit.kind, permit.permitId),
    permit.permitId,
  ])
}

export const releaseDoclingOcrSubmitPermit = async (
  permit: DoclingSchedulerPermit | { permitId?: string | null },
) => {
  if (!permit.permitId || permit.permitId.startsWith("disabled:")) {
    return
  }

  await Promise.all([
    releaseDoclingSchedulerPermit({
      kind: "ocr-submit",
      permitId: permit.permitId,
    }),
    releaseDoclingSchedulerPermit({
      kind: "ocr-submit-pages",
      permitId: permit.permitId,
    }),
  ])
}

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string | number => {
          return typeof item === "string" || typeof item === "number"
        })
        .map(String)
    : []

export const listActiveDoclingSchedulerPermitIds = async (
  kind: string,
  limit: number,
): Promise<string[]> => {
  const redis = await getRedisClient()
  const active = activeKey(kind)
  await redis.sendCommand([
    "ZREMRANGEBYSCORE",
    active,
    "-inf",
    String(Date.now()),
  ])
  return stringArray(
    await redis.sendCommand([
      "ZRANGE",
      active,
      "0",
      String(Math.max(limit, 1) - 1),
    ]),
  )
}
