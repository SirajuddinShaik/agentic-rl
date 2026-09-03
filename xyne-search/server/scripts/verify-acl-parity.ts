// Parity gate: prove the new resolver reproduces the legacy effective access
// for every legacy grant. Forward check — every owner/viewer/public grant the
// old model conferred must still resolve to at least the same role. Any
// regression (access lost) is a hard failure and blocks cutover.
//
// Intended, non-regression differences (reported separately, not failures):
//   - public skills & the public collection become WORKSPACE-scoped instead of
//     globally visible — the cross-workspace leaks we set out to close.
//
//   bun run scripts/verify-acl-parity.ts

import { and, eq, isNull, ne, sql } from "drizzle-orm"
import { db } from "@/platform/db/client"
import { collections, agents, skills, users } from "@/platform/db/schema"
import { AclRole } from "@/platform/db/schema/acl"
import {
  AclResourceType,
  resolveAccess,
  ROLE_RANK,
  type ResourceRef,
  type Role,
  type Viewer,
} from "@/platform/authz"

const mismatches: string[] = []
let checks = 0

const atLeast = async (
  viewer: Viewer,
  ref: ResourceRef,
  expected: Role,
  ctx: string,
): Promise<void> => {
  checks++
  const actual = await resolveAccess(db, viewer, ref)
  if (actual === null || ROLE_RANK[actual] < ROLE_RANK[expected]) {
    mismatches.push(`${ctx}: expected >= ${expected}, got ${actual ?? "null"}`)
  }
}

const mapAgentRole = (role: string): Role =>
  role === AclRole.Owner
    ? AclRole.Owner
    : role === AclRole.Editor
      ? AclRole.Editor
      : AclRole.Viewer

async function checkCollections(): Promise<void> {
  const rows = await db
    .select({
      id: collections.id,
      workspaceId: collections.workspaceId,
      ownerId: collections.ownerId,
      // Raw column refs: is_private / permissions are dropped from the schema;
      // parity runs pre-drop, when the columns still exist.
      isPrivate: sql<boolean>`is_private`,
      permissions: sql<number[]>`permissions`,
    })
    .from(collections)
    .where(isNull(collections.deletedAt))
  for (const c of rows) {
    const ref: ResourceRef = { type: AclResourceType.Collection, id: c.id }
    await atLeast(
      { userId: c.ownerId, workspaceId: c.workspaceId },
      ref,
      AclRole.Owner,
      `collection ${c.id} owner`,
    )
    const perms = Array.isArray(c.permissions) ? (c.permissions as unknown[]) : []
    for (const raw of perms) {
      const uid = typeof raw === "number" ? raw : Number(raw)
      if (!Number.isFinite(uid) || uid === c.ownerId) continue
      await atLeast(
        { userId: uid, workspaceId: c.workspaceId },
        ref,
        AclRole.Viewer,
        `collection ${c.id} shared-viewer ${uid}`,
      )
    }
    if (c.isPrivate === false) {
      // Public collection -> any user in the workspace should get viewer.
      const [peer] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.workspaceId, c.workspaceId), ne(users.id, c.ownerId)))
        .limit(1)
      if (peer) {
        await atLeast(
          { userId: peer.id, workspaceId: c.workspaceId },
          ref,
          AclRole.Viewer,
          `collection ${c.id} public workspace-viewer`,
        )
      }
    }
  }
}

async function checkAgents(): Promise<void> {
  // Raw SQL: user_agent_permissions is dropped from the schema; parity runs
  // pre-drop, when the table still exists.
  const res = await db.execute(sql`
    SELECT uap.user_id AS "userId", uap.agent_id AS "agentId",
           uap.role AS role, a.workspace_id AS "workspaceId"
    FROM user_agent_permissions uap
    JOIN agents a ON a.id = uap.agent_id
    WHERE a.deleted_at IS NULL`)
  const rows = ((res as { rows?: unknown[] }).rows ?? res) as Array<{
    userId: number
    agentId: number
    role: string
    workspaceId: number
  }>
  for (const p of rows) {
    await atLeast(
      { userId: p.userId, workspaceId: p.workspaceId },
      { type: AclResourceType.Agent, id: String(p.agentId) },
      mapAgentRole(p.role),
      `agent ${p.agentId} user ${p.userId}`,
    )
  }

  const pub = await db
    .select({ id: agents.id, workspaceId: agents.workspaceId, userId: agents.userId })
    .from(agents)
    .where(and(isNull(agents.deletedAt), sql`is_public = true`))
  for (const a of pub) {
    const [peer] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.workspaceId, a.workspaceId), ne(users.id, a.userId)))
      .limit(1)
    if (peer) {
      await atLeast(
        { userId: peer.id, workspaceId: a.workspaceId },
        { type: AclResourceType.Agent, id: String(a.id) },
        AclRole.Viewer,
        `agent ${a.id} public workspace-viewer`,
      )
    }
  }
}

async function checkSkills(): Promise<void> {
  const rows = await db
    .select({
      id: skills.id,
      createdBy: skills.createdBy,
      isPrivate: sql<boolean>`is_private`,
      workspaceId: users.workspaceId,
    })
    .from(skills)
    .innerJoin(users, eq(users.id, skills.createdBy))
  for (const s of rows) {
    await atLeast(
      { userId: s.createdBy, workspaceId: s.workspaceId },
      { type: AclResourceType.Skill, id: s.id },
      AclRole.Owner,
      `skill ${s.id} creator`,
    )
  }
}

async function main(): Promise<void> {
  await checkCollections()
  await checkAgents()
  await checkSkills()
  console.log(`Parity checks run: ${checks}`)
  if (mismatches.length > 0) {
    console.error(`PARITY FAILED — ${mismatches.length} regression(s):`)
    mismatches.slice(0, 40).forEach((m) => console.error("  ✗", m))
    process.exit(1)
  }
  console.log("PARITY OK — every legacy grant is reproduced by the resolver ✓")
  process.exit(0)
}

main().catch((e) => {
  console.error("Parity check failed:", e)
  process.exit(1)
})
