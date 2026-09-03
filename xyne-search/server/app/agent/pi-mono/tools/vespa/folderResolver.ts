// Resolves folder paths ("Legal/Circulars") to the `clFd` UUIDs for Vespa's
// `clFd in (...)` filter. Scoping MUST go through `clFd` (an
// `attribute: fast-search` field) so the HNSW pre-filter catches the whole
// subtree — the old `fileName contains "<path>"` collapsed recall to ~1% of
// large folders under hybrid retrieval (memory:
// vespasearch-folder-filter-loses-99-percent-of-docs).

import { and, eq, isNull } from "drizzle-orm"

import { db } from "@/platform/db/client"
import { getAllFolderIds } from "@/platform/db/knowledgeBase"
import { collections, collectionItems } from "@/platform/db/schema/knowledgeBase"

const splitPath = (path: string): string[] =>
  path
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)

// `path` column convention (matches getFolderTree): a top-level folder has
// path "/", a sub-folder of /Orders has path "/Orders". Returns null if any
// segment doesn't resolve.
const findFolderIdByPath = async (
  fullPath: string,
): Promise<string | null> => {
  const segments = splitPath(fullPath)
  if (segments.length < 2) return null
  const [collectionName, ...folderSegs] = segments
  if (!collectionName) return null

  const cols = await db
    .select({ id: collections.id })
    .from(collections)
    .where(
      and(eq(collections.name, collectionName), isNull(collections.deletedAt)),
    )
    .limit(1)
  const collectionRow = cols[0]
  if (!collectionRow) return null
  const collectionId = collectionRow.id

  const folderName = folderSegs[folderSegs.length - 1]
  if (!folderName) return null
  const parentRelPath =
    folderSegs.length === 1 ? "/" : "/" + folderSegs.slice(0, -1).join("/") + "/"

  const rows = await db
    .select({ id: collectionItems.id })
    .from(collectionItems)
    .where(
      and(
        eq(collectionItems.collectionId, collectionId),
        eq(collectionItems.name, folderName),
        eq(collectionItems.path, parentRelPath),
        eq(collectionItems.type, "folder"),
        isNull(collectionItems.deletedAt),
      ),
    )
    .limit(1)
  const folderRow = rows[0]
  if (!folderRow) return null
  return folderRow.id
}

// Each matched folder + all sub-folders (recursive via getAllFolderIds).
// Unresolved paths are silently dropped — the caller checks list length to
// decide whether to error or proceed without the filter.
export const resolveFolderPathsToClFds = async (
  paths: ReadonlyArray<string>,
): Promise<string[]> => {
  const folderIds = new Set<string>()
  for (const p of paths) {
    const id = await findFolderIdByPath(p)
    if (id) folderIds.add(id)
  }
  if (folderIds.size === 0) return []
  const seedIds = Array.from(folderIds)
  const subIds = await getAllFolderIds(seedIds, db)
  for (const id of subIds) folderIds.add(id)
  return Array.from(folderIds)
}
