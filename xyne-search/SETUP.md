# Xyne — Local Development Setup Guide

This guide walks you through running Xyne-Search on your laptop for local development. Everything runs on your machine: the frontend, backend, database, search engine, and auth service.

---

## What you'll run

| Service | Technology | Local URL |
|---------|------------|-----------|
| Frontend | Vite + React | http://localhost:5176 |
| Backend v2 | Bun + Hono | http://localhost:3000 |
| Database | Postgres 15 | localhost:5432 |
| Search engine | Vespa | http://localhost:8080 / 8081 |
| Auth | Keycloak | http://localhost:8082 |
| Real-time | LiveKit | ws://localhost:7880 |
| Monitoring | Prometheus + Grafana | http://localhost:9090 / http://localhost:3002 |

---

## Before you run anything

`setup-local.sh` installs project dependencies and starts infrastructure, but it **does not install Docker, Bun, or the Vespa CLI**. Make sure these are on your machine first.

### Install these first

| # | Tool | Download / Install | Verify |
|---|------|--------------------|--------|
| 1 | **Docker Desktop** | https://www.docker.com/products/docker-desktop | `docker --version` |
| 2 | **Docker Compose** | Included with Docker Desktop | `docker compose version` |
| 3 | **Bun** | `curl -fsSL https://bun.sh/install \| bash` | `bun --version` |
| 4 | **Vespa CLI** *(optional)* | `brew install vespa-cli` | `vespa version` |

### Important: give Docker enough memory

**Vespa needs at least 20 GB of memory** allocated to Docker. If you skip this, Vespa will probably crash or fail to start.

1. Open **Docker Desktop**.
2. Go to **Settings → Resources → Memory**.
3. Set it to **20 GB** (or more).
4. Click **Apply & Restart**.

### Quick verification

Run all of these in your terminal. If any command fails or returns nothing, install that tool before continuing.

```bash
docker --version          # should print a version
docker compose version    # should print a version
bun --version             # should print a version
vespa version             # optional, only needed for schema work
```

---

## Quick start (recommended)

We have a helper script that does almost everything:

```bash
# 1. Clone the repo (if you haven't already)
git clone <repo-url>
cd xyne-search

# 2. Make sure the script is executable
chmod +x setup-local.sh

# 3. Update the LiteLLM config path in server/.env
#    Replace '/Users/saransh.sethi/Downloads/xyne-search' with the path where YOU cloned the repo.
#    Example: /home/<your-username>/projects/xyne-search
sed -i '' "s|/Users/saransh.sethi/Downloads/xyne-search|<your-repo-path>|g" server/.env

# 4. Run everything
./setup-local.sh
```

The script will:

1. Install Bun dependencies for `server/` and `frontend/`
2. Start Docker infrastructure (Postgres, Vespa, Keycloak, LiveKit, Prometheus, Grafana, Loki)
3. Generate and apply database migrations
4. Bootstrap Keycloak (create realm, client, admin user)
5. Start the backend and frontend dev servers

When you see:

```
VITE v5.4.x  ready in ...
➜  Local:   http://localhost:5176/
Started development server: http://localhost:3000
```

everything is ready.

---

## First login

Open http://localhost:5176 and sign in with Keycloak:

- **Email**: `admin@xyne.local`
- **Password**: `admin`

If that password doesn't work, try `admin123` (depending on the `.env` value of `XYNE_BOOTSTRAP_ADMIN_PASSWORD`).

---

## Understanding the setup script

```bash
./setup-local.sh              # Full setup: infra + migrations + bootstrap + apps
./setup-local.sh --infra-only # Only start Docker containers
./setup-local.sh --bootstrap  # Only run DB migrations + Keycloak bootstrap
./setup-local.sh --backend    # Only start backend
./setup-local.sh --frontend   # Only start frontend
./setup-local.sh --stop       # Stop all Docker containers
./setup-local.sh --reset      # Wipe local data (Postgres + Vespa + logs)
```

---

## Important: `xyne-keycloak-db-init` shows "Exited"

This is **normal and expected**. `xyne-keycloak-db-init` is a one-time initialization container. Its only job is:

```sql
CREATE DATABASE keycloak;
```

Once it creates the Keycloak database, it exits. It is **not supposed to stay running**. You will always see it as `Exited` in `docker ps`.

The long-running services should all show `Up`:

```bash
docker compose -f deployment/docker-compose.dev.yml ps
```

---

## Environment configuration

The setup script reads `server/.env`. A local-ready version is already included in the repo, but make sure these point to local Docker:

```bash
DATABASE_HOST=localhost
DATABASE_URL=postgresql://xyne:xyne@localhost:5432/xyne

VESPA_HOST=localhost
VESPA_FEED_PORT=8080
VESPA_QUERY_PORT=8081

KEYCLOAK_WEB_ENABLED=true
KEYCLOAK_PUBLIC_BASE_URL=http://localhost:8082
KEYCLOAK_INTERNAL_BASE_URL=http://localhost:8082
```

### Important: update `LITELLM_MODEL_CONFIG_PATH`

The shipped `server/.env` contains a hardcoded absolute path:

```bash
LITELLM_MODEL_CONFIG_PATH=/Users/saransh.sethi/Downloads/xyne-search/server/litellm-models.json
```

Change this to **your own clone path**, or model selection in the UI will break:

```bash
# On macOS
sed -i '' "s|/Users/saransh.sethi/Downloads/xyne-search|<your-repo-path>|g" server/.env

# On Linux
sed -i "s|/Users/saransh.sethi/Downloads/xyne-search|<your-repo-path>|g" server/.env
```

If you ever change encryption-related secrets (`ENCRYPTION_KEY`, `SERVICE_ACCOUNT_ENCRYPTION_KEY`, `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`) **after** data has been created, the old encrypted data becomes unreadable. In that case, wipe data and start fresh:

```bash
./setup-local.sh --stop
rm -rf server/xyne-data server/vespa-data server/vespa-logs
./setup-local.sh
```

---

## Manual setup (if you prefer not to use the script)

```bash
# 1. Install dependencies
cd server && bun install
cd ../frontend && bun install

# 2. Start infrastructure
cd ..
docker compose -f deployment/docker-compose.dev.yml up -d

# 3. Wait for Postgres and Keycloak
docker exec xyne-db pg_isready -U xyne -d xyne
curl -fsS http://localhost:8082/health/ready

# 4. Apply DB migrations
cd server
bunx drizzle-kit generate --config=drizzle.config.local.ts
bunx drizzle-kit migrate --config=drizzle.config.local.ts

# 5. Bootstrap Keycloak
bun run keycloak:bootstrap

# 6. Start backend (terminal 1)
bun run dev:v2

# 7. Start frontend (terminal 2)
cd ../frontend
bun run dev
```

---

## Health checks

```bash
# Backend
curl -fsS http://localhost:3000/v2/health

# Vespa config server
curl -fsS http://localhost:19071/state/v1/health

# Vespa query
curl -fsS http://localhost:8081/status.html >/dev/null

# Keycloak
curl -fsS http://localhost:8082/health/ready

# Prometheus
curl -fsS http://localhost:9090/-/healthy
```

---

## File processing and OCR (optional)

Uploaded files are processed by a separate **sync server** (`server/sync-server.ts`) that consumes jobs from a `pg-boss` queue. The main setup script starts the backend and frontend, but **does not start the sync server**. If KB uploads stay stuck in `PROCESSING`, start it manually:

```bash
cd server
bun run dev:sync-unsafe
```

### Default PDF extraction

By default, PDFs are processed with `pdfjs-dist`. No extra OCR service is needed, so the quick-start flow above is enough for most local development.

### Real OCR with LightOn (optional)

For scanned or image-heavy PDFs, enable **LightOn OCR**:

1. **Start Redis**

   ```bash
   docker run -d --name xyne-redis -p 6379:6379 redis:7-alpine
   ```

2. **Start the LightOn OCR service**

   ```bash
   cd lighton-ocr-server
   docker build -t xyne-lighton-ocr .
   docker run -d --name xyne-lighton-ocr \
     -p 8002:8000 \
     -e REDIS_URL=redis://host.docker.internal:6379/0 \
     -e LIGHTON_URL=<your-model-endpoint> \
     xyne-lighton-ocr
   ```

3. **Update `server/.env`**

   ```bash
   DOCLING_SERVICE_URL=http://localhost:8002
   REDIS_URL=redis://localhost:6379/0
   DOCLING_ASYNC_SCHEDULER_ENABLED=true
   ```

4. **Start the sync server and Docling workers**

   ```bash
   cd server
   bun run dev:sync-unsafe
   DOCLING_SCHEDULER_ROLE=splitter bun run dev:docling-scheduler
   DOCLING_SCHEDULER_ROLE=submitter bun run dev:docling-scheduler
   DOCLING_SCHEDULER_ROLE=writer bun run dev:docling-scheduler
   DOCLING_SCHEDULER_ROLE=reaper bun run dev:docling-scheduler
   bun run dev:docling-results
   ```

---
            ## File processing and OCR (optional)

Uploaded files are processed by a separate **sync server** (`server/sync-server.ts`) that consumes jobs from a `pg-boss` queue. The main setup script starts the backend and frontend, but **does not start the sync server**. If KB uploads stay stuck in `PROCESSING`, start it manually:

```bash
cd server
bun run dev:sync-unsafe
```

### Default PDF extraction

By default, PDFs are processed with `pdfjs-dist`. No extra OCR service is needed, so the quick-start flow above is enough for most local development.

### Real OCR with LightOn (optional)

For scanned or image-heavy PDFs, enable **LightOn OCR**:

1. **Start Redis**

```bash
docker run -d --name xyne-redis -p 6379:6379 redis:7-alpine
```

2. **Start the LightOn OCR service**

```bash
cd lighton-ocr-server

docker build -t xyne-lighton-ocr .

docker run -d --name xyne-lighton-ocr \
  -p 8002:8000 \
  -e REDIS_URL=redis://host.docker.internal:6379/0 \
  -e LIGHTON_URL=<your-model-endpoint> \
  xyne-lighton-ocr
```

3. **Update `server/.env`**

```bash
DOCLING_SERVICE_URL=http://localhost:8002
REDIS_URL=redis://localhost:6379/0
DOCLING_ASYNC_SCHEDULER_ENABLED=true
```

4. **Start the sync server and Docling workers**

```bash
cd server

bun run dev:sync-unsafe

DOCLING_SCHEDULER_ROLE=splitter bun run dev:docling-scheduler
DOCLING_SCHEDULER_ROLE=submitter bun run dev:docling-scheduler
DOCLING_SCHEDULER_ROLE=writer bun run dev:docling-scheduler
DOCLING_SCHEDULER_ROLE=reaper bun run dev:docling-scheduler

bun run dev:docling-results
```

## Common issues

### 1. Keycloak returns 500 / "schema ... does not exist"

On first boot, Keycloak sometimes starts its HTTP server before finishing its own database migrations. The setup script detects this and restarts Keycloak automatically.

If you're running manually:

```bash
docker compose -f deployment/docker-compose.dev.yml restart keycloak
```

Then retry bootstrap:

```bash
cd server
bun run keycloak:bootstrap
```

### 2. `relation "workflow.workflows" does not exist`

This means the `workflow` Postgres schema wasn't created. Use the setup script — it generates and applies migrations properly. If doing it manually, make sure your generated migration creates the `workflow` schema.

### 3. `Unsupported state or unable to authenticate data`

The encryption keys in `server/.env` don't match the data in the database. Wipe data and start fresh:

```bash
./setup-local.sh --stop
rm -rf server/xyne-data server/vespa-data server/vespa-logs
./setup-local.sh
```

### 4. Prometheus keeps crashing

If you see `prometheus: error: unexpected sh`, the Prometheus command is being parsed by the Prometheus binary instead of the shell. The fix is already in `deployment/docker-compose.dev.yml`:

```yaml
entrypoint: ["/bin/sh", "-c"]
```

If you still see this, make sure you have the latest version of the compose file.

### 5. Backend can't connect to Postgres/Vespa

Make sure your `server/.env` uses `localhost`, not Docker service names like `xyne-db` or `vespa`:

```bash
DATABASE_URL=postgresql://xyne:xyne@localhost:5432/xyne
VESPA_HOST=localhost
```

Docker service names only work **inside** containers, not when running Bun/Vite directly on your laptop.

### 6. Out of memory / Vespa crashes

Vespa is heavy. Allocate at least **20 GB** to Docker Desktop:

- Docker Desktop → Settings → Resources → Memory → 20 GB

---

## Stopping everything

To stop the backend/frontend dev servers, press `Ctrl+C` in their terminals.

To stop Docker infrastructure:

```bash
./setup-local.sh --stop
```

To completely remove local data and start fresh:

```bash
./setup-local.sh --stop
rm -rf server/xyne-data server/vespa-data server/vespa-logs
./setup-local.sh
```

---

## LLM configuration (optional)

Chat features need a language model. Add one of these to `server/.env`:

### OpenAI

```bash
OPENAI_API_KEY=sk-...
```

### LiteLLM proxy

```bash
LITELLM_BASE_URL=https://your-litellm-proxy.com/
LITELLM_API_KEY=...
LITELLM_MODEL_CONFIG_PATH=/Users/<you>/Downloads/xyne-search/server/litellm-models.json
LITELLM_BEST_MODEL=nemotron
LITELLM_FAST_MODEL=nemotron
```

Then restart the backend.

---

## Next steps

- Open http://localhost:5176 and sign in.
- Connect a data source (Google Workspace, Slack, etc.) via the Settings page.
- Upload files to Knowledge Base and search across them.

For deployment or advanced configuration, see `doc/deployment.md`.
