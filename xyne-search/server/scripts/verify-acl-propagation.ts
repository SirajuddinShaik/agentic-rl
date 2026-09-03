// Propagation/cascade matrix for the agent → KB grant engine (acl-propagation.ts).
// Runs entirely inside ONE transaction that is rolled back at the end, using
// synthetic resource/principal ids — nothing is persisted. Only workspace_id must
// be real (its the one acl FK), so we borrow an existing workspace.
//
//   bun run scripts/verify-acl-propagation.ts
//
// Covers: share→grant, grant-authority (viewer-only ref is NOT re-exposed),
// revoke isolation (direct + other-agent grants survive), public agent→workspace
// grant, and repropagate dropping removed refs/users.

import { and, eq } from "drizzle-orm"
import { db } from "@/platform/db/client"
import { acl, workspaces } from "@/platform/db/schema"
import { AclPrincipalType, AclRole, AclSourceType } from "@/platform/db/schema/acl"
import { AclResourceType, grant } from "@/platform/authz"
import {
  propagateAgentGrants,
  revokeAgentGrants,
  repropagateAgentGrants,
  atRiskCollectionsOnOwnerRemoval,
} from "@/platform/db/acl-propagation"

const AGENT = 99999999 // synthetic agent id (resource_id is text; rolled back anyway)
const OTHER_AGENT = "99999998"
const OWNER = 99990001
const AUD = 99990002
const OTHER = 99990004
const AUTHZ_COL = "test-authz-collection"
const VIEW_COL = "test-viewonly-collection"

let pass = 0
let fail = 0
const check = (name: string, cond: boolean) => {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}  <-- FAILED`)
  }
}

class Rollback extends Error {}

const run = async () => {
  const [ws] = await db.select({ id: workspaces.id }).from(workspaces).limit(1)
  if (!ws) throw new Error("no workspace to borrow for the FK")
  const WS = ws.id

  try {
    await db.transaction(async (tx) => {
      const hasGrant = async (opts: {
        resourceId: string
        principalType: string
        principalId: number
        sourceType: string
        sourceId: string
      }): Promise<boolean> => {
        const rows = await tx
          .select({ id: acl.id })
          .from(acl)
          .where(
            and(
              eq(acl.resourceType, AclResourceType.Collection),
              eq(acl.resourceId, opts.resourceId),
              eq(acl.principalType, opts.principalType),
              eq(acl.principalId, opts.principalId),
              eq(acl.sourceType, opts.sourceType),
              eq(acl.sourceId, opts.sourceId),
            ),
          )
        return rows.length > 0
      }
      const agentSourced = (resourceId: string, pt: string, pid: number) =>
        hasGrant({
          resourceId,
          principalType: pt,
          principalId: pid,
          sourceType: AclSourceType.Agent,
          sourceId: String(AGENT),
        })

      // ── Setup: agent audience (owner + one shared viewer) and two collections
      const agentRef = { type: AclResourceType.Agent, id: String(AGENT) }
      await grant(tx, { ref: agentRef, principal: { type: AclPrincipalType.User, id: OWNER }, role: AclRole.Owner, workspaceId: WS })
      await grant(tx, { ref: agentRef, principal: { type: AclPrincipalType.User, id: AUD }, role: AclRole.Viewer, workspaceId: WS })
      const authz = { type: AclResourceType.Collection, id: AUTHZ_COL }
      const viewOnly = { type: AclResourceType.Collection, id: VIEW_COL }
      // owner is editor+ on AUTHZ_COL, but only a viewer on VIEW_COL
      await grant(tx, { ref: authz, principal: { type: AclPrincipalType.User, id: OWNER }, role: AclRole.Owner, workspaceId: WS })
      await grant(tx, { ref: viewOnly, principal: { type: AclPrincipalType.User, id: OWNER }, role: AclRole.Viewer, workspaceId: WS })

      // ── 1. Propagate: audience gets viewer on the authorized ref; the
      //       viewer-only ref is NOT re-exposed (grant authority = editor+).
      await propagateAgentGrants(tx, { agentId: AGENT, workspaceId: WS, collectionIds: [AUTHZ_COL, VIEW_COL] })
      check("share → audience granted viewer on authorized collection", await agentSourced(AUTHZ_COL, AclPrincipalType.User, AUD))
      check("grant-authority → viewer-only collection is NOT propagated", !(await agentSourced(VIEW_COL, AclPrincipalType.User, AUD)))

      // ── 2. Revoke isolation: an independent direct grant and another agent's
      //       grant on the same collection must survive revokeAgentGrants.
      await grant(tx, { ref: authz, principal: { type: AclPrincipalType.User, id: AUD }, role: AclRole.Viewer, workspaceId: WS })
      await grant(tx, { ref: authz, principal: { type: AclPrincipalType.User, id: OTHER }, role: AclRole.Viewer, source: { type: AclSourceType.Agent, id: OTHER_AGENT }, workspaceId: WS })
      await revokeAgentGrants(tx, AGENT)
      check("unshare → this agent's derived grant removed", !(await agentSourced(AUTHZ_COL, AclPrincipalType.User, AUD)))
      check("unshare → independent direct grant survives", await hasGrant({ resourceId: AUTHZ_COL, principalType: AclPrincipalType.User, principalId: AUD, sourceType: AclSourceType.Direct, sourceId: "" }))
      check("unshare → another agent's grant survives", await hasGrant({ resourceId: AUTHZ_COL, principalType: AclPrincipalType.User, principalId: OTHER, sourceType: AclSourceType.Agent, sourceId: OTHER_AGENT }))

      // ── 3. Public agent → the workspace principal gets viewer on the KB ref
      //       (Decision 6: a public agent makes its referenced KB workspace-public).
      await grant(tx, { ref: agentRef, principal: { type: AclPrincipalType.Workspace, id: WS }, role: AclRole.Viewer, workspaceId: WS })
      await propagateAgentGrants(tx, { agentId: AGENT, workspaceId: WS, collectionIds: [AUTHZ_COL] })
      check("public agent → workspace-viewer grant on referenced collection", await agentSourced(AUTHZ_COL, AclPrincipalType.Workspace, WS))

      // ── 4. Repropagate with the ref dropped → all of this agent's derived
      //       grants fall out; the independent direct grant is untouched.
      await repropagateAgentGrants(tx, { agentId: AGENT, workspaceId: WS, collectionIds: [] })
      check("repropagate(drop ref) → user derived grant gone", !(await agentSourced(AUTHZ_COL, AclPrincipalType.User, AUD)))
      check("repropagate(drop ref) → workspace derived grant gone", !(await agentSourced(AUTHZ_COL, AclPrincipalType.Workspace, WS)))
      check("repropagate → independent direct grant still untouched", await hasGrant({ resourceId: AUTHZ_COL, principalType: AclPrincipalType.User, principalId: AUD, sourceType: AclSourceType.Direct, sourceId: "" }))

      // ── 5. No-silent-loss detection: which referenced collections would be
      //       orphaned if an owner is removed.
      const AGENT2 = "99999997"
      const A2 = 99990010
      const B2 = 99990011
      const COL_SOLO = "test-nsl-solo" // justified only by A2
      const COL_SHARED = "test-nsl-shared" // justified by A2 and B2
      const COL_VIEWONLY = "test-nsl-viewonly" // A2 only views it
      const agent2 = { type: AclResourceType.Agent, id: AGENT2 }
      const asUser = (id: number) => ({ type: AclPrincipalType.User, id })
      const col = (id: string) => ({ type: AclResourceType.Collection, id })
      await grant(tx, { ref: agent2, principal: asUser(A2), role: AclRole.Owner, workspaceId: WS })
      await grant(tx, { ref: agent2, principal: asUser(B2), role: AclRole.Owner, workspaceId: WS })
      await grant(tx, { ref: col(COL_SOLO), principal: asUser(A2), role: AclRole.Owner, workspaceId: WS })
      await grant(tx, { ref: col(COL_SHARED), principal: asUser(A2), role: AclRole.Editor, workspaceId: WS })
      await grant(tx, { ref: col(COL_SHARED), principal: asUser(B2), role: AclRole.Editor, workspaceId: WS })
      await grant(tx, { ref: col(COL_VIEWONLY), principal: asUser(A2), role: AclRole.Viewer, workspaceId: WS })

      const atRisk = new Set(
        await atRiskCollectionsOnOwnerRemoval(tx, {
          agentId: Number(AGENT2),
          workspaceId: WS,
          removingUserIds: [A2],
          collectionIds: [COL_SOLO, COL_SHARED, COL_VIEWONLY],
        }),
      )
      check("no-silent-loss → solo-owned collection is at risk when its owner leaves", atRisk.has(COL_SOLO))
      check("no-silent-loss → co-owned collection is safe (co-owner still justifies)", !atRisk.has(COL_SHARED))
      check("no-silent-loss → viewer-only ref is not 'lost' (never propagated)", !atRisk.has(COL_VIEWONLY))

      throw new Rollback() // discard everything — this was a dry run
    })
  } catch (e) {
    if (!(e instanceof Rollback)) throw e
  }

  console.log(`\n${fail === 0 ? "PROPAGATION MATRIX OK ✓" : "PROPAGATION MATRIX FAILED ✗"}  (${pass} passed, ${fail} failed)`)
  process.exit(fail === 0 ? 0 : 1)
}

run().catch((e) => {
  console.error("verify-acl-propagation failed:", e)
  process.exit(1)
})
