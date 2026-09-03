import { type Context, Hono, type Next } from "hono"
import { HTTPException } from "hono/http-exception"
import { db } from "@/platform/db/client"
import { sql } from "drizzle-orm"
import { getLogger } from "@/platform/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Api).child({ module: "backendv2/analytics" })

type Vars = {
  jwtPayload: { sub: string; workspaceId: string; role: string }
}

const AdminMiddleware = async (
  c: Context<{ Variables: Vars }>,
  next: Next,
): Promise<void> => {
  const role = c.get("jwtPayload").role
  if (role !== "SuperAdmin") {
    throw new HTTPException(403, { message: "SuperAdmin access required" })
  }
  await next()
}

function analyticsTimeRange(c: Context): { fromMs: number; toMs: number } {
  const q = c.req.query()
  // When `to` is a date-only string (YYYY-MM-DD) it parses to midnight UTC,
  // which excludes everything created later that same day. Add a full day so
  // the upper bound is the end of the requested date.
  const toMs = q["to"] ? new Date(q["to"]).getTime() + 86_400_000 - 1 : Date.now()
  const fromMs = q["from"]
    ? new Date(q["from"]).getTime()
    : toMs - 30 * 24 * 60 * 60 * 1000
  return {
    fromMs: Number.isNaN(fromMs) ? Date.now() - 30 * 24 * 60 * 60 * 1000 : fromMs,
    toMs: Number.isNaN(toMs) ? Date.now() : toMs,
  }
}

const router = new Hono<{ Variables: Vars }>()

router.get("/analytics/overview", AdminMiddleware, async (c) => {
  try {
    const { fromMs, toMs } = analyticsTimeRange(c)
    const workspaceExternalId = c.get("jwtPayload").workspaceId

    const summaryRows = (await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM v2_chat_conversations WHERE created_at BETWEEN ${fromMs} AND ${toMs} AND workspace_id = ${workspaceExternalId}) AS conversations,
        (SELECT COUNT(DISTINCT owner_id)::int FROM v2_chat_conversations WHERE created_at BETWEEN ${fromMs} AND ${toMs} AND workspace_id = ${workspaceExternalId}) AS users,
        (SELECT COUNT(r.id)::int FROM v2_chat_runs r INNER JOIN v2_chat_conversations c ON c.id = r.conversation_id WHERE c.created_at BETWEEN ${fromMs} AND ${toMs} AND c.workspace_id = ${workspaceExternalId}) AS runs,
        (SELECT COALESCE(SUM(COALESCE(r.cost_usd::numeric, 0)), 0) FROM v2_chat_runs r INNER JOIN v2_chat_conversations c ON c.id = r.conversation_id WHERE c.created_at BETWEEN ${fromMs} AND ${toMs} AND c.workspace_id = ${workspaceExternalId}) AS total_cost,
        (SELECT COALESCE(SUM(COALESCE(r.tokens_in, 0) + COALESCE(r.tokens_out, 0)), 0)::bigint FROM v2_chat_runs r INNER JOIN v2_chat_conversations c ON c.id = r.conversation_id WHERE c.created_at BETWEEN ${fromMs} AND ${toMs} AND c.workspace_id = ${workspaceExternalId}) AS total_tokens,
        (SELECT COUNT(*)::int FROM v2_chat_runs r INNER JOIN v2_chat_conversations c ON c.id = r.conversation_id WHERE c.created_at BETWEEN ${fromMs} AND ${toMs} AND c.workspace_id = ${workspaceExternalId} AND r.status = 'errored') AS errored_runs,
        (SELECT COUNT(*)::int FROM v2_chat_runs r INNER JOIN v2_chat_conversations c ON c.id = r.conversation_id WHERE c.created_at BETWEEN ${fromMs} AND ${toMs} AND c.workspace_id = ${workspaceExternalId}) AS total_runs,
        (SELECT COUNT(*)::int FROM v2_chat_message_feedback mf INNER JOIN v2_chat_conversations c ON c.id = mf.conversation_id WHERE c.created_at BETWEEN ${fromMs} AND ${toMs} AND c.workspace_id = ${workspaceExternalId}) AS feedback_total,
        (SELECT COUNT(*)::int FROM v2_chat_message_feedback mf INNER JOIN v2_chat_conversations c ON c.id = mf.conversation_id WHERE c.created_at BETWEEN ${fromMs} AND ${toMs} AND c.workspace_id = ${workspaceExternalId} AND mf.rating = 'like') AS feedback_likes
    `)) as unknown as Record<string, unknown>[]

    const dauRows = (await db.execute(sql`
      SELECT COALESCE(AVG(daily_users), 0)::float8 AS dau FROM (
        SELECT COUNT(DISTINCT owner_id)::int AS daily_users
        FROM v2_chat_conversations
        WHERE created_at BETWEEN ${fromMs} AND ${toMs}
          AND workspace_id = ${workspaceExternalId}
        GROUP BY DATE_TRUNC('day', TO_TIMESTAMP(created_at / 1000.0))
      ) t
    `)) as unknown as Record<string, unknown>[]

    const newReturningRows = (await db.execute(sql`
      WITH user_first AS (
        SELECT owner_id, MIN(created_at) AS first_conv_at
        FROM v2_chat_conversations
        WHERE workspace_id = ${workspaceExternalId}
        GROUP BY owner_id
      ),
      active AS (
        SELECT DISTINCT owner_id FROM v2_chat_conversations
        WHERE created_at BETWEEN ${fromMs} AND ${toMs}
          AND workspace_id = ${workspaceExternalId}
      )
      SELECT
        COUNT(CASE WHEN uf.first_conv_at BETWEEN ${fromMs} AND ${toMs} THEN 1 END)::int AS new_users,
        COUNT(CASE WHEN uf.first_conv_at < ${fromMs} THEN 1 END)::int AS returning_users
      FROM active a
      INNER JOIN user_first uf ON uf.owner_id = a.owner_id
    `)) as unknown as Record<string, unknown>[]

    const s = summaryRows[0] ?? {}
    const nr = newReturningRows[0] ?? {}
    const totalRuns = Number(s["total_runs"] ?? 0)
    const erroredRuns = Number(s["errored_runs"] ?? 0)
    const feedbackTotal = Number(s["feedback_total"] ?? 0)
    const feedbackLikes = Number(s["feedback_likes"] ?? 0)

    return c.json({
      conversations: Number(s["conversations"] ?? 0),
      users: Number(s["users"] ?? 0),
      newUsers: Number(nr["new_users"] ?? 0),
      returningUsers: Number(nr["returning_users"] ?? 0),
      runs: Number(s["runs"] ?? 0),
      totalCost: Number(s["total_cost"] ?? 0),
      totalTokens: Number(s["total_tokens"] ?? 0),
      errorRate: totalRuns > 0 ? erroredRuns / totalRuns : 0,
      dau: Number((dauRows[0] ?? {})["dau"] ?? 0),
      feedbackRatio: feedbackTotal > 0 ? feedbackLikes / feedbackTotal : 0,
    })
  } catch (error) {
    Logger.error(error, "Error fetching analytics overview")
    throw new HTTPException(500, { message: "Failed to fetch analytics overview" })
  }
})

router.get("/analytics/timeseries", AdminMiddleware, async (c) => {
  try {
    const { fromMs, toMs } = analyticsTimeRange(c)
    const workspaceExternalId = c.get("jwtPayload").workspaceId

    const rows = (await db.execute(sql`
      WITH series AS (
        SELECT GENERATE_SERIES(
          DATE_TRUNC('day', TO_TIMESTAMP(${fromMs} / 1000.0)),
          DATE_TRUNC('day', TO_TIMESTAMP(${toMs} / 1000.0)),
          INTERVAL '1 day'
        ) AS day
      ),
      conv_counts AS (
        SELECT DATE_TRUNC('day', TO_TIMESTAMP(created_at / 1000.0)) AS day, COUNT(*)::int AS conversations
        FROM v2_chat_conversations
        WHERE created_at BETWEEN ${fromMs} AND ${toMs}
          AND workspace_id = ${workspaceExternalId}
        GROUP BY 1
      ),
      msg_counts AS (
        SELECT
          DATE_TRUNC('day', TO_TIMESTAMP(m.created_at / 1000.0)) AS day,
          COUNT(*)::int AS messages
        FROM v2_chat_messages m
        INNER JOIN v2_chat_conversations c ON c.id = m.conversation_id
        WHERE m.role = 'user'
          AND m.created_at BETWEEN ${fromMs} AND ${toMs}
          AND c.workspace_id = ${workspaceExternalId}
        GROUP BY 1
      )
      SELECT
        TO_CHAR(s.day, 'YYYY-MM-DD') AS day,
        COALESCE(cc.conversations, 0) AS conversations,
        COALESCE(mc.messages, 0) AS messages
      FROM series s
      LEFT JOIN conv_counts cc ON cc.day = s.day
      LEFT JOIN msg_counts mc  ON mc.day = s.day
      ORDER BY s.day
    `)) as unknown as Record<string, unknown>[]

    return c.json({
      data: rows.map((r) => ({
        day: String(r["day"] ?? ""),
        conversations: Number(r["conversations"] ?? 0),
        messages: Number(r["messages"] ?? 0),
      })),
    })
  } catch (error) {
    Logger.error(error, "Error fetching analytics timeseries")
    throw new HTTPException(500, { message: "Failed to fetch analytics timeseries" })
  }
})

router.get("/analytics/models", AdminMiddleware, async (c) => {
  try {
    const { fromMs, toMs } = analyticsTimeRange(c)
    const workspaceExternalId = c.get("jwtPayload").workspaceId

    const rows = (await db.execute(sql`
      SELECT
        r.model,
        COUNT(r.id)::int AS run_count,
        COUNT(CASE WHEN r.status = 'errored' THEN 1 END)::int AS error_count,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY r.ended_at - r.started_at)
          FILTER (WHERE r.ended_at IS NOT NULL AND r.status = 'completed') AS p50_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY r.ended_at - r.started_at)
          FILTER (WHERE r.ended_at IS NOT NULL AND r.status = 'completed') AS p95_ms,
        COALESCE(SUM(COALESCE(r.tokens_in, 0) + COALESCE(r.tokens_out, 0)), 0)::bigint AS total_tokens,
        SUM(COALESCE(r.tokens_in, 0) + COALESCE(r.tokens_out, 0))::float8 /
          NULLIF(SUM(CASE WHEN r.ended_at IS NOT NULL THEN (r.ended_at - r.started_at) / 1000.0 END), 0) AS throughput_tok_per_sec,
        COALESCE(SUM(COALESCE(r.cost_usd::numeric, 0)), 0) AS total_cost,
        AVG((m.stats->>'cacheHitRatio')::numeric)
          FILTER (WHERE m.stats IS NOT NULL AND m.stats->>'cacheHitRatio' IS NOT NULL) AS cache_hit_ratio
      FROM v2_chat_runs r
      INNER JOIN v2_chat_conversations c ON c.id = r.conversation_id
      LEFT JOIN v2_chat_messages m ON m.run_id = r.id AND m.role = 'assistant' AND m.stats IS NOT NULL
      WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
        AND c.workspace_id = ${workspaceExternalId}
      GROUP BY r.model
      ORDER BY COUNT(r.id) DESC
    `)) as unknown as Record<string, unknown>[]

    return c.json({
      models: rows.map((r) => {
        const runCount = Number(r["run_count"] ?? 0)
        const errorCount = Number(r["error_count"] ?? 0)
        return {
          model: String(r["model"] ?? ""),
          runCount,
          errorRate: runCount > 0 ? errorCount / runCount : 0,
          p50Ms: Math.round(Number(r["p50_ms"] ?? 0)),
          p95Ms: Math.round(Number(r["p95_ms"] ?? 0)),
          totalTokens: Number(r["total_tokens"] ?? 0),
          throughputTokPerSec: Number(r["throughput_tok_per_sec"] ?? 0),
          totalCost: Number(r["total_cost"] ?? 0),
          cacheHitRatio: Number(r["cache_hit_ratio"] ?? 0),
        }
      }),
    })
  } catch (error) {
    Logger.error(error, "Error fetching analytics models")
    throw new HTTPException(500, { message: "Failed to fetch analytics models" })
  }
})

router.get("/analytics/tools", AdminMiddleware, async (c) => {
  try {
    const { fromMs, toMs } = analyticsTimeRange(c)
    const workspaceExternalId = c.get("jwtPayload").workspaceId

    const rows = (await db.execute(sql`
      SELECT
        tc.tool_name,
        COUNT(tc.id)::int AS call_count,
        COUNT(CASE WHEN tc.is_error THEN 1 END)::int AS error_count,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY tc.completed_at - tc.started_at)
          FILTER (WHERE tc.completed_at IS NOT NULL) AS p50_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY tc.completed_at - tc.started_at)
          FILTER (WHERE tc.completed_at IS NOT NULL) AS p95_ms
      FROM v2_chat_tool_calls tc
      INNER JOIN v2_chat_conversations c ON c.id = tc.conversation_id
      WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
        AND c.workspace_id = ${workspaceExternalId}
      GROUP BY tc.tool_name
      ORDER BY COUNT(tc.id) DESC
    `)) as unknown as Record<string, unknown>[]

    return c.json({
      tools: rows.map((r) => {
        const callCount = Number(r["call_count"] ?? 0)
        const errorCount = Number(r["error_count"] ?? 0)
        return {
          toolName: String(r["tool_name"] ?? ""),
          callCount,
          errorRate: callCount > 0 ? errorCount / callCount : 0,
          p50Ms: Math.round(Number(r["p50_ms"] ?? 0)),
          p95Ms: Math.round(Number(r["p95_ms"] ?? 0)),
        }
      }),
    })
  } catch (error) {
    Logger.error(error, "Error fetching analytics tools")
    throw new HTTPException(500, { message: "Failed to fetch analytics tools" })
  }
})

router.get("/analytics/agents", AdminMiddleware, async (c) => {
  try {
    const { fromMs, toMs } = analyticsTimeRange(c)
    const workspaceExternalId = c.get("jwtPayload").workspaceId

    const rows = (await db.execute(sql`
      SELECT
        r.agent_id,
        a.name AS agent_name,
        COUNT(r.id)::int AS run_count,
        COUNT(CASE WHEN r.status = 'errored' THEN 1 END)::int AS error_count,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY r.ended_at - r.started_at)
          FILTER (WHERE r.ended_at IS NOT NULL AND r.status = 'completed') AS p50_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY r.ended_at - r.started_at)
          FILTER (WHERE r.ended_at IS NOT NULL AND r.status = 'completed') AS p95_ms,
        COALESCE(SUM(COALESCE(r.cost_usd::numeric, 0)), 0) AS total_cost,
        COUNT(CASE WHEN r.parent_run_id IS NOT NULL THEN 1 END)::int AS sub_agent_count
      FROM v2_chat_runs r
      INNER JOIN v2_chat_conversations c ON c.id = r.conversation_id
      LEFT JOIN agents a ON a.external_id = r.agent_id
      WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
        AND c.workspace_id = ${workspaceExternalId}
      GROUP BY r.agent_id, a.name
      ORDER BY COUNT(r.id) DESC
    `)) as unknown as Record<string, unknown>[]

    return c.json({
      agents: rows.map((r) => {
        const runCount = Number(r["run_count"] ?? 0)
        const errorCount = Number(r["error_count"] ?? 0)
        const subAgentCount = Number(r["sub_agent_count"] ?? 0)
        return {
          agentId: String(r["agent_id"] ?? ""),
          agentName: String(r["agent_name"] ?? r["agent_id"] ?? ""),
          runCount,
          errorRate: runCount > 0 ? errorCount / runCount : 0,
          p50Ms: Math.round(Number(r["p50_ms"] ?? 0)),
          p95Ms: Math.round(Number(r["p95_ms"] ?? 0)),
          totalCost: Number(r["total_cost"] ?? 0),
          subAgentRate: runCount > 0 ? subAgentCount / runCount : 0,
        }
      }),
    })
  } catch (error) {
    Logger.error(error, "Error fetching analytics agents")
    throw new HTTPException(500, { message: "Failed to fetch analytics agents" })
  }
})

router.get("/analytics/latency/timeseries", AdminMiddleware, async (c) => {
  try {
    const { fromMs, toMs } = analyticsTimeRange(c)
    const workspaceExternalId = c.get("jwtPayload").workspaceId

    const rows = (await db.execute(sql`
      WITH series AS (
        SELECT GENERATE_SERIES(
          DATE_TRUNC('day', TO_TIMESTAMP(${fromMs} / 1000.0)),
          DATE_TRUNC('day', TO_TIMESTAMP(${toMs}  / 1000.0)),
          INTERVAL '1 day'
        ) AS day
      ),
      turn_p95 AS (
        SELECT
          DATE_TRUNC('day', TO_TIMESTAMP(c.created_at / 1000.0)) AS day,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY t.ended_at - t.started_at) AS p95_ms
        FROM v2_chat_turns t
        INNER JOIN v2_chat_conversations c ON c.id = t.conversation_id
        WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
          AND c.workspace_id = ${workspaceExternalId}
          AND t.ended_at IS NOT NULL AND t.status = 'completed'
        GROUP BY 1
      ),
      model_p95 AS (
        SELECT
          DATE_TRUNC('day', TO_TIMESTAMP(c.created_at / 1000.0)) AS day,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY r.ended_at - r.started_at) AS p95_ms
        FROM v2_chat_runs r
        INNER JOIN v2_chat_conversations c ON c.id = r.conversation_id
        WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
          AND c.workspace_id = ${workspaceExternalId}
          AND r.ended_at IS NOT NULL AND r.status = 'completed'
        GROUP BY 1
      ),
      tool_p95 AS (
        SELECT
          DATE_TRUNC('day', TO_TIMESTAMP(c.created_at / 1000.0)) AS day,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY tc.completed_at - tc.started_at) AS p95_ms
        FROM v2_chat_tool_calls tc
        INNER JOIN v2_chat_turns t ON t.id = tc.turn_id
        INNER JOIN v2_chat_conversations c ON c.id = t.conversation_id
        WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
          AND c.workspace_id = ${workspaceExternalId}
          AND tc.completed_at IS NOT NULL
        GROUP BY 1
      )
      SELECT
        TO_CHAR(s.day, 'YYYY-MM-DD')      AS day,
        COALESCE(tp.p95_ms, 0)::float8    AS turn_p95_ms,
        COALESCE(mp.p95_ms, 0)::float8    AS model_p95_ms,
        COALESCE(tol.p95_ms, 0)::float8   AS tool_p95_ms
      FROM series s
      LEFT JOIN turn_p95  tp  ON tp.day  = s.day
      LEFT JOIN model_p95 mp  ON mp.day  = s.day
      LEFT JOIN tool_p95  tol ON tol.day = s.day
      ORDER BY s.day
    `)) as unknown as { day: string; turn_p95_ms: number; model_p95_ms: number; tool_p95_ms: number }[]

    return c.json({
      data: rows.map((r) => ({
        day: r.day,
        turnP95Ms: Number(r.turn_p95_ms),
        modelP95Ms: Number(r.model_p95_ms),
        toolP95Ms: Number(r.tool_p95_ms),
      })),
    })
  } catch (error) {
    Logger.error(error, "Error fetching latency timeseries")
    throw new HTTPException(500, { message: "Failed to fetch latency timeseries" })
  }
})

router.get("/analytics/errors", AdminMiddleware, async (c) => {
  try {
    const { fromMs, toMs } = analyticsTimeRange(c)
    const workspaceExternalId = c.get("jwtPayload").workspaceId

    const [summaryRows, topErrorRows, byModelRows, convErrorRows, byToolRows, byAgentRows, dropoutRows] = await Promise.all([
      db.execute(sql`
        SELECT
          COUNT(CASE WHEN r.status = 'errored' THEN 1 END)::int AS errored_runs,
          COUNT(CASE WHEN r.status = 'aborted' THEN 1 END)::int AS aborted_runs,
          COUNT(*)::int AS total_runs,
          COUNT(DISTINCT CASE WHEN r.status = 'errored' THEN c.owner_id END)::int AS users_affected
        FROM v2_chat_runs r
        INNER JOIN v2_chat_conversations c ON c.id = r.conversation_id
        WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
          AND c.workspace_id = ${workspaceExternalId}
      `),
      db.execute(sql`
        WITH ranked AS (
          SELECT
            SUBSTRING(r.error, 1, 80) AS prefix,
            r.conversation_id,
            COUNT(*) OVER (PARTITION BY SUBSTRING(r.error, 1, 80)) AS count,
            ROW_NUMBER() OVER (PARTITION BY SUBSTRING(r.error, 1, 80) ORDER BY c.created_at DESC) AS rn
          FROM v2_chat_runs r
          INNER JOIN v2_chat_conversations c ON c.id = r.conversation_id
          WHERE r.error IS NOT NULL AND c.created_at BETWEEN ${fromMs} AND ${toMs}
            AND c.workspace_id = ${workspaceExternalId}
        )
        SELECT prefix, count::int, conversation_id
        FROM ranked
        WHERE rn = 1
        ORDER BY count DESC
        LIMIT 10
      `),
      db.execute(sql`
        SELECT
          r.model,
          COUNT(*)::int AS total,
          COUNT(CASE WHEN r.status = 'errored' THEN 1 END)::int AS error_count
        FROM v2_chat_runs r
        INNER JOIN v2_chat_conversations c ON c.id = r.conversation_id
        WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
          AND c.workspace_id = ${workspaceExternalId}
        GROUP BY r.model
        ORDER BY COUNT(CASE WHEN r.status = 'errored' THEN 1 END)::float8 / NULLIF(COUNT(*), 0) DESC NULLS LAST
      `),
      db.execute(sql`
        SELECT
          COUNT(DISTINCT c.id) FILTER (
            WHERE EXISTS (
              SELECT 1 FROM v2_chat_runs r2
              WHERE r2.conversation_id = c.id AND r2.status = 'errored'
            )
          )::float8 / NULLIF(COUNT(DISTINCT c.id), 0) AS conversation_error_rate
        FROM v2_chat_conversations c
        WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
          AND c.workspace_id = ${workspaceExternalId}
      `),
      db.execute(sql`
        SELECT
          tc.tool_name,
          COUNT(*)::int AS total,
          COUNT(CASE WHEN tc.is_error THEN 1 END)::int AS error_count
        FROM v2_chat_tool_calls tc
        INNER JOIN v2_chat_conversations c ON c.id = tc.conversation_id
        WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
          AND c.workspace_id = ${workspaceExternalId}
        GROUP BY tc.tool_name
        ORDER BY COUNT(CASE WHEN tc.is_error THEN 1 END)::float8 / NULLIF(COUNT(*), 0) DESC NULLS LAST
        LIMIT 15
      `),
      db.execute(sql`
        SELECT
          r.agent_id,
          COALESCE(a.name, r.agent_id) AS agent_name,
          COUNT(*)::int AS total,
          COUNT(CASE WHEN r.status = 'errored' THEN 1 END)::int AS error_count
        FROM v2_chat_runs r
        INNER JOIN v2_chat_conversations c ON c.id = r.conversation_id
        LEFT JOIN agents a ON a.external_id = r.agent_id
        WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
          AND c.workspace_id = ${workspaceExternalId}
          AND r.agent_id IS NOT NULL
        GROUP BY r.agent_id, a.name
        ORDER BY COUNT(CASE WHEN r.status = 'errored' THEN 1 END)::float8 / NULLIF(COUNT(*), 0) DESC NULLS LAST
        LIMIT 10
      `),
      db.execute(sql`
        SELECT
          COUNT(CASE WHEN last_user_at IS NULL OR last_user_at <= last_error_at THEN 1 END)::float8
            / NULLIF(COUNT(*), 0) AS dropout_rate
        FROM (
          SELECT
            c.id,
            MAX(m.created_at) FILTER (WHERE m.role = 'user') AS last_user_at,
            MAX(r.ended_at) FILTER (WHERE r.status = 'errored') AS last_error_at
          FROM v2_chat_conversations c
          INNER JOIN v2_chat_runs r ON r.conversation_id = c.id
          LEFT JOIN v2_chat_messages m ON m.conversation_id = c.id
          WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
            AND c.workspace_id = ${workspaceExternalId}
          GROUP BY c.id
          HAVING MAX(r.ended_at) FILTER (WHERE r.status = 'errored') IS NOT NULL
        ) sub
      `),
    ]) as unknown as Record<string, unknown>[][]

    const s = (summaryRows ?? [])[0] ?? {}
    const convErrRow = (convErrorRows ?? [])[0] ?? {}
    const dropoutRow = (dropoutRows ?? [])[0] ?? {}

    return c.json({
      erroredRuns: Number(s["errored_runs"] ?? 0),
      abortedRuns: Number(s["aborted_runs"] ?? 0),
      usersAffected: Number(s["users_affected"] ?? 0),
      conversationErrorRate: Number(convErrRow["conversation_error_rate"] ?? 0),
      dropoutRate: Number(dropoutRow["dropout_rate"] ?? 0),
      topErrors: (topErrorRows ?? []).map((r) => ({
        prefix: String(r["prefix"] ?? ""),
        count: Number(r["count"] ?? 0),
        conversationId: r["conversation_id"] != null ? String(r["conversation_id"]) : null,
      })),
      byModel: (byModelRows ?? []).map((r) => ({
        model: String(r["model"] ?? ""),
        total: Number(r["total"] ?? 0),
        errorCount: Number(r["error_count"] ?? 0),
      })),
      byTool: (byToolRows ?? []).map((r) => ({
        toolName: String(r["tool_name"] ?? ""),
        total: Number(r["total"] ?? 0),
        errorCount: Number(r["error_count"] ?? 0),
      })),
      byAgent: (byAgentRows ?? []).map((r) => ({
        agentId: String(r["agent_id"] ?? ""),
        agentName: String(r["agent_name"] ?? r["agent_id"] ?? ""),
        total: Number(r["total"] ?? 0),
        errorCount: Number(r["error_count"] ?? 0),
      })),
    })
  } catch (error) {
    Logger.error(error, "Error fetching analytics errors")
    throw new HTTPException(500, { message: "Failed to fetch analytics errors" })
  }
})

router.get("/analytics/errors/timeseries", AdminMiddleware, async (c) => {
  try {
    const { fromMs, toMs } = analyticsTimeRange(c)
    const workspaceExternalId = c.get("jwtPayload").workspaceId

    const rows = (await db.execute(sql`
      WITH series AS (
        SELECT GENERATE_SERIES(
          DATE_TRUNC('day', TO_TIMESTAMP(${fromMs} / 1000.0)),
          DATE_TRUNC('day', TO_TIMESTAMP(${toMs}  / 1000.0)),
          INTERVAL '1 day'
        ) AS day
      ),
      counts AS (
        SELECT
          DATE_TRUNC('day', TO_TIMESTAMP(c.created_at / 1000.0)) AS day,
          COUNT(CASE WHEN r.status = 'errored' THEN 1 END)::int AS errored_runs,
          COUNT(CASE WHEN r.status = 'aborted' THEN 1 END)::int AS aborted_runs
        FROM v2_chat_runs r
        INNER JOIN v2_chat_conversations c ON c.id = r.conversation_id
        WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
          AND c.workspace_id = ${workspaceExternalId}
        GROUP BY 1
      )
      SELECT
        TO_CHAR(s.day, 'YYYY-MM-DD') AS day,
        COALESCE(ec.errored_runs, 0) AS errored_runs,
        COALESCE(ec.aborted_runs, 0) AS aborted_runs
      FROM series s
      LEFT JOIN counts ec ON ec.day = s.day
      ORDER BY s.day
    `)) as unknown as { day: string; errored_runs: number; aborted_runs: number }[]

    return c.json({
      data: rows.map((r) => ({
        day: r.day,
        erroredRuns: Number(r.errored_runs),
        abortedRuns: Number(r.aborted_runs),
      })),
    })
  } catch (error) {
    Logger.error(error, "Error fetching errors timeseries")
    throw new HTTPException(500, { message: "Failed to fetch errors timeseries" })
  }
})

router.get("/analytics/feedback", AdminMiddleware, async (c) => {
  try {
    const { fromMs, toMs } = analyticsTimeRange(c)
    const workspaceExternalId = c.get("jwtPayload").workspaceId

    const [summaryRows, byModelRows, tagRows, commentRows, responseRateRows] = await Promise.all([
      db.execute(sql`
        SELECT
          COUNT(*)::int AS total,
          COUNT(CASE WHEN mf.rating = 'like' THEN 1 END)::int AS likes,
          COUNT(CASE WHEN mf.rating = 'dislike' THEN 1 END)::int AS dislikes
        FROM v2_chat_message_feedback mf
        INNER JOIN v2_chat_conversations c ON c.id = mf.conversation_id
        WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
          AND c.workspace_id = ${workspaceExternalId}
      `),
      db.execute(sql`
        SELECT
          mf.model_snapshot AS model,
          COUNT(CASE WHEN mf.rating = 'like' THEN 1 END)::int AS likes,
          COUNT(CASE WHEN mf.rating = 'dislike' THEN 1 END)::int AS dislikes
        FROM v2_chat_message_feedback mf
        INNER JOIN v2_chat_conversations c ON c.id = mf.conversation_id
        WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
          AND c.workspace_id = ${workspaceExternalId}
          AND mf.model_snapshot IS NOT NULL
        GROUP BY mf.model_snapshot
        ORDER BY COUNT(*) DESC
        LIMIT 10
      `),
      db.execute(sql`
        SELECT tag, COUNT(*)::int AS count
        FROM v2_chat_message_feedback mf
        INNER JOIN v2_chat_conversations c ON c.id = mf.conversation_id
        CROSS JOIN LATERAL jsonb_array_elements_text(mf.tags) AS t(tag)
        WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
          AND c.workspace_id = ${workspaceExternalId}
          AND jsonb_array_length(mf.tags) > 0
        GROUP BY tag
        ORDER BY COUNT(*) DESC
        LIMIT 20
      `),
      db.execute(sql`
        SELECT mf.comment, mf.rating::text, mf.created_at, mf.conversation_id, m.turn_id
        FROM v2_chat_message_feedback mf
        INNER JOIN v2_chat_conversations c ON c.id = mf.conversation_id
        LEFT JOIN v2_chat_messages m ON m.id = mf.message_id
        WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
          AND c.workspace_id = ${workspaceExternalId}
          AND mf.comment IS NOT NULL
        ORDER BY mf.created_at DESC
        LIMIT 10
      `),
      db.execute(sql`
        SELECT
          COUNT(DISTINCT mf.conversation_id)::float8 / NULLIF(COUNT(DISTINCT c.id), 0) AS response_rate
        FROM v2_chat_conversations c
        LEFT JOIN v2_chat_message_feedback mf ON mf.conversation_id = c.id
        WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
          AND c.workspace_id = ${workspaceExternalId}
      `),
    ]) as unknown as Record<string, unknown>[][]

    const s = (summaryRows ?? [])[0] ?? {}
    const total = Number(s["total"] ?? 0)
    const likes = Number(s["likes"] ?? 0)
    const dislikes = Number(s["dislikes"] ?? 0)

    return c.json({
      total,
      likes,
      dislikes,
      ratio: total > 0 ? likes / total : 0,
      responseRate: Number(((responseRateRows ?? [])[0] ?? {})["response_rate"] ?? 0),
      byModel: (byModelRows ?? []).map((r) => ({
        model: String(r["model"] ?? ""),
        likes: Number(r["likes"] ?? 0),
        dislikes: Number(r["dislikes"] ?? 0),
      })),
      tagDistribution: (tagRows ?? []).map((r) => ({
        tag: String(r["tag"] ?? ""),
        count: Number(r["count"] ?? 0),
      })),
      recentComments: (commentRows ?? []).map((r) => ({
        comment: String(r["comment"] ?? ""),
        rating: String(r["rating"] ?? ""),
        createdAt: Number(r["created_at"] ?? 0),
        conversationId: String(r["conversation_id"] ?? ""),
        turnId: r["turn_id"] != null ? String(r["turn_id"]) : null,
      })),
    })
  } catch (error) {
    Logger.error(error, "Error fetching analytics feedback")
    throw new HTTPException(500, { message: "Failed to fetch analytics feedback" })
  }
})

router.get("/analytics/feedback/timeseries", AdminMiddleware, async (c) => {
  try {
    const { fromMs, toMs } = analyticsTimeRange(c)
    const workspaceExternalId = c.get("jwtPayload").workspaceId

    const rows = (await db.execute(sql`
      WITH series AS (
        SELECT GENERATE_SERIES(
          DATE_TRUNC('day', TO_TIMESTAMP(${fromMs} / 1000.0)),
          DATE_TRUNC('day', TO_TIMESTAMP(${toMs}  / 1000.0)),
          INTERVAL '1 day'
        ) AS day
      ),
      counts AS (
        SELECT
          DATE_TRUNC('day', TO_TIMESTAMP(c.created_at / 1000.0)) AS day,
          COUNT(CASE WHEN mf.rating = 'like'    THEN 1 END)::int AS likes,
          COUNT(CASE WHEN mf.rating = 'dislike' THEN 1 END)::int AS dislikes
        FROM v2_chat_message_feedback mf
        INNER JOIN v2_chat_conversations c ON c.id = mf.conversation_id
        WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
          AND c.workspace_id = ${workspaceExternalId}
        GROUP BY 1
      )
      SELECT
        TO_CHAR(s.day, 'YYYY-MM-DD') AS day,
        COALESCE(fc.likes,    0) AS likes,
        COALESCE(fc.dislikes, 0) AS dislikes
      FROM series s
      LEFT JOIN counts fc ON fc.day = s.day
      ORDER BY s.day
    `)) as unknown as { day: string; likes: number; dislikes: number }[]

    return c.json({
      data: rows.map((r) => ({
        day: r.day,
        likes: Number(r.likes),
        dislikes: Number(r.dislikes),
      })),
    })
  } catch (error) {
    Logger.error(error, "Error fetching feedback timeseries")
    throw new HTTPException(500, { message: "Failed to fetch feedback timeseries" })
  }
})

router.get("/analytics/health", AdminMiddleware, async (c) => {
  try {
    const { fromMs, toMs } = analyticsTimeRange(c)
    const workspaceExternalId = c.get("jwtPayload").workspaceId

    const healthRows = (await db.execute(sql`
      SELECT
        (SELECT AVG(msg_count)::float8 FROM (
          SELECT COUNT(*) AS msg_count
          FROM v2_chat_messages m
          INNER JOIN v2_chat_conversations c ON c.id = m.conversation_id
          WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
            AND c.workspace_id = ${workspaceExternalId}
          GROUP BY m.conversation_id
        ) t) AS avg_messages_per_conv,
        (SELECT AVG(turn_count)::float8 FROM (
          SELECT COUNT(*) AS turn_count
          FROM v2_chat_turns t
          INNER JOIN v2_chat_conversations c ON c.id = t.conversation_id
          WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
            AND c.workspace_id = ${workspaceExternalId}
          GROUP BY t.conversation_id
        ) t2) AS avg_turns_per_conv,
        (SELECT
          COUNT(DISTINCT m.conversation_id) FILTER (
            WHERE (m.stats->>'compactionRounds')::int > 0
          )::float8 / NULLIF(COUNT(DISTINCT m.conversation_id), 0)
          FROM v2_chat_messages m
          INNER JOIN v2_chat_conversations c ON c.id = m.conversation_id
          WHERE c.created_at BETWEEN ${fromMs} AND ${toMs} AND m.stats IS NOT NULL
            AND c.workspace_id = ${workspaceExternalId}
        ) AS compaction_rate,
        (SELECT COUNT(DISTINCT m.conversation_id) FILTER (WHERE (m.stats->>'compactionRounds')::int > 0)
          FROM v2_chat_messages m
          INNER JOIN v2_chat_conversations c ON c.id = m.conversation_id
          WHERE c.created_at BETWEEN ${fromMs} AND ${toMs} AND m.stats IS NOT NULL
            AND c.workspace_id = ${workspaceExternalId}
        ) AS compaction_count,
        (SELECT COUNT(DISTINCT m.conversation_id)
          FROM v2_chat_messages m
          INNER JOIN v2_chat_conversations c ON c.id = m.conversation_id
          WHERE c.created_at BETWEEN ${fromMs} AND ${toMs} AND m.stats IS NOT NULL
            AND c.workspace_id = ${workspaceExternalId}
        ) AS compaction_total,
        (SELECT AVG((m.stats->'contextUsage'->>'percent')::numeric)::float8
          FROM v2_chat_messages m
          INNER JOIN v2_chat_conversations c ON c.id = m.conversation_id
          WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
            AND c.workspace_id = ${workspaceExternalId}
            AND m.stats IS NOT NULL
            AND m.stats->'contextUsage'->>'percent' IS NOT NULL
        ) AS avg_context_pressure,
        (SELECT
          COUNT(CASE WHEN parent_run_id IS NOT NULL THEN 1 END)::float8 / NULLIF(COUNT(*), 0)
          FROM v2_chat_runs r
          INNER JOIN v2_chat_conversations c ON c.id = r.conversation_id
          WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
            AND c.workspace_id = ${workspaceExternalId}
        ) AS sub_agent_dispatch_rate,
        (SELECT AVG((m.stats->>'retryAttempts')::numeric)::float8
          FROM v2_chat_messages m
          INNER JOIN v2_chat_conversations c ON c.id = m.conversation_id
          WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
            AND c.workspace_id = ${workspaceExternalId}
            AND m.stats IS NOT NULL
            AND m.stats->>'retryAttempts' IS NOT NULL
        ) AS avg_retry_attempts,
        (SELECT COUNT(CASE WHEN origin_kind = 'chat' THEN 1 END)::float8 / NULLIF(COUNT(*), 0)
          FROM v2_chat_conversations
          WHERE created_at BETWEEN ${fromMs} AND ${toMs}
            AND workspace_id = ${workspaceExternalId}
        ) AS chat_origin_pct
    `)) as unknown as Record<string, unknown>[]

    const turnLatencyRows = (await db.execute(sql`
      SELECT
        PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY t.ended_at - t.started_at)
          FILTER (WHERE t.ended_at IS NOT NULL AND t.status = 'completed') AS p50_turn_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY t.ended_at - t.started_at)
          FILTER (WHERE t.ended_at IS NOT NULL AND t.status = 'completed') AS p95_turn_ms,
        AVG(t.ended_at - t.started_at)
          FILTER (WHERE t.ended_at IS NOT NULL AND t.status = 'completed')::float8 AS avg_turn_ms
      FROM v2_chat_turns t
      INNER JOIN v2_chat_conversations c ON c.id = t.conversation_id
      WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
        AND c.workspace_id = ${workspaceExternalId}
    `)) as unknown as Record<string, unknown>[]

    const h = healthRows[0] ?? {}
    const tl = turnLatencyRows[0] ?? {}

    return c.json({
      avgMessagesPerConversation: Number(h["avg_messages_per_conv"] ?? 0),
      avgTurnsPerConversation: Number(h["avg_turns_per_conv"] ?? 0),
      compactionRate: Number(h["compaction_rate"] ?? 0),
      compactionCount: Number(h["compaction_count"] ?? 0),
      compactionTotal: Number(h["compaction_total"] ?? 0),
      avgContextPressure: Number(h["avg_context_pressure"] ?? 0),
      subAgentDispatchRate: Number(h["sub_agent_dispatch_rate"] ?? 0),
      avgRetryAttempts: Number(h["avg_retry_attempts"] ?? 0),
      chatOriginPct: Number(h["chat_origin_pct"] ?? 1),
      p50TurnMs: Math.round(Number(tl["p50_turn_ms"] ?? 0)),
      p95TurnMs: Math.round(Number(tl["p95_turn_ms"] ?? 0)),
      avgTurnMs: Math.round(Number(tl["avg_turn_ms"] ?? 0)),
    })
  } catch (error) {
    Logger.error(error, "Error fetching analytics health")
    throw new HTTPException(500, { message: "Failed to fetch analytics health" })
  }
})

router.get("/analytics/health/detail", AdminMiddleware, async (c) => {
  try {
    const { fromMs, toMs } = analyticsTimeRange(c)
    const workspaceExternalId = c.get("jwtPayload").workspaceId
    const by = c.req.query("by") ?? "messages"

    type DetailRow = { conversation_id: string; title: string | null; owner_id: string; value: number }
    let rows: DetailRow[] = []

    if (by === "messages") {
      rows = (await db.execute(sql`
        SELECT c.id AS conversation_id, c.title, c.owner_id, COUNT(m.id)::int AS value
        FROM v2_chat_conversations c
        JOIN v2_chat_messages m ON m.conversation_id = c.id
        WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
          AND c.workspace_id = ${workspaceExternalId}
        GROUP BY c.id, c.title, c.owner_id
        ORDER BY value DESC
        LIMIT 5
      `)) as unknown as DetailRow[]
    } else if (by === "turns") {
      rows = (await db.execute(sql`
        SELECT c.id AS conversation_id, c.title, c.owner_id, COUNT(t.id)::int AS value
        FROM v2_chat_conversations c
        JOIN v2_chat_turns t ON t.conversation_id = c.id
        WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
          AND c.workspace_id = ${workspaceExternalId}
        GROUP BY c.id, c.title, c.owner_id
        ORDER BY value DESC
        LIMIT 5
      `)) as unknown as DetailRow[]
    } else if (by === "compaction") {
      rows = (await db.execute(sql`
        SELECT c.id AS conversation_id, c.title, c.owner_id,
          MAX((m.stats->>'compactionRounds')::int)::int AS value
        FROM v2_chat_conversations c
        JOIN v2_chat_messages m ON m.conversation_id = c.id
        WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
          AND c.workspace_id = ${workspaceExternalId}
          AND m.stats IS NOT NULL
          AND (m.stats->>'compactionRounds')::int > 0
        GROUP BY c.id, c.title, c.owner_id
        ORDER BY value DESC
        LIMIT 5
      `)) as unknown as DetailRow[]
    } else if (by === "subagent") {
      rows = (await db.execute(sql`
        SELECT c.id AS conversation_id, c.title, c.owner_id,
          COUNT(r.id) FILTER (WHERE r.parent_run_id IS NOT NULL)::int AS value
        FROM v2_chat_conversations c
        JOIN v2_chat_runs r ON r.conversation_id = c.id
        WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
          AND c.workspace_id = ${workspaceExternalId}
        GROUP BY c.id, c.title, c.owner_id
        HAVING COUNT(r.id) FILTER (WHERE r.parent_run_id IS NOT NULL) > 0
        ORDER BY value DESC
        LIMIT 5
      `)) as unknown as DetailRow[]
    } else if (by === "retries") {
      rows = (await db.execute(sql`
        SELECT c.id AS conversation_id, c.title, c.owner_id,
          SUM((m.stats->>'retryAttempts')::int)::int AS value
        FROM v2_chat_conversations c
        JOIN v2_chat_messages m ON m.conversation_id = c.id
        WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
          AND c.workspace_id = ${workspaceExternalId}
          AND m.stats IS NOT NULL
          AND (m.stats->>'retryAttempts')::int > 0
        GROUP BY c.id, c.title, c.owner_id
        ORDER BY value DESC
        LIMIT 5
      `)) as unknown as DetailRow[]
    }

    return c.json({
      rows: rows.map((r) => ({
        conversationId: String(r["conversation_id"] ?? ""),
        title: r["title"] ? String(r["title"]) : null,
        ownerEmail: String(r["owner_id"] ?? ""),
        value: Number(r["value"] ?? 0),
      })),
    })
  } catch (error) {
    Logger.error(error, "Error fetching analytics health detail")
    throw new HTTPException(500, { message: "Failed to fetch health detail" })
  }
})

router.get("/analytics/health/timeseries", AdminMiddleware, async (c) => {
  try {
    const { fromMs, toMs } = analyticsTimeRange(c)
    const workspaceExternalId = c.get("jwtPayload").workspaceId

    const rows = (await db.execute(sql`
      WITH series AS (
        SELECT GENERATE_SERIES(
          DATE_TRUNC('day', TO_TIMESTAMP(${fromMs} / 1000.0)),
          DATE_TRUNC('day', TO_TIMESTAMP(${toMs}  / 1000.0)),
          INTERVAL '1 day'
        ) AS day
      ),
      latency AS (
        SELECT
          DATE_TRUNC('day', TO_TIMESTAMP(c.created_at / 1000.0)) AS day,
          AVG(t.ended_at - t.started_at)::float8 AS avg_turn_ms,
          PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY t.ended_at - t.started_at) AS p50_turn_ms,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY t.ended_at - t.started_at) AS p95_turn_ms
        FROM v2_chat_turns t
        INNER JOIN v2_chat_conversations c ON c.id = t.conversation_id
        WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
          AND c.workspace_id = ${workspaceExternalId}
          AND t.ended_at IS NOT NULL AND t.status = 'completed'
        GROUP BY 1
      )
      SELECT
        TO_CHAR(s.day, 'YYYY-MM-DD')      AS day,
        COALESCE(l.avg_turn_ms, 0)::float8 AS avg_turn_ms,
        COALESCE(l.p50_turn_ms, 0)::float8 AS p50_turn_ms,
        COALESCE(l.p95_turn_ms, 0)::float8 AS p95_turn_ms
      FROM series s
      LEFT JOIN latency l ON l.day = s.day
      ORDER BY s.day
    `)) as unknown as { day: string; avg_turn_ms: number; p50_turn_ms: number; p95_turn_ms: number }[]

    return c.json({
      data: rows.map((r) => ({
        day: r.day,
        avgTurnMs: Number(r.avg_turn_ms),
        p50TurnMs: Number(r.p50_turn_ms),
        p95TurnMs: Number(r.p95_turn_ms),
      })),
    })
  } catch (error) {
    Logger.error(error, "Error fetching health timeseries")
    throw new HTTPException(500, { message: "Failed to fetch health timeseries" })
  }
})

router.get("/analytics/callstats", AdminMiddleware, async (c) => {
  try {
    const { fromMs, toMs } = analyticsTimeRange(c)
    const workspaceExternalId = c.get("jwtPayload").workspaceId

    const rows = (await db.execute(sql`
      SELECT
        PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY llm_count) AS llm_p50,
        PERCENTILE_CONT(0.9)  WITHIN GROUP (ORDER BY llm_count) AS llm_p90,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY llm_count) AS llm_p95,
        AVG(llm_count)::float8                                   AS llm_avg,
        PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY tc_count)  AS tc_p50,
        PERCENTILE_CONT(0.9)  WITHIN GROUP (ORDER BY tc_count)  AS tc_p90,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY tc_count)  AS tc_p95,
        AVG(tc_count)::float8                                    AS tc_avg
      FROM (
        SELECT
          t.id,
          COUNT(DISTINCT r.id)  AS llm_count,
          COUNT(DISTINCT tc.id) AS tc_count
        FROM v2_chat_turns t
        INNER JOIN v2_chat_conversations c ON c.id = t.conversation_id
        LEFT JOIN v2_chat_runs r            ON r.turn_id = t.id
        LEFT JOIN v2_chat_tool_calls tc     ON tc.turn_id = t.id
        WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
          AND c.workspace_id = ${workspaceExternalId}
          AND t.status = 'completed'
        GROUP BY t.id
      ) sub
    `)) as unknown as Record<string, unknown>[]

    const r = rows[0] ?? {}

    const maxRows = (await db.execute(sql`
      WITH per_turn AS (
        SELECT
          t.id               AS turn_id,
          t.conversation_id,
          COUNT(DISTINCT r.id)  AS llm_count,
          COUNT(DISTINCT tc.id) AS tc_count
        FROM v2_chat_turns t
        INNER JOIN v2_chat_conversations c ON c.id = t.conversation_id
        LEFT JOIN v2_chat_runs r           ON r.turn_id = t.id
        LEFT JOIN v2_chat_tool_calls tc    ON tc.turn_id = t.id
        WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
          AND c.workspace_id = ${workspaceExternalId}
          AND t.status = 'completed'
        GROUP BY t.id, t.conversation_id
      ),
      max_llm AS (
        SELECT turn_id, conversation_id, llm_count, tc_count
        FROM per_turn ORDER BY llm_count DESC LIMIT 1
      ),
      max_tc AS (
        SELECT turn_id, conversation_id, llm_count, tc_count
        FROM per_turn ORDER BY tc_count DESC LIMIT 1
      )
      SELECT
        'llm'                                           AS kind,
        pt.turn_id,
        c.id                                            AS conv_id,
        c.title                                         AS conv_title,
        pt.llm_count,
        pt.tc_count,
        (
          SELECT b->>'text'
          FROM v2_chat_messages m
          CROSS JOIN LATERAL jsonb_array_elements(m.blocks) AS b
          WHERE m.turn_id = pt.turn_id
            AND m.role = 'user'
            AND b->>'kind' = 'text'
          LIMIT 1
        ) AS user_text
      FROM max_llm pt
      INNER JOIN v2_chat_conversations c ON c.id = pt.conversation_id
      UNION ALL
      SELECT
        'tc'                                            AS kind,
        pt.turn_id,
        c.id                                            AS conv_id,
        c.title                                         AS conv_title,
        pt.llm_count,
        pt.tc_count,
        (
          SELECT b->>'text'
          FROM v2_chat_messages m
          CROSS JOIN LATERAL jsonb_array_elements(m.blocks) AS b
          WHERE m.turn_id = pt.turn_id
            AND m.role = 'user'
            AND b->>'kind' = 'text'
          LIMIT 1
        ) AS user_text
      FROM max_tc pt
      INNER JOIN v2_chat_conversations c ON c.id = pt.conversation_id
    `)) as unknown as Record<string, unknown>[]

    const toMaxTurn = (row: Record<string, unknown>) => ({
      turnId: String(row["turn_id"] ?? ""),
      conversationId: String(row["conv_id"] ?? ""),
      conversationTitle: row["conv_title"] ? String(row["conv_title"]) : null,
      userMessage: row["user_text"] ? String(row["user_text"]) : null,
      llmCalls: Number(row["llm_count"] ?? 0),
      toolCalls: Number(row["tc_count"] ?? 0),
    })

    const llmRow = maxRows.find((r) => r["kind"] === "llm")
    const tcRow = maxRows.find((r) => r["kind"] === "tc")

    return c.json({
      llmCallsPerTurn: {
        p50: Number(r["llm_p50"] ?? 0),
        p90: Number(r["llm_p90"] ?? 0),
        p95: Number(r["llm_p95"] ?? 0),
        avg: Number(r["llm_avg"] ?? 0),
      },
      toolCallsPerTurn: {
        p50: Number(r["tc_p50"] ?? 0),
        p90: Number(r["tc_p90"] ?? 0),
        p95: Number(r["tc_p95"] ?? 0),
        avg: Number(r["tc_avg"] ?? 0),
      },
      maxLlmTurn: llmRow ? toMaxTurn(llmRow) : null,
      maxToolTurn: tcRow ? toMaxTurn(tcRow) : null,
    })
  } catch (error) {
    Logger.error(error, "Error fetching analytics call stats")
    throw new HTTPException(500, { message: "Failed to fetch call stats" })
  }
})

router.get("/analytics/callstats/timeseries", AdminMiddleware, async (c) => {
  try {
    const { fromMs, toMs } = analyticsTimeRange(c)
    const workspaceExternalId = c.get("jwtPayload").workspaceId

    const rows = (await db.execute(sql`
      WITH series AS (
        SELECT GENERATE_SERIES(
          DATE_TRUNC('day', TO_TIMESTAMP(${fromMs} / 1000.0)),
          DATE_TRUNC('day', TO_TIMESTAMP(${toMs}  / 1000.0)),
          INTERVAL '1 day'
        ) AS day
      ),
      call_counts AS (
        SELECT
          DATE_TRUNC('day', TO_TIMESTAMP(c.created_at / 1000.0)) AS day,
          COUNT(r.id)::int  AS llm_calls,
          COUNT(tc.id)::int AS tool_calls
        FROM v2_chat_turns t
        INNER JOIN v2_chat_conversations c ON c.id = t.conversation_id
        LEFT JOIN v2_chat_runs r            ON r.turn_id = t.id
        LEFT JOIN v2_chat_tool_calls tc     ON tc.turn_id = t.id
        WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
          AND c.workspace_id = ${workspaceExternalId}
          AND t.status = 'completed'
        GROUP BY 1
      ),
      msg_counts AS (
        SELECT
          DATE_TRUNC('day', TO_TIMESTAMP(m.created_at / 1000.0)) AS day,
          COUNT(*)::int AS messages
        FROM v2_chat_messages m
        INNER JOIN v2_chat_conversations c ON c.id = m.conversation_id
        WHERE m.role = 'user'
          AND m.created_at BETWEEN ${fromMs} AND ${toMs}
          AND c.workspace_id = ${workspaceExternalId}
        GROUP BY 1
      )
      SELECT
        TO_CHAR(s.day, 'YYYY-MM-DD')    AS day,
        COALESCE(cc.llm_calls,  0)      AS llm_calls,
        COALESCE(cc.tool_calls, 0)      AS tool_calls,
        COALESCE(mc.messages,   0)      AS messages
      FROM series s
      LEFT JOIN call_counts cc ON cc.day = s.day
      LEFT JOIN msg_counts  mc ON mc.day = s.day
      ORDER BY s.day
    `)) as unknown as { day: string; llm_calls: number; tool_calls: number; messages: number }[]

    return c.json({
      data: rows.map((r) => ({
        day: r.day,
        llmCalls: Number(r.llm_calls),
        toolCalls: Number(r.tool_calls),
        messages: Number(r.messages),
      })),
    })
  } catch (error) {
    Logger.error(error, "Error fetching call stats timeseries")
    throw new HTTPException(500, { message: "Failed to fetch call stats timeseries" })
  }
})

router.get("/analytics/depth", AdminMiddleware, async (c) => {
  try {
    const { fromMs, toMs } = analyticsTimeRange(c)
    const workspaceExternalId = c.get("jwtPayload").workspaceId

    const rows = (await db.execute(sql`
      SELECT
        COUNT(CASE WHEN turn_count = 1 THEN 1 END)::int          AS one_turn,
        COUNT(CASE WHEN turn_count BETWEEN 2 AND 5 THEN 1 END)::int AS two_to_five,
        COUNT(CASE WHEN turn_count BETWEEN 6 AND 10 THEN 1 END)::int AS six_to_ten,
        COUNT(CASE WHEN turn_count > 10 THEN 1 END)::int         AS over_ten,
        COUNT(*)::int                                             AS total
      FROM (
        SELECT t.conversation_id, COUNT(*) AS turn_count
        FROM v2_chat_turns t
        INNER JOIN v2_chat_conversations c ON c.id = t.conversation_id
        WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
          AND c.workspace_id = ${workspaceExternalId}
          AND t.status = 'completed'
        GROUP BY t.conversation_id
      ) sub
    `)) as unknown as Record<string, unknown>[]

    const r = rows[0] ?? {}
    return c.json({
      oneTurn: Number(r["one_turn"] ?? 0),
      twoToFive: Number(r["two_to_five"] ?? 0),
      sixToTen: Number(r["six_to_ten"] ?? 0),
      overTen: Number(r["over_ten"] ?? 0),
      total: Number(r["total"] ?? 0),
    })
  } catch (error) {
    Logger.error(error, "Error fetching analytics depth")
    throw new HTTPException(500, { message: "Failed to fetch depth" })
  }
})

router.get("/analytics/topusers", AdminMiddleware, async (c) => {
  try {
    const { fromMs, toMs } = analyticsTimeRange(c)
    const workspaceExternalId = c.get("jwtPayload").workspaceId

    const rows = (await db.execute(sql`
      SELECT
        c.owner_id                                                        AS owner_email,
        u.name                                                            AS owner_name,
        COUNT(*) FILTER (WHERE m.role = 'user')::int                     AS message_count,
        COUNT(DISTINCT c.id)::int                                        AS conversation_count
      FROM v2_chat_messages m
      INNER JOIN v2_chat_conversations c ON c.id = m.conversation_id
      LEFT JOIN users u ON u.email = c.owner_id
      WHERE c.created_at BETWEEN ${fromMs} AND ${toMs}
        AND c.workspace_id = ${workspaceExternalId}
      GROUP BY c.owner_id, u.name
      ORDER BY message_count DESC
      LIMIT 10
    `)) as unknown as Record<string, unknown>[]

    return c.json({
      users: rows.map((r) => ({
        ownerEmail: String(r["owner_email"] ?? ""),
        ownerName: r["owner_name"] ? String(r["owner_name"]) : null,
        messageCount: Number(r["message_count"] ?? 0),
        conversationCount: Number(r["conversation_count"] ?? 0),
      })),
    })
  } catch (error) {
    Logger.error(error, "Error fetching analytics top users")
    throw new HTTPException(500, { message: "Failed to fetch top users" })
  }
})

export default router
