// Shared ACL types for the workflow-sdk integration, plus the Register
// augmentation that types the SDK's opaque `attributes` to xyne's shape.
//
// TCtx and TFilter are the SDK's two opaque generics. Here they are the same
// structural pair — the caller's numeric userId (to join the permission table)
// and the workspace externalId (to scope resource rows, which store the
// externalId, not a numeric workspace id). They are named apart because they
// mean different things: ctx is *who is asking*, filter is *the list predicate*.

import type {} from "@xyne/workflow-sdk"

export type XyneCtx = {
  /** public.users.id — joins the permission table. */
  userId: number
  /** workspace externalId — matches workflow/folder/credential.workspace_id. */
  workspaceExternalId: string
}

export type XyneFilter = XyneCtx

/**
 * The `attributes` carried on every sdk resource. xyne DERIVES these from
 * columns on read rather than storing an opaque blob, so the create-time and
 * read-time shapes differ:
 *  - `workspaceId` — always present; the tenant/execution scope (externalId).
 *  - `createdByUserId` — set from ctx at CREATE only, consumed to stamp the
 *    owner permission row, never persisted.
 *  - `isPublic` — reconstructed on READ only, so the authorizer can synthesize
 *    a viewer role for public resources without a second query.
 */
export type XyneResourceAttrs = {
  workspaceId: string
  createdByUserId?: number
  isPublic?: boolean
}

declare module "@xyne/workflow-sdk" {
  interface Register {
    attributes: {
      workflow: XyneResourceAttrs
      folder: XyneResourceAttrs
      credential: XyneResourceAttrs
    }
  }
}
