// kbAccess.ts — the single KB read-authorization rule.
//
// `kb_items` is a shared, multi-tenant index. The search path gates it via
// searchCore's `visibilityGate`; any direct by-docId read (getChunks,
// searchWithinDoc) MUST apply the same rule or it bypasses tenancy entirely.
// That rule lives here, in one place, and fails closed — so a fourth tool can't
// silently reintroduce the bypass.

import type { AgentScope } from "../../../agent-scope"

type Fields = Record<string, unknown>

const asStr = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined

/** May `userEmail` (optionally acting through `agentScope`) read this KB doc?
 *  Mirrors `visibilityGate`: the caller's own document, or one inside the
 *  agent's granted collection / folder / file allowlist. Fail closed. */
export const isKbDocReadable = (
  fields: Fields,
  userEmail: string,
  agentScope: AgentScope | undefined,
): boolean => {
  const createdBy = asStr(fields["createdBy"])
  if (createdBy && userEmail && createdBy === userEmail.trim()) return true

  const selections = agentScope?.collectionSelections
  if (selections?.length) {
    const clId = asStr(fields["clId"])
    const clFd = asStr(fields["clFd"])
    const docId = asStr(fields["docId"])
    for (const s of selections) {
      if (clId && s.collectionIds?.includes(clId)) return true
      if (clFd && s.collectionFolderIds?.includes(clFd)) return true
      if (docId && s.collectionFileIds?.includes(docId)) return true
    }
  }
  return false
}
