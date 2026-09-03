# Ingestion VM Deployment

This folder codifies the current `xyne-k8s-test` ingestion runtime without
recreating Redis, Postgres, Vespa, `backendv2`, or `frontend`.

The source of truth used to build this was the live VM snapshot from
`/home/shivral_somani_juspay_in/xyne-stack` on 2026-06-11. A backup was created
before any repo deployment work:

```text
/home/aayush_shah_juspay_in/xyne-ingestion-backups/ingestion-deploy-20260611T093356Z.tar.gz
```

The verified ingestion-only rollout is currently:

```text
image: xyne-ingestion:04225090bad1-20260611T101113Z
pre-rollout backup: /home/aayush_shah_juspay_in/xyne-ingestion-backups/ingestion-deploy-20260611T101123Z.tar.gz
```

## Runtime Mapping

| VM container | Repo service | Entrypoint | Command | Key env | Volumes |
| --- | --- | --- | --- | --- | --- |
| `xyne-app-sync` | `app-sync` | `server/sync-server.ts` | `bun run sync-server.ts` | `DOCLING_SERVICE_URL=http://10.2.0.83`, `REDIS_URL=redis://redis:6379/0`, `DOCLING_ASYNC_PART_SUBMIT_CONCURRENCY=1`, `PGBOSS_POOL_MAX=20` | `data/app-uploads`, `data/app-logs`, `data/app-assets`, `data/app-migrations`, `data/app-downloads`, `litellm-models.json` |
| `xyne-stack-app-sync-result-worker-1` | `app-sync-result-worker` | `server/doclingResultWorker.ts` | `bun run doclingResultWorker.ts` | `DOCLING_RESULT_GROUP=app-sync`, `DOCLING_RESULT_READ_COUNT=1`, `DB_POOL_MAX=10` | `data/app-uploads`, `data/app-logs`, `data/app-downloads`, `litellm-models.json` |
| `docling-scheduler-splitter` | `docling-scheduler-splitter` | `server/doclingSchedulerWorker.ts` | `bun doclingSchedulerWorker.ts` | `DOCLING_SCHEDULER_ROLE=splitter`, `DOCLING_SCHEDULER_SPLIT_CONCURRENCY=8` | `data/app-uploads`, `data/app-logs`, `data/app-downloads`, `litellm-models.json` |
| `docling-scheduler-submitter` | `docling-scheduler-submitter` | `server/doclingSchedulerWorker.ts` | `bun doclingSchedulerWorker.ts` | `DOCLING_SCHEDULER_ROLE=submitter`, `DOCLING_SCHEDULER_SUBMIT_CLAIM_BATCH_SIZE=32`, `DOCLING_SCHEDULER_MAX_CONCURRENT_CLAIMERS=1` | same scheduler mounts |
| `docling-scheduler-submitter-2..30` | `submitter-spares` profile | `server/doclingSchedulerWorker.ts` | `bun doclingSchedulerWorker.ts` | Same submitter env; normally stopped and controlled by autoscaler | same scheduler mounts |
| `docling-scheduler-result(-2..-4)` | result services | `server/doclingSchedulerWorker.ts` | `bun doclingSchedulerWorker.ts` | `DOCLING_SCHEDULER_ROLE=result`, `DOCLING_RESULT_READ_COUNT=50` | same scheduler mounts |
| `docling-scheduler-writer` | `docling-scheduler-writer` | `server/doclingSchedulerWorker.ts` | `bun doclingSchedulerWorker.ts` | `DOCLING_SCHEDULER_ROLE=writer`, `DOCLING_SCHEDULER_VESPA_WRITE_PERMITS=8` | same scheduler mounts |
| `docling-scheduler-reaper` | `docling-scheduler-reaper` | `server/doclingSchedulerWorker.ts` | `bun doclingSchedulerWorker.ts` | `DOCLING_SCHEDULER_ROLE=reaper`, retry and timeout env from VM | same scheduler mounts |
| `xyne-ocr-autoscaler` | `ocr-autoscaler` | `server/scripts/ocrAutoscaler.ts` wrapper to `server/ingestion/autoscaler/runner.ts` | `bun run scripts/ocrAutoscaler.ts` | `OCR_AUTOSCALER_GCP_ACTUATOR=metadata`, `OCR_AUTOSCALER_RESIZE_MIGS=true`, `OCR_AUTOSCALER_WRAPPER_*`, `OCR_AUTOSCALER_A100_*`, `OCR_COST_CONFIG_PATH=/etc/xyne/ocr-costs.json` | Docker socket, `/opt/monitoring/ocr-costs.json`, submitter helper scripts |

Shared dependencies are external and are not recreated by this stack:
`xyne-db`, `xyne-redis`, `vespa`, `entrag-vespa`, wrapper MIG, and A100 MIG.

## Known VM Mismatches Preserved

- The live autoscaler is a manual sidecar today. This deployment makes it
  compose-managed, but preserves container name, command, Docker socket access,
  metrics port, cost file mount, and helper script behavior.
- `OCR_AUTOSCALER_SUBMITTER_CONTAINER_COUNT=6` remains in the live env, while
  the active helper scripts dynamically discover all predeclared submitters up
  to `docling-scheduler-submitter-30`. The helper behavior is what matters.
- `xyne-app-sync` also owns broader sync work. It is behind the `app-sync`
  profile and is skipped by default. Set
  `INGESTION_DEPLOY_INCLUDE_APP_SYNC=true` only when rolling standard file
  worker/app-sync code is required.
- The VM database does not currently have the KB metadata sync columns from
  `server/migrations/0015_kb_metadata_sync.sql`. The ingestion reaper keeps
  the VM behavior by skipping that repair subtask when those columns are absent
  instead of applying migrations or failing the reaper loop.

## Submitter Drain Safety

The autoscaler must not downscale Docling submitter containers while OCR work is
still active. A previous failure mode left rows in `docling_async_parts.status =
'submitting'` when spare submitter containers were stopped while their outbound
Docling submit calls were still in progress.

Current repo-managed behavior:

- Submitter downscale is allowed only when there is no pending or active OCR
  work.
- Submitter scale-up can still happen while OCR work is active and the permit
  fill target allows more submission pressure.
- Submitter shutdown releases queued-but-not-started rows immediately.
- In-flight submit calls are allowed to drain for
  `DOCLING_SCHEDULER_SUBMITTER_SHUTDOWN_DRAIN_MS=180000`.
- Compose gives submitter containers `stop_grace_period: 200s`, so Docker does
  not kill the process before the drain window completes.
- Active submit work is not force-requeued on SIGTERM. If it outlives the drain
  window, the existing lease/reaper path remains the recovery mechanism.

Useful checks during or after a scale-down:

```bash
sudo docker exec xyne-db psql -U xyne -d xyne -P pager=off -c "
select status, count(*) as parts, coalesce(sum(greatest(end_page-start_page,0)),0) as pages
from docling_async_parts
group by status
order by status;"

sudo docker logs --since 10m docling-scheduler-submitter 2>&1 |
  grep -E 'shutdown drain|active submit work|submitter'
```

## Build And Deploy

Create local config:

```bash
cp deployment/ingestion/.env.example deployment/ingestion/.env.local
```

Dry-run remote backup and compose validation:

```bash
INGESTION_DRY_RUN=true deployment/ingestion/deploy-vm.sh
```

Default deployment, scoped to Docling scheduler/result/autoscaler:

```bash
deployment/ingestion/deploy-vm.sh
```

Build on the VM when local Docker is unavailable:

```bash
INGESTION_BUILD_ON_VM=true deployment/ingestion/deploy-vm.sh
```

Include `xyne-app-sync` only when needed:

```bash
INGESTION_DEPLOY_INCLUDE_APP_SYNC=true deployment/ingestion/deploy-vm.sh
```

## Verification

The deploy script verifies:

- autoscaler `/metrics`
- Redis runtime/result stream state
- `docling_async_files` DB status counts
- status and recent logs for ingestion containers
- unchanged start times for unrelated app/DB/Redis/Vespa/monitoring containers

Manual checks:

```bash
curl -fsS http://127.0.0.1:3021/metrics | head
sudo docker exec xyne-redis redis-cli HGETALL docling:runtime-config
sudo docker exec xyne-redis redis-cli XINFO GROUPS docling:results
sudo docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' |
  grep -E 'xyne-app-sync|docling-scheduler|xyne-ocr-autoscaler'
```

## Rollback

For future repo-managed releases where all ingestion services used one image,
use the previous image tag from the backup `docker-ps-a.txt` or from
`docker images`.

```bash
ROLLBACK_IMAGE=xyne-ingestion:<previous-tag> \
  deployment/ingestion/rollback-vm.sh
```

For restoring the original mixed VM topology, unpack the backup tarball and
restore the captured compose/env files from `files/stack-files.tar.gz`, then
recreate only the ingestion containers from the original compose/manual
autoscaler configuration recorded in `docker-inspect/`. Do not run Docker
system prune and do not recreate Redis/Postgres/Vespa.
