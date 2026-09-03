// Backfill the unified `acl` table from the legacy ACL sources. Idempotent
// (grant() upserts on the unique index) and batched. Nothing is ever deleted;
// the legacy columns/tables stay frozen as a backup.
//
//   bun run scripts/backfill-acl.ts --dry-run   # count only, no writes
//   bun run scripts/backfill-acl.ts             # apply
//
// Mapping:
//   collections.owner_id            -> acl(collection, user=owner, owner, direct)
//   collections.permissions[]       -> acl(collection, user, viewer, direct)
//   collections.is_private=false    -> acl(collection, workspace, viewer, direct)
//   user_agent_permissions          -> acl(agent, user, role, direct)   (shared->viewer)
//   agents.is_public                -> acl(agent, workspace, viewer, direct)
//   skills.created_by               -> acl(skill, user=creator, owner, direct)
//   skills.is_private=false         -> acl(skill, workspace, viewer, direct)

import { and, eq, isNull, sql } from "drizzle-orm"
import { db } from "@/platform/db/client"
import { collections, agents, skills, users } from "@/platform/db/schema"
import { AclPrincipalType, AclRole } from "@/platform/db/schema/acl"
import {
  AclResourceType,
  grant,
  type Principal,
  type ResourceRef,
} from "@/platform/authz"

const DRY = process.argv.includes("--dry-run")
const BATCH = 500

const stats = {
  collectionOwner: 0,
  collectionViewer: 0,
  collectionPublic: 0,
  agentGrant: 0,
  agentPublic: 0,
  skillOwner: 0,
  skillPublic: 0,
  errors: 0,
}

const asUser = (id: number): Principal => ({
  type: AclPrincipalType.User,
  id,
})
const asWorkspace = (id: number): Principal => ({
  type: AclPrincipalType.Workspace,
  id,
})

const put = async (
  opts: {
    ref: ResourceRef
    principal: Principal
    role: (typeof AclRole)[keyof typeof AclRole]
    workspaceId: number
  },
  bump: () => void,
): Promise<void> => {
  try {
    if (!DRY) await grant(db, opts)
    bump()
  } catch (e) {
    stats.errors++
    console.error(
      `grant failed for ${opts.ref.type}:${opts.ref.id} -> ${opts.principal.type}:${opts.principal.id}`,
      (e as Error).message,
    )
  }
}

// Legacy user_agent_permissions roles are owner/editor/viewer/shared; the
// unified vocabulary drops "shared" (it becomes viewer).
const mapAgentRole = (role: string): (typeof AclRole)[keyof typeof AclRole] =>
  role === AclRole.Owner
    ? AclRole.Owner
    : role === AclRole.Editor
      ? AclRole.Editor
      : AclRole.Viewer

const pace = (): Promise<void> => new Promise((r) => setTimeout(r, 40))

async function backfillCollections(): Promise<void> {
  let offset = 0
  for (;;) {
    const rows = await db
      .select({
        id: collections.id,
        workspaceId: collections.workspaceId,
        ownerId: collections.ownerId,
        // Raw column refs: is_private / permissions are dropped from the schema
        // post-cutover; the backfill runs pre-drop (prod), so they still exist.
        isPrivate: sql<boolean>`is_private`,
        permissions: sql<number[]>`permissions`,
      })
      .from(collections)
      .where(isNull(collections.deletedAt))
      .orderBy(collections.id)
      .limit(BATCH)
      .offset(offset)
    if (rows.length === 0) break
    for (const c of rows) {
      const ref: ResourceRef = { type: AclResourceType.Collection, id: c.id }
      await put(
        { ref, principal: asUser(c.ownerId), role: AclRole.Owner, workspaceId: c.workspaceId },
        () => stats.collectionOwner++,
      )
      const perms = Array.isArray(c.permissions)
        ? (c.permissions as unknown[])
        : []
      for (const raw of perms) {
        const uid = typeof raw === "number" ? raw : Number(raw)
        if (!Number.isFinite(uid) || uid === c.ownerId) continue
        await put(
          { ref, principal: asUser(uid), role: AclRole.Viewer, workspaceId: c.workspaceId },
          () => stats.collectionViewer++,
        )
      }
      if (c.isPrivate === false) {
        await put(
          { ref, principal: asWorkspace(c.workspaceId), role: AclRole.Viewer, workspaceId: c.workspaceId },
          () => stats.collectionPublic++,
        )
      }
    }
    offset += rows.length
    await pace()
  }
}

async function backfillAgents(): Promise<void> {
  // Explicit per-user grants from the join table.
  let offset = 0
  for (;;) {
    // Raw SQL: user_agent_permissions is dropped from the schema; the backfill
    // runs pre-drop (prod), when the table still exists.
    const res = await db.execute(sql`
      SELECT uap.user_id AS "userId", uap.agent_id AS "agentId",
             uap.role AS role, a.workspace_id AS "workspaceId"
      FROM user_agent_permissions uap
      JOIN agents a ON a.id = uap.agent_id
      WHERE a.deleted_at IS NULL
      ORDER BY uap.id
      LIMIT ${BATCH} OFFSET ${offset}`)
    const rows = ((res as { rows?: unknown[] }).rows ?? res) as Array<{
      userId: number
      agentId: number
      role: string
      workspaceId: number
    }>
    if (rows.length === 0) break
    for (const p of rows) {
      await put(
        {
          ref: { type: AclResourceType.Agent, id: String(p.agentId) },
          principal: asUser(p.userId),
          role: mapAgentRole(p.role),
          workspaceId: p.workspaceId,
        },
        () => stats.agentGrant++,
      )
    }
    offset += rows.length
    await pace()
  }

  // Public agents -> workspace viewer.
  offset = 0
  for (;;) {
    const pub = await db
      .select({ id: agents.id, workspaceId: agents.workspaceId })
      .from(agents)
      .where(and(isNull(agents.deletedAt), sql`is_public = true`))
      .orderBy(agents.id)
      .limit(BATCH)
      .offset(offset)
    if (pub.length === 0) break
    for (const a of pub) {
      await put(
        {
          ref: { type: AclResourceType.Agent, id: String(a.id) },
          principal: asWorkspace(a.workspaceId),
          role: AclRole.Viewer,
          workspaceId: a.workspaceId,
        },
        () => stats.agentPublic++,
      )
    }
    offset += pub.length
    await pace()
  }
}

async function backfillSkills(): Promise<void> {
  let offset = 0
  for (;;) {
    const rows = await db
      .select({
        id: skills.id,
        createdBy: skills.createdBy,
        isPrivate: sql<boolean>`is_private`,
        workspaceId: users.workspaceId,
      })
      .from(skills)
      .innerJoin(users, eq(users.id, skills.createdBy))
      .orderBy(skills.id)
      .limit(BATCH)
      .offset(offset)
    if (rows.length === 0) break
    for (const s of rows) {
      const ref: ResourceRef = { type: AclResourceType.Skill, id: s.id }
      await put(
        { ref, principal: asUser(s.createdBy), role: AclRole.Owner, workspaceId: s.workspaceId },
        () => stats.skillOwner++,
      )
      if (s.isPrivate === false) {
        await put(
          { ref, principal: asWorkspace(s.workspaceId), role: AclRole.Viewer, workspaceId: s.workspaceId },
          () => stats.skillPublic++,
        )
      }
    }
    offset += rows.length
    await pace()
  }
}

async function main(): Promise<void> {
  console.log(`ACL backfill ${DRY ? "(DRY RUN — no writes)" : "(APPLYING)"}`)
  await backfillCollections()
  await backfillAgents()
  await backfillSkills()
  console.log("Summary:", JSON.stringify(stats, null, 2))
  if (stats.errors > 0) {
    console.error(`Completed with ${stats.errors} errors`)
    process.exit(1)
  }
  console.log("Done.")
  process.exit(0)
}

main().catch((e) => {
  console.error("Backfill failed:", e)
  process.exit(1)
})
