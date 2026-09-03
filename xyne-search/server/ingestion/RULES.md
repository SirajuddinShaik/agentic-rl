# Ingestion Revamp Rules

This file is the working contract for the ingestion revamp. The goal is a lean,
v2-first ingestion module that follows the same route/service discipline as
`server/backendv2`, without dragging legacy compatibility into the new code.

## Objective

`server/ingestion` owns the document ingestion lifecycle for knowledge-base
artifacts after `backendv2` accepts the UI-facing request:

- Validate upload targets and create file records needed for ingestion.
- Admit files into the correct processing path.
- Process files through standard processors or Docling OCR.
- Track processing status, retries, leases, and worker progress.
- Write searchable documents and metadata into Vespa.

`backendv2` owns the `/v2/kb/*` HTTP API, including the UI upload route. It
resolves auth/session context, parses HTTP input, preserves response shapes, and
calls ingestion only through stable public APIs. It must not own ingestion
internals.

Read surfaces such as file byte streaming, citation resolution, search/inspect
views, browse/listing, breadcrumbs, and viewer-specific projections stay in
`backendv2` even when they use KB rows, storage paths, or Vespa document IDs.

## Non-Negotiables

- Do not delete old ingestion/KB code during this revamp. Old flows can stay as
  legacy code until we explicitly remove them in a later cleanup.
- Do not put legacy fallbacks, compatibility branches, or old-flow shims inside
  `server/ingestion`.
- If a compatibility shim is temporarily required, place it outside
  `server/ingestion` and make it obvious that it is temporary.
- Do not lose existing v2 ingestion functionality. Upload admission,
  processing status, Docling scheduling, Vespa indexing, autoscaling, and
  observability must keep working.
- Prefer simple service boundaries over clever abstractions. The code should be
  easy to read before it is highly generic.
- Keep routes thin. Routes parse HTTP input, call services, and map service
  results to HTTP responses.
- Keep service methods explicit. Avoid large "manager" classes that hide many
  unrelated workflows behind one generic method.
- Shared code with `backendv2` must move to `server/common`. Code used only by
  ingestion stays under `server/ingestion`.
- New ingestion code must not import from `server/backendv2`.
- `backendv2` should only import stable ingestion public APIs, not internal
  processors, repositories, workers, or storage code.

## Ownership Rules

### Belongs In `server/ingestion`

- Collection, folder, and file operations only when required for upload target
  validation, ingestion state tracking, processing, metadata sync, or Vespa
  indexing.
- Upload orchestration and file storage decisions.
- MIME detection, checksum, storage-key generation, and ingestion file naming
  when used only by ingestion.
- File processing for text, office files, sheets, images, and PDFs.
- Docling scheduler intake, store, workers, runtime config, permits, result
  handling, and async wrapper integration.
- Vespa document construction for KB artifacts.
- KB metadata sync for collections and folders.
- Ingestion worker entrypoints.
- OCR autoscaler logic, VM submitter coordination, discovery, and metrics.
- Ingestion observability and diagnostics.
- Processing-facing status projections needed by workers, reapers, autoscaler,
  and upload progress.

### Belongs In `server/backendv2`

- Auth/session middleware and browser session lifecycle.
- Chat, agents, sub-agents, skills, admin, and model catalog routes.
- Agent-specific orchestration over search results.
- The full `/v2/kb/*` HTTP route surface, including UI uploads.
- Collection and folder browse/management APIs.
- Item listing, breadcrumbs, and viewer-specific response shaping.
- User-facing read/query surfaces over already-ingested artifacts, including
  file byte streaming, citation target resolution, KB file search, and Vespa
  inspect views.

### Belongs In `server/common`

Use `server/common` only when both `backendv2` and `ingestion` need the same
primitive. Examples:

- HTTP error mapping helpers.
- Auth actor types or JWT payload types that are not ingestion-specific.
- Generic range-header parsing.
- Generic file-name sanitization if non-ingestion APIs also need it.
- PDF parsing/chunking primitives used by both ingestion and non-KB
  integrations.
- Generic Vespa client wrappers that are not KB-document specific.

Do not move code to `common` preemptively. A shared folder is useful only when
there is real shared ownership.

## Read Surface Boundary

The revamp treats ingestion as the owner of upload and processing, not every
read model over KB artifacts.

Ingestion must not own KB read/view APIs. File content streaming, citation
resolution, Vespa inspect/search, breadcrumbs, browse/listing, and
viewer-specific response shaping stay in `backendv2` even if they use KB rows,
storage paths, or Vespa document IDs.

File byte streaming is a user-facing read concern. It depends on collection
access, storage paths, MIME type, and range handling, but it does not decide
upload admission or processing. Keep it outside core ingestion unless a worker
needs the same primitive for processing.

Citation resolution, KB search, and Vespa inspect are also read/query concerns.
They can use ingestion-produced identifiers and metadata, but they should not be
part of the ingestion processing module.

If read surfaces need shared primitives such as range parsing or storage path
resolution, put those primitives in `server/common` only when both ingestion and
backendv2 use them. Do not add local-dev proxy behavior, legacy fallbacks, or
viewer-specific response shaping to `server/ingestion`.

## Desired Folder Shape

Use this shape as the direction of travel. It can evolve, but new code should
fit one of these buckets. Do not add folders just to make the tree look
complete; create a folder when at least one real module belongs there.

```text
server/ingestion/
  RULES.md
  public.ts
  domain/
    errors.ts
    types.ts
    metadata.ts
    processingStatus.ts
  services/
    access.ts
    uploadService.ts
    admissionService.ts
    processingStatusService.ts
    metadataSyncService.ts
  repositories/
    kbUploadRepository.ts
    processingJobRepository.ts
    doclingSchedulerRepository.ts
  storage/
    uploadStorage.ts
    doclingStageStorage.ts
  queue/
    queueNames.ts
    producer.ts
    worker.ts
  processors/
    standardFileProcessor.ts
    pdfProcessor.ts
    officeProcessor.ts
    sheetProcessor.ts
  indexing/
    kbDocumentBuilder.ts
    kbMetadataSync.ts
    kbIndexer.ts
  docling/
    resultMapper.ts
    runtime/
      activeFiles.ts
      client.ts
      config.ts
      state.ts
      submitPermits.ts
    scheduler/
      intake.ts
      permits.ts
      storage.ts
      store.ts
    workers/
      splitter.ts
      submitter.ts
      result.ts
      writer.ts
      reaper.ts
  autoscaler/
    decision.ts
    discovery.ts
    metrics.ts
  observability/
    diagnostics.ts
    health.ts
    metrics.ts
  entrypoints/
    apiQueueInit.ts
    standardFileWorker.ts
    doclingSplitter.ts
    doclingSubmitter.ts
    doclingResult.ts
    doclingWriter.ts
    doclingReaper.ts
    autoscaler.ts
```

Shared PDF primitives used by ingestion and non-KB integrations belong in:

```text
server/common/pdf/
  pdfProcessor.ts
  pdfLibSemaphore.ts
```

Keep all user-facing HTTP routes outside this folder. The ingestion module
should expose stable functions through `public.ts`, not own `/v2/kb/*` routes.

Old `server/lib/*` paths may temporarily re-export ingestion modules for
legacy callers, but ingestion code must import ingestion-owned Docling,
autoscaler, observability, and KB metadata-sync modules through
`@/ingestion/...` paths directly.

## HTTP Route Rules

`backendv2` owns HTTP route handlers. Those routes must stay boring:

- Validate and parse request input.
- Resolve the actor.
- Call one backendv2 service method or one stable ingestion public function.
- Translate typed service errors to HTTP responses.
- Return the service response.

Routes must not:

- Reach into ingestion internals directly.
- Open files directly when the behavior belongs to ingestion storage.
- Write uploaded bytes directly.
- Build Vespa documents.
- Call Docling directly.
- Own retry logic.
- Own scheduler admission logic.
- Contain large SQL or Drizzle workflows.
- Contain VM/deployment-specific behavior.

## Service Rules

Services own business workflows:

- `UploadService` handles upload orchestration and dispatches processing.
- `AdmissionService` chooses standard processing vs Docling scheduler.
- `ProcessingStatusService` exposes processing state needed by uploads,
  workers, reapers, and autoscaler.
- `MetadataSyncService` syncs collection/folder metadata required by ingestion
  to Vespa.

Services should return typed results, not raw Hono responses.

## Repository Rules

Repositories isolate persistence details:

- Drizzle queries live in repositories or schema-adjacent DB helpers.
- Services should not contain large query blocks.
- Repositories return domain-shaped records or explicit DTOs.
- Keep transactions in the service when the transaction spans multiple
  repositories; keep them in the repository when the operation is purely local.

During migration, repositories may wrap existing `server/db/knowledgeBase.ts`
helpers. Do not move that legacy file wholesale until all important callers are
migrated.

Repository names should describe the ingestion use case, not the whole product
area. Prefer `kbUploadRepository` over `knowledgeBaseRepository` unless the
module truly owns all KB persistence.

## Processor And Indexing Rules

- Processors extract content. They should not decide user access.
- Indexing code builds and writes Vespa documents.
- The Vespa KB document shape must be centralized in one builder.
- Standard file processing and Docling processing must not duplicate metadata
  merge, chunk map, or `fileName` construction logic.
- Retry and terminal failure policy should be explicit and tested.

## Runtime Role Rules

The code should match the production deployment model where ingestion runs as
separate roles/containers:

- API/backend role: accepts UI uploads and calls ingestion to admit work.
- File worker role: handles standard non-PDF processing.
- Docling splitter role: splits/stages PDFs.
- Docling submitter role: submits page chunks to wrapper/OCR capacity.
- Docling result role: consumes wrapper/OCR results.
- Docling writer role: writes completed parts to Vespa and DB.
- Reaper role: repairs leases, retries, stale work, and metadata sync.
- Autoscaler role: observes queue/runtime metrics and adjusts submitter
  capacity.

Each entrypoint should be tiny. Runtime role behavior belongs in services or
workers under `server/ingestion`, not in top-level scripts.

## Migration Rules

- Move behavior first, delete later.
- Keep every migration step reviewable and testable.
- Avoid broad renames mixed with logic changes.
- When moving a file, preserve behavior and imports first. Refactor internals in
  a follow-up commit.
- Do not add a compatibility branch to the new ingestion implementation just
  because legacy code expects it.
- If a temporary shim is unavoidable, put it outside `server/ingestion` and add a
  removal note in the PR description.

## Verification Rules

Every meaningful step should have at least one focused check:

- KB route/service changes: KB unit tests and a route import smoke test.
- Upload changes: upload service tests with storage/queue fakes.
- Processor changes: file type processor tests.
- Docling changes: scheduler store/permit/runtime tests.
- Indexing changes: Vespa document builder snapshot or structural tests.
- Autoscaler changes: decision/metrics tests.

Full server TypeScript currently has unrelated legacy failures. Do not treat
that as proof a change is safe. Use focused tests until the broader TS baseline
is cleaned up.

## Current First Checkpoint

The revamp has only started and is currently in a transitional state:

- The real v2 KB route currently lives at
  `server/ingestion/routes/knowledgeBase.ts`.
- `backendv2` currently mounts that broad route from ingestion.
- KB actor/access logic lives in `server/ingestion/services/knowledgeBaseAccess.ts`.
- The old `server/backendv2/routes/knowledgeBase.ts` file is only a temporary
  shim.

The next implementation step should restore `/v2/kb/*` route ownership to
`backendv2` before extracting upload services, Docling, processors, autoscaler,
or worker entrypoints.
