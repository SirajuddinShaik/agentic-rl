# Xyne VM Monitoring

Repo-managed monitoring for the single-VM Docker Compose deployment.

This stack deploys Prometheus, Grafana, Loki, Grafana Alloy, cAdvisor, node-exporter, postgres-exporter, and redis-exporter. It does not start, stop, rebuild, or restart the app, scheduler, autoscaler, Redis, Postgres, or Vespa containers.

## Layout

- `docker-compose.yml`: monitoring-only services.
- `prometheus.yml`: scrape config. Autoscaler scrapes run every 30 seconds.
- `alloy.alloy`: Docker log collection to Loki with bounded labels.
- `loki.yml`: local filesystem Loki config.
- `grafana/provisioning`: Grafana datasources and dashboard provider.
- `dashboards`: provisioned dashboards.

## Deploy Locally On The VM

From this directory:

```bash
cp .env.example .env
sudo mkdir -p /opt/monitoring/{prometheus,grafana,loki,alloy}
sudo docker compose --env-file .env up -d
```

If an older ad hoc monitoring stack is already running, stop only those monitoring containers first. Do not stop app, scheduler, autoscaler, Redis, Postgres, or Vespa containers. In particular, avoid leaving both `cadvisor-new` and this stack's `cadvisor` running at the same time.

If the app Docker network has a different name, set `XYNE_DOCKER_NETWORK` in `.env` before running Compose:

```bash
sudo docker network ls
```

## Local Workstation Smoke Test

When the app stack is already running locally, point the monitoring stack at that Docker network and keep data under this directory:

```bash
mkdir -p .local-data/{prometheus,grafana,loki,alloy}
XYNE_DOCKER_NETWORK=deployment_xyne \
PROMETHEUS_DATA_DIR="$PWD/.local-data/prometheus" \
GRAFANA_DATA_DIR="$PWD/.local-data/grafana" \
LOKI_DATA_DIR="$PWD/.local-data/loki" \
ALLOY_DATA_DIR="$PWD/.local-data/alloy" \
CADVISOR_PORT=8083 \
docker compose up -d
```

Use a different `CADVISOR_PORT` if `8083` is already occupied. The local data directory and `.env` are intentionally ignored by git.

## GPU VM Fleet Simulation

Use `docker-compose.gpu-sim.yml` on a Docker-capable local machine or GPU VM that already has the Xyne Docker network. The overlay starts:

- Redis as `xyne-redis`
- an A100 LB as `xyne-a100-lb`
- two bbox OCR mocks as `light-ocr-bbox` and `lighton-ocr-bbox`
- two local LightOn async wrapper adapters as `xyne-wrapper-lighton-1` and `xyne-wrapper-lighton-2`
- a wrapper LB as `xyne-wrapper-lb`
- a local Docling-server LB as `xyne-docling-server-lb`
- the OCR autoscaler as `xyne-ocr-autoscaler`

The autoscaler uses fake local MIG/backend health through `simulation/sim-gcloud.sh`, but emits Prometheus HTTP SD targets that mimic GCP private-IP scraping. Locally those targets are host-reachable ports:

```text
http://host.docker.internal:8301/metrics
http://host.docker.internal:8302/metrics
http://host.docker.internal:8201/metrics
http://host.docker.internal:8202/metrics
```

Cost panels read the per-node hourly rates from `ocr-costs.json` mounted into
the autoscaler at `/etc/xyne/ocr-costs.json`:

```json
{
  "currency": "USD",
  "a100CostPerHour": 8,
  "wrapperCostPerHour": 0.7907
}
```

Set those two rates to the real OCR machine and OCR server-wrapper hourly cost.
The current VM values are `$8/hr` per A100 OCR machine and `$0.7907/hr` per OCR
server-wrapper machine.
The dashboard integrates `xyne_ocr_estimated_cost_per_hour` over the selected
Grafana time range.

For local autoscaling demos, `docker-compose.gpu-sim.yml` enables a simulated
OCR demand sequence by default:

```bash
OCR_AUTOSCALER_SIM_DEMAND_PAGES=0,125,500,9000,0
OCR_AUTOSCALER_INTERVAL_MS=15000
```

This changes autoscaler decisions and Redis runtime config without creating
fake database rows. Disable it with `OCR_AUTOSCALER_SIM_DEMAND_PAGES=`.

The app simulation defaults to the current `xyne-k8s-test` GCP internal Docling LB:

```text
DOCLING_SERVICE_URL=http://10.2.0.83
```

For pure local mock mode, override:

```bash
DOCLING_SERVICE_URL=http://xyne-docling-server-lb:8000 \
STATUS_ENDPOINT=http://xyne-docling-server-lb:8000/instance_status \
docker compose -f docker-compose.app-sim.yml up -d
```

From this directory on the VM:

```bash
mkdir -p .local-data/{prometheus,grafana,loki,alloy,redis}
docker compose -f docker-compose.gpu-sim.yml up -d
XYNE_DOCKER_NETWORK=deployment_xyne \
PROMETHEUS_DATA_DIR="$PWD/.local-data/prometheus" \
GRAFANA_DATA_DIR="$PWD/.local-data/grafana" \
LOKI_DATA_DIR="$PWD/.local-data/loki" \
ALLOY_DATA_DIR="$PWD/.local-data/alloy" \
REDIS_EXPORTER_ADDR=redis://xyne-redis:6379/0 \
CADVISOR_PORT=8083 \
docker compose -f docker-compose.yml up -d
```

Smoke submit through the wrapper LB:

```bash
printf '%s\n' '%PDF-1.4 simulated' >/tmp/xyne-sim.pdf
curl -fsS -F file=@/tmp/xyne-sim.pdf \
  -F job_id=docling:sim:part:0:attempt:1 \
  -F file_id=sim-file \
  -F doc_id=sim-doc \
  -F vespa_doc_id=sim-vespa \
  http://localhost:8200/process_async
docker exec xyne-redis redis-cli XLEN docling:results
```

## Endpoints

- Grafana: `http://<vm>:3002`
- Prometheus: `http://<vm>:9090`
- Loki: `http://<vm>:3100`
- Alloy UI: `http://<vm>:12345`

## Autoscaler Metrics

The `xyne-ocr-autoscaler` container must expose:

```bash
OCR_AUTOSCALER_METRICS_ENABLED=true
OCR_AUTOSCALER_METRICS_PORT=3021
```

Prometheus scrapes `xyne-ocr-autoscaler:3021/metrics` on the Docker network.

## Exporter Credentials

The default Postgres exporter credentials match the local demo defaults. For production-like validation, create and use a read-only Postgres user and set:

```bash
POSTGRES_EXPORTER_USER=<readonly_user>
POSTGRES_EXPORTER_PASSWORD=<readonly_password>
```

The Redis exporter defaults to `redis://redis:6379/0` inside the Docker network.

## Validation

```bash
sudo docker compose --env-file .env ps
curl -fsS http://localhost:9090/-/ready
curl -fsS http://localhost:3100/ready
curl -fsS http://localhost:12345/-/ready
sudo docker exec xyne-prometheus wget -qO- http://xyne-ocr-autoscaler:3021/metrics | head
```

In Prometheus, check `Status > Targets` and confirm all configured targets are `UP`.

In Grafana, open the `Xyne OCR Observability` dashboard. State panels should use Prometheus metrics; Loki panels are diagnostic log searches only.

## Log Labels

Alloy forwards Docker logs to Loki with bounded labels only:

- `host`
- `service`
- `role`
- `container_name`
- `stream`

Primary OCR state should come from `/metrics`, Postgres, Redis, GCP health, cAdvisor, and node-exporter metrics. Loki is for diagnosis and high-cardinality investigation, not primary state.
