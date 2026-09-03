// The xyne authorizer — the PDP the SDK's PEP calls. Answers the SDK's three
// questions from the permission table + isPublic:
//   permissions(ctx, ref) → the caller's actions on one resource (guard + UI).
//   permissionsBatch      → the same for a whole list page in one query.
//   visibleFilter(ctx)    → the predicate pushed into the adapter's JOIN.
//
// Policy (host's call, not the SDK's): owner and editor resolve to the same
// action set — "editor = full except ownership transfer", and transfer is not
// an action, so the difference lives only in the permission table (ownership
// integrity), not here. viewer is read-only. Public synthesizes viewer for any
// workspace member. Cross-workspace is a hard deny regardless of grants.

import { eq } from "drizzle-orm"
import { db } from "@/platform/db/client"
import { sdkWorkflows } from "@/platform/db/schema/workflowSdk"
import {
  getResourceRoles,
  type SdkResourceType,
} from "@/platform/db/sdkResourcePermission"
import { SdkResourceRole } from "@/platform/shared/types"
import type { WorkflowAuthorizer, ResourceRef, Action } from "@xyne/workflow-sdk"
import {
  WORKFLOW_ACTIONS,
  FOLDER_ACTIONS,
  CONTAINER_ACTIONS,
  CREDENTIAL_ACTIONS,
  EXECUTION_ACTIONS,
} from "@xyne/workflow-sdk"
import type { XyneCtx, XyneFilter, XyneResourceAttrs } from "@/app/workflows/acl"

// Action sets keyed by role. owner|editor get the full set; viewer is read-only.
const WF_FULL: readonly Action[] = WORKFLOW_ACTIONS
const WF_VIEW: readonly Action[] = ["workflow:read", "execution:read"]
const FLD_FULL: readonly Action[] = [...FOLDER_ACTIONS, ...CONTAINER_ACTIONS]
const FLD_VIEW: readonly Action[] = ["folder:read"]
const EXEC_FULL: readonly Action[] = EXECUTION_ACTIONS
const EXEC_VIEW: readonly Action[] = ["execution:read"]
// Root: any workspace member may create top-level resources and manage credentials.
const ROOT: readonly Action[] = [...CONTAINER_ACTIONS, ...CREDENTIAL_ACTIONS]

const attrsOf = (ref: ResourceRef): XyneResourceAttrs | undefined =>
  ref.type === "root"
    ? undefined
    : ((ref.record as { attributes?: unknown }).attributes as XyneResourceAttrs | undefined)

const actionsFor = (
  type: SdkResourceType,
  role: SdkResourceRole | null,
): readonly Action[] => {
  if (!role) return []
  if (type === "workflow") return role === SdkResourceRole.Viewer ? WF_VIEW : WF_FULL
  return role === SdkResourceRole.Viewer ? FLD_VIEW : FLD_FULL
}

export class XyneWorkflowAuthorizer
  implements WorkflowAuthorizer<XyneCtx, XyneFilter>
{
  async permissions(ctx: XyneCtx, ref: ResourceRef): Promise<readonly Action[]> {
    if (ref.type === "root") return ROOT

    if (ref.type === "credential") {
      const a = attrsOf(ref)
      return a?.workspaceId === ctx.workspaceExternalId ? CREDENTIAL_ACTIONS : []
    }

    if (ref.type === "execution") {
      const role = await this.workflowRoleForExecution(ctx, ref.record.workflowId)
      if (!role) return []
      return role === SdkResourceRole.Viewer ? EXEC_VIEW : EXEC_FULL
    }

    if (ref.type === "workflow" || ref.type === "folder") {
      const a = attrsOf(ref)
      if (a?.workspaceId !== ctx.workspaceExternalId) return [] // cross-workspace hard deny
      const roles = await getResourceRoles(db, ctx.userId, [{ type: ref.type, id: ref.id }])
      const role =
        roles.get(`${ref.type}:${ref.id}`) ?? (a.isPublic ? SdkResourceRole.Viewer : null)
      return actionsFor(ref.type, role)
    }

    return [] // approvalStep — deferred (P3)
  }

  // One role query for a whole list page: the projection path never N+1s.
  async permissionsBatch(
    ctx: XyneCtx,
    refs: readonly ResourceRef[],
  ): Promise<ReadonlyArray<readonly Action[]>> {
    const owned = refs.filter(
      (r): r is Extract<ResourceRef, { type: "workflow" | "folder" }> =>
        r.type === "workflow" || r.type === "folder",
    )
    const roles = await getResourceRoles(
      db,
      ctx.userId,
      owned.map((r) => ({ type: r.type, id: r.id })),
    )
    return Promise.all(
      refs.map(async (ref) => {
        if (ref.type === "workflow" || ref.type === "folder") {
          const a = attrsOf(ref)
          if (a?.workspaceId !== ctx.workspaceExternalId) return []
          const role =
            roles.get(`${ref.type}:${ref.id}`) ??
            (a.isPublic ? SdkResourceRole.Viewer : null)
          return actionsFor(ref.type, role)
        }
        // root/credential/execution are not list-projected in bulk — defer to the
        // single path, which is correct and rare here.
        return this.permissions(ctx, ref)
      }),
    )
  }

  visibleFilter(ctx: XyneCtx): Promise<XyneFilter> {
    return Promise.resolve({
      userId: ctx.userId,
      workspaceExternalId: ctx.workspaceExternalId,
    })
  }

  // Executions carry only workflowId, so resolve the owning workflow's workspace
  // + public flag and the caller's role on it. One extra lookup per execution
  // POINT check (getExecutionDetail/resume/approve) — those are not list paths.
  private async workflowRoleForExecution(
    ctx: XyneCtx,
    workflowId: string,
  ): Promise<SdkResourceRole | null> {
    const rows = await db
      .select({
        workspaceId: sdkWorkflows.workspaceId,
        isPublic: sdkWorkflows.isPublic,
      })
      .from(sdkWorkflows)
      .where(eq(sdkWorkflows.id, workflowId))
      .limit(1)
    const wf = rows[0]
    if (!wf || wf.workspaceId !== ctx.workspaceExternalId) return null
    const roles = await getResourceRoles(db, ctx.userId, [{ type: "workflow", id: workflowId }])
    return roles.get(`workflow:${workflowId}`) ?? (wf.isPublic ? SdkResourceRole.Viewer : null)
  }
}
