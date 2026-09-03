// v2 Knowledge Base router. Mounted at /v2/kb by server/backendv2/server.ts.

import { createReadStream as createFileReadStream } from "node:fs"
import { stat, unlink } from "node:fs/promises"
import { Hono, type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { stream } from "hono/streaming"

import { db } from "@/platform/db/client"
import { safeFileServeHeaders } from "@/app/lib/fileServe"
import {
  createCollection,
  createFolder as dbCreateFolder,
  getCollectionFileByItemId,
  getCollectionItemById,
  getCollectionItemByPath,
  getCollectionItemsByParent,
  getCollectionItemsByParentPaginated,
  softDeleteCollection,
  softDeleteCollectionItem,
  updateCollection,
  updateCollectionItem,
} from "@/platform/db/knowledgeBase"
import type { CollectionItem } from "@/platform/db/schema"
import { collections, collectionItems } from "@/platform/db/schema"
import {
  grant,
  revokeAllForResource,
  accessibleResourceIds,
  resolveMany,
  roleAllows,
  workspacePublicIds,
  isWorkspacePublic,
  AclResourceType,
  AclRole,
} from "@/platform/authz"
import { AclPrincipalType } from "@/platform/db/schema/acl"
import {
  assertCanWrite,
  assertCanManage,
  loadActor,
  loadCollection,
  loadItemAccess,
  assertItemCanWrite,
  type KbRouteVars,
} from "@/app/services/knowledgeBaseAccess"
import {
  IngestionUploadError,
  enqueueKbMetadataSync,
  uploadKbFiles,
} from "@/ingestion/public"
import { sanitizeFileName } from "@/ingestion/storage/paths"
import { getLogger } from "@/platform/logger"
import { expandSheetIds } from "@/platform/search/utils"
import {
  DeleteDocument,
  GetDocumentsByDocIds,
  UpdateDocument,
} from "@/platform/search/vespa"
import { UploadStatus } from "@/platform/shared/types"
import { getTracer } from "@/tracer"
import { type TxnOrClient } from "@/types"
import { Subsystem } from "@/types"
import { KbItemsSchema } from "@xyne/vespa-ts/types"
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm"

const Logger = getLogger(Subsystem.Api).child({ module: "backendv2/kb" })

const toViewerPageNumber = (page: number | null | undefined): number | null =>
  typeof page === "number" && Number.isFinite(page) ? page + 1 : null

const router = new Hono<{ Variables: KbRouteVars }>()

const baseSheetDocId = (docId: string): string | null => {
  const match = docId.match(/^(.+)_sheet_\d+$/)
  return match?.[1] ?? null
}

const getKbFileForVespaDocId = async (docId: string) => {
  const rowShape = {
    itemId: collectionItems.id,
    collectionId: collectionItems.collectionId,
    name: collectionItems.name,
    mimeType: collectionItems.mimeType,
  }

  const [exact] = await db
    .select(rowShape)
    .from(collectionItems)
    .where(eq(collectionItems.vespaDocId, docId))
    .limit(1)
  if (exact) return exact

  const baseDocId = baseSheetDocId(docId)
  if (!baseDocId) return null

  const [sheetParent] = await db
    .select(rowShape)
    .from(collectionItems)
    .where(sql`${collectionItems.vespaDocId} LIKE ${`${baseDocId}_sheet_%`}`)
    .limit(1)
  return sheetParent ?? null
}

// Map a DB row -> JSON for the frontend. We send a superset of BrowserEntry
// and let the client decide what to surface.
const toEntry = (item: CollectionItem): Record<string, unknown> => ({
  id: item.id,
  name: item.name,
  type: item.type,
  parentId: item.parentId,
  path: item.path,
  mimeType: item.mimeType,
  fileSize: item.fileSize,
  uploadStatus: item.uploadStatus,
  updatedAt: item.updatedAt,
  createdAt: item.createdAt,
  // Powers the file preview panel's "Extracted summary" (fetched from Vespa
  // via /files/inspect/:vespaDocId).
  vespaDocId: item.vespaDocId,
  // Recursive file count beneath a folder — shown on the folder card like a
  // collection's item count.
  totalFileCount: item.totalFileCount,
})

// ── Collections ────────────────────────────────────────────────────────────

// GET /v2/kb/collections
router.get("/collections", async (c) => {
  const actor = await loadActor(c)
  const viewer = { userId: actor.id, workspaceId: actor.workspaceId }
  // Everything the user can access — owned, shared (incl. via agent/project
  // propagation once that lands), and workspace-public — resolved through the
  // unified ACL. Replaces the owned-only getCollectionsByOwner listing.
  const ids = await accessibleResourceIds(db, viewer, AclResourceType.Collection)
  if (ids.length === 0) {
    return c.json({ collections: [] })
  }
  const rows = await db
    .select()
    .from(collections)
    .where(and(inArray(collections.id, ids), isNull(collections.deletedAt)))
    .orderBy(desc(collections.updatedAt))
  const roles = await resolveMany(
    db,
    viewer,
    rows.map((r) => ({ type: AclResourceType.Collection, id: r.id })),
  )
  // Derive is_private from acl (private = no workspace-public grant).
  const publicColIds = await workspacePublicIds(
    db,
    AclResourceType.Collection,
    viewer.workspaceId,
  )
  return c.json({
    collections: rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      totalItems: r.totalItems,
      uploadStatus: r.uploadStatus,
      isPrivate: !publicColIds.has(r.id),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      allowOverrides: r.allowOverrides,
      // editor+ — UI shows owner/editor affordances (upload, new folder,
      // delete); viewers get read-only.
      canWrite: roleAllows(
        roles.get(`${AclResourceType.Collection}:${r.id}`) ?? null,
        "write",
      ),
    })),
  })
})

// POST /v2/kb/collections  body: { name, description? }
router.post("/collections", async (c) => {
  const actor = await loadActor(c)
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string
    description?: string
  }
  const name = (body.name ?? "").trim()
  if (!name) {
    throw new HTTPException(400, { message: "name required" })
  }
  if (name.length > 255) {
    throw new HTTPException(400, { message: "name too long" })
  }

  const collection = await db.transaction(async (tx: TxnOrClient) => {
    const created = await createCollection(tx, {
      name,
      description: body.description ?? null,
      workspaceId: actor.workspaceId,
      ownerId: actor.id,
      lastUpdatedById: actor.id,
      lastUpdatedByEmail: actor.email,
    })
    // New collections are governed by the unified ACL, not the legacy owner_id
    // column — grant the creator ownership so loadCollection (resolver) sees it.
    await grant(tx, {
      ref: { type: AclResourceType.Collection, id: created.id },
      principal: { type: AclPrincipalType.User, id: actor.id },
      role: AclRole.Owner,
      workspaceId: actor.workspaceId,
      createdBy: actor.id,
    })
    return created
  })

  enqueueKbMetadataSync({ kind: "collection", id: collection.id })

  return c.json({
    id: collection.id,
    name: collection.name,
    description: collection.description,
    totalItems: collection.totalItems,
    uploadStatus: collection.uploadStatus,
    // Brand-new collection carries no workspace-public grant → private.
    isPrivate: true,
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt,
  })
})

// PATCH /v2/kb/collections/:clId
// Update a collection's name and/or owner-controlled settings (allowOverrides).
// Owner-only — rename + settings are collection management, not content edits.
// The DB row is authoritative for UI immediately; Vespa metadata is synced
// best-effort from DB state and retried by the reaper.
router.patch("/collections/:clId", async (c) => {
  const actor = await loadActor(c)
  const clId = c.req.param("clId")
  const access = await loadCollection(clId, actor)
  assertCanManage(access)

  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string
    allowOverrides?: boolean
  }

  const hasName = typeof body.name === "string"
  const hasOverrides = typeof body.allowOverrides === "boolean"
  if (!hasName && !hasOverrides) {
    throw new HTTPException(400, {
      message: "name or allowOverrides required",
    })
  }

  const updates: Parameters<typeof updateCollection>[2] = {
    lastUpdatedById: actor.id,
    lastUpdatedByEmail: actor.email,
  }

  if (hasName) {
    const newName = (body.name ?? "").trim()
    if (!newName) {
      throw new HTTPException(400, { message: "name required" })
    }
    if (newName.length > 255) {
      throw new HTTPException(400, { message: "name too long" })
    }
    updates.name = newName
  }

  if (hasOverrides) {
    updates.allowOverrides = body.allowOverrides
  }

  const updated = await db.transaction(async (tx: TxnOrClient) =>
    updateCollection(tx, clId, updates),
  )
  enqueueKbMetadataSync({ kind: "collection", id: updated.id })

  const isPrivate = !(await isWorkspacePublic(
    db,
    { type: AclResourceType.Collection, id: updated.id },
    actor.workspaceId,
  ))
  return c.json({
    id: updated.id,
    name: updated.name,
    description: updated.description,
    totalItems: updated.totalItems,
    uploadStatus: updated.uploadStatus,
    isPrivate,
    allowOverrides: updated.allowOverrides,
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
  })
})

// DELETE /v2/kb/collections/:clId  (soft delete). Owner-only.
router.delete("/collections/:clId", async (c) => {
  const actor = await loadActor(c)
  const clId = c.req.param("clId")
  const access = await loadCollection(clId, actor)
  assertCanManage(access)
  const { collection } = access
  await db.transaction(async (tx: TxnOrClient) => {
    await softDeleteCollection(tx, clId)
    // The container is gone — drop its ACL grants (folders inherit, so their
    // access disappears with it).
    await revokeAllForResource(tx, {
      type: AclResourceType.Collection,
      id: clId,
    })
  })
  if (collection.vespaDocId) {
    try {
      await DeleteDocument(collection.vespaDocId, KbItemsSchema)
    } catch (err) {
      Logger.warn(
        { err, id: collection.vespaDocId },
        "Vespa collection metadata delete failed",
      )
    }
  }
  return c.json({ ok: true })
})

// ── Items (folders + files) ────────────────────────────────────────────────

// GET /v2/kb/collections/:clId/items?parentId=...&limit=&offset=
router.get("/collections/:clId/items", async (c) => {
  const actor = await loadActor(c)
  const clId = c.req.param("clId")
  const { canWrite, collection } = await loadCollection(clId, actor)
  const allowOverrides = collection.allowOverrides
  const parentRaw = c.req.query("parentId")
  const parentId = parentRaw && parentRaw !== "" ? parentRaw : null

  const limitRaw = c.req.query("limit")
  if (limitRaw !== undefined && limitRaw !== "") {
    const parsedLimit = Number.parseInt(limitRaw, 10)
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 200)
      : 50
    const offsetRaw = c.req.query("offset")
    const parsedOffset = offsetRaw ? Number.parseInt(offsetRaw, 10) : 0
    const offset = Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : 0
    const { items, total, folderCount, fileCount } =
      await getCollectionItemsByParentPaginated(db, clId, parentId, {
        limit,
        offset,
      })
    return c.json({
      items: items.map(toEntry),
      total,
      folderCount,
      fileCount,
      hasMore: offset + items.length < total,
      canWrite,
      allowOverrides,
    })
  }

  const items = await getCollectionItemsByParent(db, clId, parentId)
  let folderCount = 0
  let fileCount = 0
  for (const it of items) {
    if (it.type === "folder") {
      folderCount += 1
    } else {
      fileCount += 1
    }
  }
  return c.json({
    items: items.map(toEntry),
    total: items.length,
    folderCount,
    fileCount,
    hasMore: false,
    // Echoed so a UI deep-linking into a collection can hide owner-only buttons.
    canWrite,
    allowOverrides,
  })
})

export const kbGetItemHandler = async (
  c: Context<{ Variables: KbRouteVars }>,
) => {
  const actor = await loadActor(c)
  const clId = c.req.param("clId")
  const itemId = c.req.param("itemId")
  const { item } = await loadItemAccess(clId, itemId, actor)
  return c.json(toEntry(item))
}

router.get("/collections/:clId/items/:itemId", kbGetItemHandler)

// GET /v2/kb/collections/:clId/items/:itemId/breadcrumb
// Walks parentId chain so the UI can render path segments without N fetches.
router.get("/collections/:clId/items/:itemId/breadcrumb", async (c) => {
  const actor = await loadActor(c)
  const clId = c.req.param("clId")
  const itemId = c.req.param("itemId")
  const { item: leaf } = await loadItemAccess(clId, itemId, actor)

  const chain: { id: string; name: string }[] = []
  let cur: CollectionItem | null = leaf
  // Leaf's vespaDocId powers the "View Vespa document" affordance; the KB route
  // (unlike chat's CitationTab) must read it from here.
  const leafVespaDocId = leaf.vespaDocId ?? null
  const leafMimeType = leaf.mimeType ?? null
  while (cur && cur.collectionId === clId) {
    chain.unshift({ id: cur.id, name: cur.name })
    if (!cur.parentId) {
      break
    }
    cur = await getCollectionItemById(db, cur.parentId)
  }
  return c.json({ chain, vespaDocId: leafVespaDocId, mimeType: leafMimeType })
})

// POST /v2/kb/collections/:clId/folders  body: { name, parentId? }
router.post("/collections/:clId/folders", async (c) => {
  const actor = await loadActor(c)
  const clId = c.req.param("clId")
  assertCanWrite(await loadCollection(clId, actor))

  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string
    parentId?: string | null
  }
  const name = (body.name ?? "").trim()
  if (!name) {
    throw new HTTPException(400, { message: "name required" })
  }
  if (name.length > 255) {
    throw new HTTPException(400, { message: "name too long" })
  }
  const parentId = body.parentId ?? null

  let folder: CollectionItem
  try {
    folder = await db.transaction(async (tx: TxnOrClient) =>
      dbCreateFolder(tx, clId, parentId, name, {}, actor.id, actor.email),
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : "create failed"
    if (msg.includes("already exists")) {
      throw new HTTPException(409, { message: msg })
    }
    throw new HTTPException(400, { message: msg })
  }

  enqueueKbMetadataSync({ kind: "folder", id: folder.id })

  return c.json(toEntry(folder))
})

// PATCH /v2/kb/collections/:clId/items/:itemId — rename file or folder. For
// folders, descendants' `path` rows are rewritten in the same transaction to
// keep the (collection_id, path, name) uniqueness rule consistent and
// breadcrumbs resolvable. Vespa `fileName` is updated when the item has a
// vespaDocId (both files and folders carry Vespa docs here).
router.patch("/collections/:clId/items/:itemId", async (c) => {
  const actor = await loadActor(c)
  const clId = c.req.param("clId")
  const itemId = c.req.param("itemId")
  const itemAccess = await loadItemAccess(clId, itemId, actor)
  assertItemCanWrite(itemAccess)
  const item = itemAccess.item

  const body = (await c.req.json().catch(() => ({}))) as { name?: string }
  const newName = (body.name ?? "").trim()
  if (!newName) {
    throw new HTTPException(400, { message: "name required" })
  }
  if (newName.length > 255) {
    throw new HTTPException(400, { message: "name too long" })
  }

  if (item.name === newName) {
    return c.json(toEntry(item))
  }

  const conflict = await getCollectionItemByPath(db, clId, item.path, newName)
  if (conflict && conflict.id !== item.id) {
    throw new HTTPException(409, {
      message: `An item named "${newName}" already exists here`,
    })
  }

  const updated = await db.transaction(async (tx: TxnOrClient) => {
    const result = await updateCollectionItem(tx, itemId, {
      name: newName,
      lastUpdatedById: actor.id,
      lastUpdatedByEmail: actor.email,
    })
    if (item.type === "folder") {
      // Descendants store full ancestry in `path` (e.g. `/Foo/Bar/`); swap the
      // old prefix for the new one, preserving the suffix, in one statement.
      const oldPrefix = `${item.path}${item.name}/`
      const newPrefix = `${item.path}${newName}/`
      await tx
        .update(collectionItems)
        .set({
          path: sql`${newPrefix} || SUBSTRING(${collectionItems.path} FROM ${oldPrefix.length + 1})`,
          updatedAt: sql`NOW()`,
        })
        .where(
          and(
            eq(collectionItems.collectionId, clId),
            isNull(collectionItems.deletedAt),
            sql`${collectionItems.path} LIKE ${oldPrefix + "%"}`,
          ),
        )
    }
    return result
  })

  if (item.type === "folder") {
    enqueueKbMetadataSync({ kind: "folder", id: updated.id })
  } else if (item.vespaDocId) {
    const docIds =
      item.type === "file" ? expandSheetIds(item.vespaDocId) : [item.vespaDocId]
    for (const id of docIds) {
      try {
        await UpdateDocument(KbItemsSchema, id, { fileName: newName })
      } catch (err) {
        // Don't let a Vespa hiccup roll back the DB rename.
        Logger.warn({ err, id, type: item.type }, "Vespa rename update failed")
      }
    }
  }

  return c.json(toEntry(updated))
})

// DELETE /v2/kb/collections/:clId/items/:itemId
// Soft-delete + Vespa cleanup + storage unlink (folders recurse).
router.delete("/collections/:clId/items/:itemId", async (c) => {
  const actor = await loadActor(c)
  const clId = c.req.param("clId")
  const itemId = c.req.param("itemId")
  const itemAccess = await loadItemAccess(clId, itemId, actor)
  assertItemCanWrite(itemAccess)
  const item = itemAccess.item

  // Collect file descendants to unlink + un-index after soft delete.
  const toCleanup: CollectionItem[] = []
  if (item.type === "file") {
    toCleanup.push(item)
  } else {
    const walk = async (parentId: string): Promise<void> => {
      const children = await db
        .select()
        .from(collectionItems)
        .where(
          and(
            eq(collectionItems.parentId, parentId),
            isNull(collectionItems.deletedAt),
          ),
        )
      for (const ch of children) {
        toCleanup.push(ch)
        if (ch.type === "folder") {
          await walk(ch.id)
        }
      }
    }
    toCleanup.push(item)
    await walk(itemId)
  }

  await db.transaction(async (tx: TxnOrClient) => {
    await softDeleteCollectionItem(tx, itemId)
  })

  for (const it of toCleanup) {
    if (it.type === "file") {
      if (it.vespaDocId) {
        for (const id of expandSheetIds(it.vespaDocId)) {
          try {
            await DeleteDocument(id, KbItemsSchema)
          } catch (err) {
            Logger.warn({ err, id }, "Vespa file delete failed")
          }
        }
      }
      if (it.storagePath) {
        try {
          await unlink(it.storagePath)
        } catch (err) {
          Logger.warn({ err, path: it.storagePath }, "storage unlink failed")
        }
      }
    } else if (it.type === "folder" && it.vespaDocId) {
      try {
        await DeleteDocument(it.vespaDocId, KbItemsSchema)
      } catch (err) {
        Logger.warn({ err, id: it.vespaDocId }, "Vespa folder delete failed")
      }
    }
  }

  return c.json({ ok: true, deletedCount: toCleanup.length })
})

// ── Upload ─────────────────────────────────────────────────────────────────
//
// Overwrite support: soft-delete an existing file item and clean up its Vespa
// doc + storage bytes, so a re-upload of the same name can take its place
// (the unique-name index ignores soft-deleted rows). Mirrors the per-file
// cleanup in the DELETE route.
const purgeFileForOverwrite = async (item: CollectionItem): Promise<void> => {
  await db.transaction(async (tx: TxnOrClient) => {
    await softDeleteCollectionItem(tx, item.id)
  })
  if (item.vespaDocId) {
    for (const id of expandSheetIds(item.vespaDocId)) {
      try {
        await DeleteDocument(id, KbItemsSchema)
      } catch (err) {
        Logger.warn({ err, id }, "overwrite: Vespa delete failed")
      }
    }
  }
  if (item.storagePath) {
    try {
      await unlink(item.storagePath)
    } catch (err) {
      Logger.warn({ err, path: item.storagePath }, "overwrite: unlink failed")
    }
  }
}

export const kbUploadHandler = async (
  c: Context<{ Variables: KbRouteVars }>,
) => {
  const actor = await loadActor(c)
  const clId = c.req.param("clId")
  const access = await loadCollection(clId, actor)
  assertCanWrite(access)
  const collection = access.collection

  let formData: FormData
  try {
    formData = await c.req.formData()
  } catch (err) {
    Logger.error({ err }, "formData parse failed")
    throw new HTTPException(400, { message: "Invalid multipart body" })
  }
  const parentIdRaw = formData.get("parentId")
  const parentId =
    typeof parentIdRaw === "string" && parentIdRaw !== "" ? parentIdRaw : null
  const files = formData
    .getAll("files")
    .filter((f): f is File => f instanceof File)
  if (files.length === 0) {
    throw new HTTPException(400, { message: "No files provided" })
  }

  // Overwrite path: only when the owner has enabled it on this collection.
  // Purge any existing same-name file at this parent so the upload below
  // replaces it instead of failing the duplicate check.
  if (collection.allowOverrides) {
    const uploadNames = new Set(files.map((f) => sanitizeFileName(f.name)))
    const siblings = await getCollectionItemsByParent(db, clId, parentId)
    for (const sib of siblings) {
      if (sib.type === "file" && uploadNames.has(sib.name)) {
        await purgeFileForOverwrite(sib)
      }
    }
  }

  try {
    const result = await uploadKbFiles({
      actor,
      collection: { id: collection.id, name: collection.name },
      parentId,
      files,
    })
    return c.json(result)
  } catch (err) {
    if (err instanceof IngestionUploadError) {
      throw new HTTPException(err.statusCode, { message: err.message })
    }
    throw err
  }
}

router.post("/collections/:clId/upload", kbUploadHandler)

// GET /v2/kb/collections/:clId/files/:itemId/content
// Streams inline file bytes with Range support so react-pdf can chunk loads.
//
// Local-dev fallback: when DB + Vespa are tunneled to the VM but file blobs
// aren't, set `KB_CONTENT_PROXY_URL` to forward to the deployed instance. The
// access-token cookie is reusable because the JWT secret is shared with the VM.
router.get("/collections/:clId/files/:itemId/content", async (c) => {
  const actor = await loadActor(c)
  const clId = c.req.param("clId")
  const itemId = c.req.param("itemId")
  await loadItemAccess(clId, itemId, actor)

  const proxyBase = process.env["KB_CONTENT_PROXY_URL"]
  if (proxyBase) {
    const target = `${proxyBase.replace(/\/$/, "")}${c.req.path}`
    const forwardHeaders: Record<string, string> = {}
    const cookie = c.req.header("cookie")
    if (cookie) forwardHeaders["cookie"] = cookie
    const range = c.req.header("range")
    if (range) forwardHeaders["range"] = range
    const upstream = await fetch(target, {
      method: "GET",
      headers: forwardHeaders,
      redirect: "follow",
    })
    const passthrough = new Headers()
    // `Headers.forEach` over `.entries()`/iterator: only forEach is typed in
    // the @types/node Headers shim. Drop hop-by-hop headers and set-cookie.
    upstream.headers.forEach((v, k) => {
      const lk = k.toLowerCase()
      if (
        lk === "set-cookie" ||
        lk === "transfer-encoding" ||
        lk === "connection"
      ) {
        return
      }
      passthrough.set(k, v)
    })
    return new Response(upstream.body, {
      status: upstream.status,
      headers: passthrough,
    })
  }

  const item = await getCollectionItemById(db, itemId)
  if (!item || item.collectionId !== clId || item.type !== "file") {
    throw new HTTPException(404, { message: "File not found" })
  }
  const file = await getCollectionFileByItemId(db, itemId)
  if (!file || !file.storagePath) {
    throw new HTTPException(404, { message: "File data not found" })
  }

  let stats: Awaited<ReturnType<typeof stat>>
  try {
    stats = await stat(file.storagePath)
  } catch {
    throw new HTTPException(404, { message: "File content not found on disk" })
  }
  const fileSize = stats.size
  const range = c.req.header("range")
  const mimeType = file.mimeType || "application/octet-stream"
  const dispositionName = encodeURIComponent(file.originalName || "file")

  const baseHeaders: Record<string, string> = {
    // KB mimeTypes are attacker-influenced (svg/html run script inline), so
    // allowlist inline types + force download for the rest, with nosniff + a
    // sandbox CSP as defense in depth. See safeFileServeHeaders.
    ...safeFileServeHeaders(mimeType, dispositionName),
    "Cache-Control": "private, max-age=3600",
    "Accept-Ranges": "bytes",
  }

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    if (!m) {
      throw new HTTPException(416, { message: "Invalid range" })
    }
    const startStr = m[1] ?? ""
    const endStr = m[2] ?? ""
    let start: number
    let end: number
    if (startStr === "" && endStr !== "") {
      const suffix = parseInt(endStr, 10)
      if (Number.isNaN(suffix) || suffix <= 0) {
        return new Response("Range Not Satisfiable", {
          status: 416,
          headers: { "Content-Range": `bytes */${String(fileSize)}` },
        })
      }
      start = Math.max(0, fileSize - suffix)
      end = fileSize - 1
    } else {
      start = startStr ? parseInt(startStr, 10) : 0
      end = endStr ? parseInt(endStr, 10) : fileSize - 1
    }
    if (
      Number.isNaN(start) ||
      Number.isNaN(end) ||
      start > end ||
      end >= fileSize
    ) {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { "Content-Range": `bytes */${String(fileSize)}` },
      })
    }
    const chunkSize = end - start + 1
    const sp = file.storagePath
    return stream(c, async (w) => {
      c.header(
        "Content-Range",
        `bytes ${String(start)}-${String(end)}/${String(fileSize)}`,
      )
      c.header("Content-Length", String(chunkSize))
      for (const [k, v] of Object.entries(baseHeaders)) {
        c.header(k, v)
      }
      c.status(206)
      const rs = createFileReadStream(sp, {
        start,
        end,
        highWaterMark: 64 * 1024,
      })
      await new Promise<void>((resolve, reject) => {
        rs.on("data", async (chunk) => {
          try {
            await w.write(chunk as Buffer)
          } catch (e) {
            rs.destroy()
            reject(e)
          }
        })
        rs.on("end", () => {
          resolve()
        })
        rs.on("error", reject)
      })
    })
  }

  const sp = file.storagePath
  return stream(c, async (w) => {
    c.header("Content-Length", String(fileSize))
    for (const [k, v] of Object.entries(baseHeaders)) {
      c.header(k, v)
    }
    c.status(200)
    const rs = createFileReadStream(sp, { highWaterMark: 64 * 1024 })
    await new Promise<void>((resolve, reject) => {
      rs.on("data", async (chunk) => {
        try {
          await w.write(chunk as Buffer)
        } catch (e) {
          rs.destroy()
          reject(e)
        }
      })
      rs.on("end", () => {
        resolve()
      })
      rs.on("error", reject)
    })
  })
})

// GET /v2/kb/files/resolve/:docId[?chunk=N]
//
// pi-mono emits citations as `[<docId>#<chunk_index>]`. The chat UI strips
// those, calls this per unique docId, and opens the file at the cited page.
// 404 if docId absent from collection_items; 403 if caller can't read the
// collection. Returns only the minimal trio (clId, itemId, name) + page, never
// raw vespa fields.
router.get("/files/resolve/:docId", async (c) => {
  const actor = await loadActor(c)
  // Normalize non-ASCII hyphens to ASCII so docId lookups succeed
  const docId = c.req.param("docId").replace(/[‐‑‒–—―]/g, "-")
  const chunkRaw = c.req.query("chunk")
  const chunkIndex =
    chunkRaw && /^\d+$/.test(chunkRaw) ? Number(chunkRaw) : null

  const row = await getKbFileForVespaDocId(docId)
  if (!row) {
    throw new HTTPException(404, { message: "Unknown docId" })
  }

  // ACL — viewer needs at least read access on the file (inherits from folder /
  // collection, and honours a direct per-file grant).
  await loadItemAccess(row.collectionId, row.itemId, actor)

  // From the chunk's chunks_map entry, lift page number(s) and the PDF-coord
  // bbox. Frontend draws a precise overlay from the bbox — more reliable than
  // text-substring matching (breaks on tables/footnotes/hyphenation). A text
  // snippet ships as fallback for chunks with missing bbox.
  let pageNumber: number | null = null
  let chunkText: string | null = null
  let bbox: {
    l: number
    t: number
    r: number
    b: number
  } | null = null
  let pages: number[] = []
  if (chunkIndex !== null) {
    try {
      const span = getTracer("backendv2-kb").startSpan("resolveCitation")
      const resp = await GetDocumentsByDocIds([docId], span)
      const doc = resp?.root?.children?.[0]
      const fields = (doc?.fields ?? {}) as Record<string, unknown>
      const chunksMap = fields["chunks_map"]
      if (Array.isArray(chunksMap)) {
        const entry = (
          chunksMap as Array<{
            chunk_index: number
            page_numbers?: number[]
            bbox_l?: number
            bbox_t?: number
            bbox_r?: number
            bbox_b?: number
          }>
        ).find((m) => m.chunk_index === chunkIndex)
        if (entry?.page_numbers && entry.page_numbers.length > 0) {
          pages = entry.page_numbers.map((page) => page + 1)
          pageNumber = toViewerPageNumber(entry.page_numbers[0])
        }
        if (
          entry &&
          typeof entry.bbox_l === "number" &&
          typeof entry.bbox_t === "number" &&
          typeof entry.bbox_r === "number" &&
          typeof entry.bbox_b === "number"
        ) {
          bbox = {
            l: entry.bbox_l,
            t: entry.bbox_t,
            r: entry.bbox_r,
            b: entry.bbox_b,
          }
        }
      }
      const chunksRaw = fields["chunks"] ?? fields["chunks_summary"]
      if (Array.isArray(chunksRaw)) {
        const raw = (chunksRaw as unknown[])[chunkIndex]
        const text =
          typeof raw === "string"
            ? raw
            : raw && typeof raw === "object"
              ? ((raw as { chunk?: string; text?: string }).chunk ??
                (raw as { chunk?: string; text?: string }).text ??
                "")
              : ""
        // Build a snippet the PDF text layer will actually contain. Docling
        // chunks may carry HTML/markdown, but pdf.js's text layer has only
        // plain glyphs — strip all formatting, collapse whitespace, and drop
        // the leading "[Page N]" marker.
        const cleaned = String(text)
          .replace(/^\[Page \d+(-\d+)?\]\s*/, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&[a-z]+;|&#\d+;/gi, " ")
          .replace(/[*_`~#>|]+/g, " ")
          .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
          .replace(/\s+/g, " ")
          .trim()
        if (cleaned.length > 0) {
          // pdf.js findController matches as a single phrase (normalising
          // whitespace), so a long contiguous span highlights the whole
          // passage. Cap at ~30 words for headroom against docling-vs-PDF
          // drift; drop a leading single-char token (table-cell residue).
          const tokens = cleaned.split(" ")
          while (tokens.length > 0 && tokens[0]!.length <= 1) tokens.shift()
          const snippet = tokens.slice(0, 30).join(" ")
          chunkText = snippet.length > 3 ? snippet : null
        }
      }
    } catch (err) {
      Logger.warn(
        { err, docId, chunkIndex },
        "resolve: vespa chunk lookup failed",
      )
    }
  }

  return c.json({
    docId,
    itemId: row.itemId,
    collectionId: row.collectionId,
    name: row.name,
    mimeType: row.mimeType,
    chunkIndex,
    pageNumber,
    pages,
    bbox,
    chunkText,
  })
})

// GET /v2/kb/files/inspect/:docId
//
// Returns the raw Vespa document fields the agent's search tools see, so an
// operator can compare the index against the rendered PDF ("View Vespa
// document" affordance). Viewer needs read on the file (inherits from the
// collection, and honours a direct per-file grant).
router.get("/files/inspect/:docId", async (c) => {
  const actor = await loadActor(c)
  const docId = c.req.param("docId").replace(/[‐‑‒–—―]/g, "-")

  const row = await getKbFileForVespaDocId(docId)
  if (!row) {
    throw new HTTPException(404, { message: "Unknown docId" })
  }
  await loadItemAccess(row.collectionId, row.itemId, actor)

  const span = getTracer("backendv2-kb").startSpan("vespaInspect")
  let fields: Record<string, unknown> = {}
  try {
    const resp = await GetDocumentsByDocIds([docId], span)
    const doc = resp?.root?.children?.[0]
    fields = (doc?.fields ?? {}) as Record<string, unknown>
  } finally {
    span.end()
  }

  return c.json({
    docId,
    itemId: row.itemId,
    collectionId: row.collectionId,
    name: row.name,
    fields,
  })
})

// GET /v2/kb/search?q=<query>&limit=<n>
//
// Spotlight-style "go to file": file rows whose name contains `q` (case-
// insensitive) across every readable collection. Files only. Ranks prefix
// matches first, then recency. Filename ILIKE rather than Vespa — tiny row
// count, and stays correct for freshly-uploaded files not yet indexed.
router.get("/search", async (c) => {
  const actor = await loadActor(c)
  const q = (c.req.query("q") ?? "").trim()
  const limitRaw = Number(c.req.query("limit") ?? "20")
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(50, Math.floor(limitRaw)))
    : 20

  if (q.length === 0) {
    return c.json({ results: [] })
  }

  // Accessible collections via the unified resolver (owned + shared + public),
  // replacing the legacy owner_id / permissions / is_private predicate so KB
  // search honours acl-only shares.
  const accessibleIds = await accessibleResourceIds(
    db,
    { userId: actor.id, workspaceId: actor.workspaceId },
    AclResourceType.Collection,
  )
  if (accessibleIds.length === 0) {
    return c.json({ results: [] })
  }
  const accessible = await db
    .select({ id: collections.id, name: collections.name })
    .from(collections)
    .where(
      and(inArray(collections.id, accessibleIds), isNull(collections.deletedAt)),
    )
  if (accessible.length === 0) {
    return c.json({ results: [] })
  }
  const idToName = new Map(accessible.map((cl) => [cl.id, cl.name]))
  const collectionIds = accessible.map((cl) => cl.id)

  // Parameterisation stops SQL injection but not LIKE metacharacters (`%`/`_`/
  // `\`) — escape them explicitly (with ESCAPE '\' below), else `q = "%"`
  // matches everything. LOWER() lets the index serve mixed-case queries.
  const escapedQ = q.toLowerCase().replace(/[\\%_]/g, "\\$&")
  const needle = `%${escapedQ}%`
  const prefix = `${escapedQ}%`

  const rows = await db
    .select({
      id: collectionItems.id,
      collectionId: collectionItems.collectionId,
      parentId: collectionItems.parentId,
      name: collectionItems.name,
      path: collectionItems.path,
      mimeType: collectionItems.mimeType,
      fileSize: collectionItems.fileSize,
      uploadStatus: collectionItems.uploadStatus,
      updatedAt: collectionItems.updatedAt,
      vespaDocId: collectionItems.vespaDocId,
    })
    .from(collectionItems)
    .where(
      and(
        inArray(collectionItems.collectionId, collectionIds),
        eq(collectionItems.type, "file"),
        isNull(collectionItems.deletedAt),
        sql`LOWER(${collectionItems.name}) LIKE ${needle} ESCAPE '\\'`,
      ),
    )
    .orderBy(
      sql`CASE WHEN LOWER(${collectionItems.name}) LIKE ${prefix} ESCAPE '\\' THEN 0 ELSE 1 END`,
      desc(collectionItems.updatedAt),
    )
    .limit(limit)

  return c.json({
    results: rows.map((r) => ({
      id: r.id,
      collectionId: r.collectionId,
      collectionName: idToName.get(r.collectionId) ?? "",
      parentId: r.parentId,
      name: r.name,
      path: r.path,
      mimeType: r.mimeType,
      fileSize: r.fileSize,
      uploadStatus: r.uploadStatus,
      updatedAt: r.updatedAt,
      vespaDocId: r.vespaDocId,
    })),
  })
})

// Keep UploadStatus imported for future status polling.
void UploadStatus

export default router
