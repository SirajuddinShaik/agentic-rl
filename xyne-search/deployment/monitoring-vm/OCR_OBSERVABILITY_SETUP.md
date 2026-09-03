# OCR Observability Setup

This document describes the repo-managed local setup and the live VM setup for
the OCR Grafana/Prometheus observability stack.

The dashboard is GCP-first. Local simulation should mimic GCP scrape behavior by
using autoscaler HTTP service discovery and host-reachable targets instead of
Docker-only service names such as `light-ocr-bbox:8000`.

Current source of truth is the GCP VM `xyne-k8s-test` in project
`xyne-spaces-sbx`, zone `asia-southeast1-a`. Its app/app-sync/result-worker
containers currently call the GCP internal Docling LB at:

```text
http://10.2.0.83
```

Older handoff notes may mention `10.2.0.100`; verify before changing anything,
because the live compose/runtime inspected on `xyne-k8s-test` uses `10.2.0.83`.

## Repo Layout

Relevant files:

- `deployment/monitoring-vm/docker-compose.yml`: Prometheus, Grafana, Loki,
  Alloy, cAdvisor, node-exporter, postgres-exporter, and redis-exporter.
- `deployment/monitoring-vm/docker-compose.gpu-sim.yml`: local OCR fleet
  simulation services: Redis, bbox OCR mocks, wrapper adapters, wrapper LB,
  Docling-server LB, A100 LB, and OCR autoscaler.
- `deployment/monitoring-vm/prometheus.yml`: Prometheus scrape config,
  including autoscaler HTTP SD jobs.
- `deployment/monitoring-vm/dashboards/xyne-ocr-observability.json`: provisioned
  Grafana dashboard.
- `deployment/monitoring-vm/simulation/async_lighton_wrapper.py`: local wrapper
  adapter with `/health`, `/instance_status`, `/process_async`, and `/metrics`.
- `deployment/monitoring-vm/simulation/mock_vllm_bbox.py`: local bbox OCR mock
  with `/health`, `/metrics`, `/v1/models`, and `/v1/chat/completions`.
- `deployment/monitoring-vm/simulation/sim-gcloud.sh`: fake local GCP/MIG and
  backend-service health responses.
- `server/scripts/ocrAutoscaler.ts`: autoscaler process and HTTP SD endpoints.
- `server/lib/ocrAutoscalerMetrics.ts`: autoscaler Prometheus metrics renderer.
- `server/lib/ocrAutoscalerDiscovery.ts`: GCP/backend health and Prometheus
  target discovery helpers.

## Local Setup

Use this setup on a Docker-capable local or GPU VM. It supports two modes:

- `gcp-vm`: default app-sim mode. `DOCLING_SERVICE_URL` points at
  `http://10.2.0.83`, matching `xyne-k8s-test`.
- `local-mock`: override `DOCLING_SERVICE_URL=http://xyne-docling-server-lb:8000`
  so app traffic stays inside the local simulation and fans through the wrapper
  LB and bbox OCR mocks.

Expected local vLLM endpoints from the Prometheus container's point of view:

```text
http://host.docker.internal:8301/metrics
http://host.docker.internal:8302/metrics
```

Expected local wrapper endpoints from the Prometheus container's point of view:

```text
http://host.docker.internal:8201/metrics
http://host.docker.internal:8202/metrics
```

Start the local OCR fleet simulation:

```bash
cd deployment/monitoring-vm
mkdir -p .local-data/{prometheus,grafana,loki,alloy,redis}

docker compose -f docker-compose.gpu-sim.yml up -d
```

Set local or VM cost rates in `deployment/monitoring-vm/ocr-costs.json` before
using the cost panels:

```json
{
  "currency": "USD",
  "a100CostPerHour": 8,
  "wrapperCostPerHour": 0.7907
}
```

The autoscaler exports per-fleet and total hourly cost metrics. Grafana computes
estimated spend for the selected time range from those hourly gauges.

Local autoscaling motion is simulated through:

```bash
OCR_AUTOSCALER_SIM_DEMAND_PAGES=0,125,500,9000,0
OCR_AUTOSCALER_INTERVAL_MS=15000
```

The sequence drives autoscaler desired-node decisions and Redis runtime config
without inserting fake Docling rows. Set `OCR_AUTOSCALER_SIM_DEMAND_PAGES=` to
use only real DB pending/active OCR demand.

For local app traffic through the mock LB, start app-sim with:

```bash
DOCLING_SERVICE_URL=http://xyne-docling-server-lb:8000 \
STATUS_ENDPOINT=http://xyne-docling-server-lb:8000/instance_status \
docker compose -f docker-compose.app-sim.yml up -d
```

Start monitoring:

```bash
XYNE_DOCKER_NETWORK=deployment_xyne \
PROMETHEUS_DATA_DIR="$PWD/.local-data/prometheus" \
GRAFANA_DATA_DIR="$PWD/.local-data/grafana" \
LOKI_DATA_DIR="$PWD/.local-data/loki" \
ALLOY_DATA_DIR="$PWD/.local-data/alloy" \
REDIS_EXPORTER_ADDR=redis://xyne-redis:6379/0 \
CADVISOR_PORT=8083 \
docker compose -f docker-compose.yml up -d
```

Use a different `CADVISOR_PORT` if `8083` is already occupied.

### Local Validation

Check service health:

```bash
curl -fsS http://127.0.0.1:9090/-/ready
curl -fsS http://127.0.0.1:3002/api/health
```

Check autoscaler metrics and HTTP SD:

```bash
curl -fsS http://127.0.0.1:3021/metrics | head
curl -fsS http://127.0.0.1:3021/prometheus/targets/vllm
curl -fsS http://127.0.0.1:3021/prometheus/targets/wrapper
```

Check from inside Prometheus:

```bash
docker exec xyne-prometheus wget -qO- \
  http://xyne-ocr-autoscaler:3021/prometheus/targets/vllm

docker exec xyne-prometheus wget -qO- \
  http://host.docker.internal:8301/metrics | grep 'vllm:num_requests_running'

docker exec xyne-prometheus wget -qO- \
  http://host.docker.internal:8201/metrics | grep lighton_ocr_wrapper
```

Check Prometheus queries:

```bash
curl -fsS 'http://127.0.0.1:9090/api/v1/query?query=xyne_ocr_autoscaler_snapshot_ready'
curl -fsS 'http://127.0.0.1:9090/api/v1/query?query=xyne_ocr_fleet_discovered_targets'
curl -fsS 'http://127.0.0.1:9090/api/v1/query?query=up{job="ocr-vllm-direct"}'
curl -fsS 'http://127.0.0.1:9090/api/v1/query?query=xyne_ocr_wrapper_nodes{state="app_healthy"}'
```

Open Grafana:

```text
http://127.0.0.1:3002/d/xyne-ocr-observability/xyne-ocr-observability
```

Default local credentials are usually:

```text
admin / admin
```

## Live VM Setup

Current live VM access is through Tailscale:

```text
100.111.195.29
```

Before debugging Grafana, confirm Tailscale is running locally:

```bash
tailscale status
tailscale ip -4
route -n get 100.111.195.29
```

The route to `100.111.195.29` should use a Tailscale tunnel interface such as
`utun*`, not the normal LAN gateway.

If Tailscale is installed but not running on macOS:

```bash
open -a Tailscale
```

Live endpoints:

```text
Grafana:    http://100.111.195.29:3002
Prometheus: http://100.111.195.29:9090
Autoscaler: http://100.111.195.29:3021
```

Live runtime directory:

```bash
/home/saket/xyne-observability-sim/monitoring-vm
```

The repo source may also exist on the VM under:

```bash
/home/saket/xyne-latest/deployment/monitoring-vm
```

Treat `/home/saket/xyne-observability-sim/monitoring-vm` as the active runtime
directory for Grafana/Prometheus provisioning.

### VM Health Checks

From your workstation:

```bash
curl -fsS http://100.111.195.29:3002/api/health
curl -fsS http://100.111.195.29:9090/-/ready
ssh saket@100.111.195.29 'docker ps --format "{{.Names}} {{.Status}}"'
```

On the VM:

```bash
cd /home/saket/xyne-observability-sim/monitoring-vm

docker ps --format '{{.Names}} {{.Status}}' | grep -E \
  'xyne-grafana|xyne-prometheus|xyne-ocr-autoscaler|xyne-wrapper-lighton|light-ocr-bbox|lighton-ocr-bbox'
```

Expected core containers:

```text
xyne-grafana
xyne-prometheus
xyne-ocr-autoscaler
light-ocr-bbox
lighton-ocr-bbox
xyne-wrapper-lighton-1
xyne-wrapper-lighton-2
xyne-wrapper-lb
xyne-a100-lb
xyne-docling-server-lb
```

### VM Dashboard Deployment

Back up the active dashboard before replacing it:

```bash
ssh saket@100.111.195.29 '
  cd /home/saket/xyne-observability-sim/monitoring-vm &&
  ts=$(date +%Y%m%d%H%M%S) &&
  cp dashboards/xyne-ocr-observability.json \
     dashboards/xyne-ocr-observability.json.backup-$ts
'
```

Copy the repo-managed dashboard:

```bash
scp deployment/monitoring-vm/dashboards/xyne-ocr-observability.json \
  saket@100.111.195.29:/home/saket/xyne-observability-sim/monitoring-vm/dashboards/xyne-ocr-observability.json
```

Restart Grafana so file provisioning reloads immediately:

```bash
ssh saket@100.111.195.29 'docker restart xyne-grafana'
```

Verify the live dashboard:

```bash
curl -fsS -u "${GRAFANA_USER}:${GRAFANA_PASSWORD}" \
  http://100.111.195.29:3002/api/dashboards/uid/xyne-ocr-observability
```

Useful expected dashboard rows:

- `Autoscaler Freshness`
- `OCR Direct Scrape Coverage`
- `Autoscaler Decision Path`
- `Fleet Scaling`
- `vLLM Runtime`
- `Wrapper Runtime`
- `Pipeline Backlog`

### VM Prometheus Deployment

Back up the active Prometheus config:

```bash
ssh saket@100.111.195.29 '
  cd /home/saket/xyne-observability-sim/monitoring-vm &&
  ts=$(date +%Y%m%d%H%M%S) &&
  cp prometheus.yml prometheus.yml.backup-$ts
'
```

Copy the repo-managed Prometheus config:

```bash
scp deployment/monitoring-vm/prometheus.yml \
  saket@100.111.195.29:/home/saket/xyne-observability-sim/monitoring-vm/prometheus.yml
```

Prefer lifecycle reload:

```bash
ssh saket@100.111.195.29 \
  'curl -fsS -X POST http://127.0.0.1:9090/-/reload'
```

Restart Prometheus only if reload is unavailable or the container does not have
the updated mounted config:

```bash
ssh saket@100.111.195.29 'docker restart xyne-prometheus'
```

### VM Autoscaler And Wrapper Validation

Autoscaler HTTP SD endpoints:

```bash
curl -fsS http://100.111.195.29:3021/prometheus/targets/vllm
curl -fsS http://100.111.195.29:3021/prometheus/targets/wrapper
```

Expected local-simulation targets on `100.111.195.29`:

```text
host.docker.internal:8301
host.docker.internal:8302
host.docker.internal:8201
host.docker.internal:8202
```

Prometheus direct scrape coverage:

```bash
curl -fsS \
  'http://100.111.195.29:9090/api/v1/query?query=label_replace(xyne_ocr_wrapper_nodes{state="app_healthy"},"fleet","wrapper","state",".*") or label_replace(xyne_ocr_a100_nodes{state="healthy"},"fleet","a100","state",".*")'
```

Expected healthy local-simulation values:

```text
a100    2
wrapper 2
```

Wrapper fleet metrics:

```bash
curl -fsS \
  'http://100.111.195.29:9090/api/v1/query?query=xyne_ocr_wrapper_nodes'
```

vLLM metrics:

```bash
curl -fsS \
  'http://100.111.195.29:9090/api/v1/query?query=vllm:num_requests_running{job="ocr-vllm-direct"}'
```

Autoscaler freshness:

```bash
curl -fsS \
  'http://100.111.195.29:9090/api/v1/query?query=xyne_ocr_autoscaler_snapshot_ready'

curl -fsS \
  'http://100.111.195.29:9090/api/v1/query?query=time() - xyne_ocr_autoscaler_last_success_timestamp_seconds'
```

Good values:

- `xyne_ocr_autoscaler_snapshot_ready = 1`: usable.
- snapshot age `< 60s`: healthy.
- snapshot age `> 90s`: stale.
- snapshot age `> 180s`: bad.

## GCP Production Shape

In GCP, the same Prometheus jobs should be used, but the autoscaler should emit
private-IP scrape targets instead of `host.docker.internal`.

Autoscaler settings:

```text
OCR_AUTOSCALER_GCP_ACTUATOR=metadata
OCR_AUTOSCALER_A100_DISCOVERY=mig
GCP_PROJECT=xyne-spaces-sbx
GCP_ZONE=asia-southeast1-a
OCR_AUTOSCALER_WRAPPER_MIG=lighton-ocr-wrapper-fleet-mig
OCR_AUTOSCALER_A100_MIG=lightonocr-fleet-mig
OCR_AUTOSCALER_WRAPPER_BACKEND_SERVICE=lighton-ocr-wrapper-fleet-backend
OCR_AUTOSCALER_WRAPPER_BACKEND_SERVICE_REGION=asia-southeast1
OCR_AUTOSCALER_A100_METRICS_PORT=8000
OCR_AUTOSCALER_A100_METRICS_PATH=/metrics
```

App/app-sync/result-worker settings matching `xyne-k8s-test`:

```text
DOCLING_SERVICE_URL=http://10.2.0.83
DOCLING_ASYNC_SUBMIT_PERMITS=240
DOCLING_ACTIVE_FILE_LIMIT=160
DOCLING_RUNTIME_CONFIG_POLL_MS=30000
DOCLING_ASYNC_PART_SUBMIT_CONCURRENCY=1
PGBOSS_POOL_MAX=20
```

Prometheus should not depend on Docker DNS for direct vLLM or wrapper scrapes.
It should consume:

```text
http://xyne-ocr-autoscaler:3021/prometheus/targets/vllm
http://xyne-ocr-autoscaler:3021/prometheus/targets/wrapper
```

Direct GCP reachability checks from the monitoring/control VM:

```bash
curl -fsS http://<a100-private-ip>:8000/metrics
curl -fsS http://<wrapper-private-ip>:8000/health
curl -fsS http://<wrapper-private-ip>:8000/instance_status
```

Local mock validation:

```bash
docker ps --format '{{.Names}} {{.Status}}' | grep -E \
  'xyne-docling-server-lb|xyne-a100-lb|xyne-wrapper-lb|light-ocr-bbox|lighton-ocr-bbox'
curl -fsS http://127.0.0.1:8100/health
curl -fsS http://127.0.0.1:8200/health
curl -fsS http://127.0.0.1:3021/prometheus/targets/vllm
curl -fsS http://127.0.0.1:3021/prometheus/targets/wrapper
docker inspect xyne-app-sync --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | sort | grep -Ei 'DOCLING_SERVICE_URL|DOCLING_ASYNC_SUBMIT_PERMITS|DOCLING_ACTIVE_FILE_LIMIT|DOCLING_PAGE_CHUNK_SIZE|PGBOSS_POOL_MAX|REDIS_URL'
```

## Dashboard Semantics

Primary rows:

- `Autoscaler Freshness`: tells whether the autoscaler snapshot is usable and
  fresh.
- `OCR Direct Scrape Coverage`: compares discovered targets with actually
  scrapeable targets.
- `Autoscaler Decision Path`: explains raw vs effective admission and submit
  permit decisions.
- `Fleet Scaling`: compares live/current node or submitter counts with desired
  counts.
- `vLLM Runtime`: shows direct vLLM running requests, queue pressure, KV cache,
  and latency.
- `Wrapper Runtime`: shows wrapper active jobs, available slots, and max inflight
  capacity.
- `Pipeline Backlog`: shows stuck or unfinished pipeline work.

Diagnostic rows:

- `Wrapper Health Diagnostics`
- `DB Status Snapshots`
- `Runtime Config`
- `Redis Control Plane`
- `Vespa / Writer`
- `Infrastructure Diagnostics`
- `Diagnostic Logs`

## Common Failure Modes

### Grafana, Prometheus, And SSH All Timeout

Likely local Tailscale is not running or the route is wrong.

Check:

```bash
tailscale status
route -n get 100.111.195.29
```

If traffic routes through the normal LAN gateway, start Tailscale:

```bash
open -a Tailscale
```

### Grafana Loads Old Panels

The live dashboard file was not updated or Grafana has not reloaded provisioning.

Check:

```bash
curl -fsS -u "${GRAFANA_USER}:${GRAFANA_PASSWORD}" \
  http://100.111.195.29:3002/api/dashboards/uid/xyne-ocr-observability
```

Then copy the dashboard JSON and restart Grafana.

### Direct Scrape Panels Are Empty

Check autoscaler HTTP SD first:

```bash
curl -fsS http://100.111.195.29:3021/prometheus/targets/vllm
curl -fsS http://100.111.195.29:3021/prometheus/targets/wrapper
```

Then check Prometheus target health:

```bash
curl -fsS \
  'http://100.111.195.29:9090/api/v1/query?query=up{job="ocr-vllm-direct"}'
```

If HTTP SD returns A100 targets but `up` is `0`, Prometheus cannot reach the
target from inside its container or from the monitoring VM. Wrapper health is
reported through autoscaler metrics, not direct wrapper `/metrics` scrapes.

### Autoscaler Restarts With Lock Error

After container recreation, Redis may briefly retain the old autoscaler lock:

```text
Another OCR autoscaler owns docling:ocr-autoscaler:lock
```

Usually wait for the lock TTL to expire. Only clear the lock manually after
confirming there is exactly one autoscaler container.
