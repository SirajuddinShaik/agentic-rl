# Local OCR Mock VM Topology

This file explains the local setup created to mimic the GCP VM OCR path.

Use this local Grafana URL:

```text
http://127.0.0.1:3002
```

Do not use `100.111.195.29:3002` for this local machine. That is the remote
Saket machine.

## Goal

The local setup mocks the VM shape without needing real GCP internal LBs,
managed instance groups, A100 machines, or LightOn OCR machines.

It gives us:

- app/app-sync containers
- Postgres, Redis, Vespa
- a Docling-server LB mock
- wrapper LB and wrapper nodes
- A100/OCR-BBox LB and two OCR-BBox backend nodes
- Prometheus, Grafana, Loki, Alloy, and exporters
- an OCR autoscaler that emits metrics and Prometheus HTTP SD targets

## Main URLs

```text
Grafana:        http://127.0.0.1:3002
Prometheus:     http://127.0.0.1:9090
Autoscaler:     http://127.0.0.1:3021
Loki:           http://127.0.0.1:3100
Alloy UI:       http://127.0.0.1:12345
App:            http://127.0.0.1:3000
App-sync:       http://127.0.0.1:3010
```

## Service Groups

### 1. Xyne App Runtime

These containers mimic the VM app/runtime dependencies.

| Container | Purpose | Local Port |
| --- | --- | --- |
| `xyne-app` | Main Xyne app | `3000`, `3001` |
| `xyne-app-sync` | App-sync worker path | `3010` |
| `xyne-db` | Postgres | `5432` |
| `xyne-redis` | Redis queues, locks, runtime config | `6379` |
| `vespa` | Vespa search/indexing | `8080`, `8081`, `19071` |
| `xyne-keycloak` | Auth mock/support service | `8082` |

The VM-like app defaults point Docling traffic at:

```text
DOCLING_SERVICE_URL=http://10.2.0.83
```

For pure local mock mode, override app traffic to:

```text
DOCLING_SERVICE_URL=http://xyne-docling-server-lb:8000
```

### 2. Mock Docling / OCR Path

This mocks the GCP internal Docling LB, wrapper fleet, and OCR-BBox backend
fleet.

| Container | Purpose | Local Port |
| --- | --- | --- |
| `xyne-docling-server-lb` | Local mock of GCP internal Docling LB | `8400` |
| `xyne-wrapper-lb` | Wrapper LB | `8200` |
| `xyne-wrapper-lighton-1` | Wrapper backend node 1 | `8201` |
| `xyne-wrapper-lighton-2` | Wrapper backend node 2 | `8202` |
| `xyne-a100-lb` | OCR-BBox/A100 backend LB | `8100` |
| `light-ocr-bbox` | OCR-BBox backend node 1 | `8301` |
| `lighton-ocr-bbox` | OCR-BBox backend node 2 | `8302` |

Current local OCR-BBox backend fleet size:

```text
2 nodes
```

The two OCR-BBox nodes are:

```text
host.docker.internal:8301
host.docker.internal:8302
```

### 3. Observability

| Container | Purpose | Local Port |
| --- | --- | --- |
| `xyne-grafana` | Dashboards | `3002` |
| `xyne-prometheus` | Metrics store/scrape | `9090` |
| `xyne-ocr-autoscaler` | Autoscaler loop, metrics, HTTP SD | `3021` |
| `xyne-loki` | Logs backend | `3100` |
| `xyne-alloy` | Docker log collection | `12345` |
| `cadvisor` | Container metrics | `8083` |
| `node-exporter` | Host metrics | `9100` |
| `postgres-exporter` | Postgres metrics | `9187` |
| `redis-exporter` | Redis metrics | `9121` |

## Traffic Flow

Local mock app traffic can flow like this:

```text
xyne-app-sync
  -> xyne-docling-server-lb:8000
  -> xyne-wrapper-lb:8000
  -> xyne-wrapper-lighton-1 or xyne-wrapper-lighton-2
  -> xyne-a100-lb:8000
  -> light-ocr-bbox or lighton-ocr-bbox
```

Host-visible equivalent:

```text
127.0.0.1:8400  -> Docling-server LB mock
127.0.0.1:8200  -> wrapper LB
127.0.0.1:8100  -> OCR-BBox/A100 LB
127.0.0.1:8301  -> OCR-BBox node 1
127.0.0.1:8302  -> OCR-BBox node 2
```

## Prometheus Discovery

The autoscaler exposes HTTP service discovery endpoints:

```text
http://127.0.0.1:3021/prometheus/targets/vllm
http://127.0.0.1:3021/prometheus/targets/wrapper
```

Expected local target output:

```text
vllm/a100:
host.docker.internal:8301
host.docker.internal:8302

wrapper:
host.docker.internal:8201
host.docker.internal:8202
```

Prometheus scrapes the OCR-BBox backends directly as:

```text
job="ocr-vllm-direct"
```

Wrapper fleet health is represented through autoscaler metrics such as
`xyne_ocr_wrapper_nodes`, not a direct `ocr-wrapper-direct` Prometheus job.

## Autoscaler Motion

The local setup has fixed Docker containers. It does not create or destroy
containers like a real GCP MIG.

Instead, local autoscaling motion is simulated by changing demand over time:

```text
OCR_AUTOSCALER_SIM_DEMAND_PAGES=0,125,500,9000,0
OCR_AUTOSCALER_INTERVAL_MS=15000
```

This makes Grafana show changing:

- pending OCR pages
- desired wrapper nodes
- desired A100/OCR-BBox nodes
- admitted page budget
- submit permits
- Redis runtime config

The real local scrape targets remain the same two wrapper nodes and two
OCR-BBox nodes.

## Redis Runtime Config

The autoscaler writes runtime config into Redis:

```text
docling:runtime-config
```

Useful command:

```bash
docker exec xyne-redis redis-cli HGETALL docling:runtime-config
```

Typical fields:

```text
admitted_page_budget
max_inflight_pages
submit_permits
active_ocr_files
target_active_ocr_files
page_chunk_size
submitter_concurrency_per_container
version
updated_at
```

Because local simulated demand cycles, these values can change every 15 seconds.

## Cost Metrics

Cost rates are read by the autoscaler from:

```text
deployment/monitoring-vm/ocr-costs.json
```

Current file shape:

```json
{
  "currency": "USD",
  "a100CostPerHour": 8,
  "wrapperCostPerHour": 0.7907
}
```

Set real per-hour values here:

- `a100CostPerHour`: one OCR/A100 machine per hour
- `wrapperCostPerHour`: one OCR server-wrapper machine per hour

The autoscaler exports:

```text
xyne_ocr_fleet_node_cost_per_hour
xyne_ocr_fleet_cost_per_hour
xyne_ocr_estimated_cost_per_hour
```

Grafana dashboard panels:

- `Current OCR Cost / Hour`
- `Estimated OCR Cost In Selected Range`
- `Fleet Cost / Hour`

If the configured rates are `0`, the cost dashboard will correctly show `0`.

## Quick Validation

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

curl -fsS http://127.0.0.1:3021/prometheus/targets/vllm
curl -fsS http://127.0.0.1:3021/prometheus/targets/wrapper

curl -fsS http://127.0.0.1:3021/metrics | grep 'xyne_ocr_estimated_cost_per_hour'

curl -fsS 'http://127.0.0.1:9090/api/v1/query?query=up{job=~"ocr-vllm-direct|ocr-autoscaler"}'
curl -fsS 'http://127.0.0.1:9090/api/v1/query?query=xyne_ocr_wrapper_nodes{state="app_healthy"}'
```

Expected:

- autoscaler is up
- two OCR-BBox targets are up
- two wrapper targets are up
- cost metrics exist
- cost values are non-zero only after `ocr-costs.json` has real rates

## Source Files

Main files for this local setup:

```text
deployment/monitoring-vm/docker-compose.gpu-sim.yml
deployment/monitoring-vm/docker-compose.app-sim.yml
deployment/monitoring-vm/docker-compose.yml
deployment/monitoring-vm/prometheus.yml
deployment/monitoring-vm/dashboards/xyne-ocr-observability.json
deployment/monitoring-vm/ocr-costs.json
deployment/monitoring-vm/simulation/
server/scripts/ocrAutoscaler.ts
server/lib/ocrAutoscalerMetrics.ts
server/lib/ocrAutoscalerDiscovery.ts
```
