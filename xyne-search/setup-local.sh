#!/usr/bin/env bash
# Local development setup script for Xyne (v2 stack).
#
# Usage:
#   ./setup-local.sh              # Start infra, bootstrap, migrate, backend + frontend
#   ./setup-local.sh --infra-only # Just start Docker services
#   ./setup-local.sh --backend    # Start backend only (infra must be running)
#   ./setup-local.sh --frontend   # Start frontend only
#   ./setup-local.sh --bootstrap  # Bootstrap Keycloak + run DB migrations
#   ./setup-local.sh --stop       # Stop all Docker services
#   ./setup-local.sh --reset      # Wipe local Docker volumes/data (destructive)
#
set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Paths
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$ROOT_DIR/server"
FRONTEND_DIR="$ROOT_DIR/frontend"
DEPLOYMENT_DIR="$ROOT_DIR/deployment"
COMPOSE_FILE="$DEPLOYMENT_DIR/docker-compose.dev.yml"
ENV_FILE="$SERVER_DIR/.env"

# Defaults
MODE="all"

log() {
  echo -e "${BLUE}[xyne-local]${NC} $1"
}

warn() {
  echo -e "${YELLOW}[xyne-local] WARNING:${NC} $1"
}

error() {
  echo -e "${RED}[xyne-local] ERROR:${NC} $1" >&2
}

success() {
  echo -e "${GREEN}[xyne-local] SUCCESS:${NC} $1"
}

print_help() {
  sed -n '2,12p' "$0"
}

parse_args() {
  if [[ $# -eq 0 ]]; then
    MODE="all"
    return
  fi

  case "$1" in
    --infra-only) MODE="infra" ;;
    --bootstrap) MODE="bootstrap" ;;
    --backend) MODE="backend" ;;
    --frontend) MODE="frontend" ;;
    --stop) MODE="stop" ;;
    --reset) MODE="reset" ;;
    --help|-h) print_help; exit 0 ;;
    *) error "Unknown argument: $1"; print_help; exit 1 ;;
  esac
}

check_prerequisites() {
  log "Checking prerequisites..."

  if ! command -v bun &>/dev/null; then
    error "bun is not installed. Install from https://bun.sh/docs/installation"
    exit 1
  fi

  if ! command -v docker &>/dev/null; then
    error "docker is not installed. Install Docker Desktop or Docker Engine."
    exit 1
  fi

  if ! docker compose version &>/dev/null && ! docker-compose version &>/dev/null; then
    error "docker compose plugin is not installed."
    exit 1
  fi

  success "Prerequisites OK (bun + docker)"
}

compose_cmd() {
  if docker compose version &>/dev/null; then
    docker compose -f "$COMPOSE_FILE" "$@"
  else
    docker-compose -f "$COMPOSE_FILE" "$@"
  fi
}

wait_for_postgres() {
  log "Waiting for Postgres to be healthy..."
  for i in {1..30}; do
    if compose_cmd ps xyne-db | grep -q "healthy"; then
      success "Postgres is healthy"
      return 0
    fi
    sleep 2
  done

  error "Postgres did not become healthy in time. Check 'docker compose -f $COMPOSE_FILE logs xyne-db'"
  exit 1
}

wait_for_keycloak() {
  log "Waiting for Keycloak HTTP to be ready..."
  for i in {1..60}; do
    if curl -fsS "http://localhost:8082/health/ready" &>/dev/null || \
       curl -fsS "http://localhost:8082/" &>/dev/null; then
      success "Keycloak HTTP is ready"
      break
    fi
    sleep 2
  done

  if ! curl -fsS "http://localhost:8082/health/ready" &>/dev/null && \
     ! curl -fsS "http://localhost:8082/" &>/dev/null; then
    error "Keycloak did not become ready in time. Check 'docker compose -f $COMPOSE_FILE logs keycloak'"
    exit 1
  fi

  # On first boot with an empty keycloak DB, Keycloak sometimes starts its HTTP
  # server before running Liquibase migrations. That leaves the DB table-less
  # and the Admin API returns 500. Detect that and restart once so migrations run.
  if ! keycloak_db_has_tables; then
    warn "Keycloak database has no tables yet; restarting Keycloak to run migrations..."
    compose_cmd restart keycloak
    for i in {1..60}; do
      if curl -fsS "http://localhost:8082/health/ready" &>/dev/null || \
         curl -fsS "http://localhost:8082/" &>/dev/null; then
        success "Keycloak HTTP is ready after migration restart"
        break
      fi
      sleep 2
    done
  fi

  log "Waiting for Keycloak Admin API to accept authentication..."
  for i in {1..120}; do
    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" \
      -X POST "http://localhost:8082/realms/master/protocol/openid-connect/token" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      -d "username=${KEYCLOAK_ADMIN:-admin}" \
      -d "password=${KEYCLOAK_ADMIN_PASSWORD:-admin}" \
      -d "grant_type=password" \
      -d "client_id=admin-cli" 2>/dev/null || echo "000")
    # 200 = ready; 401 = admin user exists but wrong creds is also acceptable
    # (means API is up). 400/500 means still initializing.
    if [[ "$status" == "200" || "$status" == "401" ]]; then
      success "Keycloak Admin API is ready (HTTP $status)"
      return 0
    fi
    sleep 2
  done

  error "Keycloak Admin API did not become ready in time. Check 'docker compose -f $COMPOSE_FILE logs keycloak'"
  exit 1
}

start_infra() {
  log "Starting infrastructure services from $COMPOSE_FILE..."
  compose_cmd up -d
  success "Infrastructure services started"

  log "Note: 'xyne-keycloak-db-init' is a one-time init container. It creates the"
  log "      'keycloak' database and then exits. Seeing 'Exited' for it is correct."

  wait_for_postgres
  wait_for_keycloak
}

keycloak_db_has_tables() {
  compose_cmd exec -T xyne-db psql -U xyne -d keycloak -c "\dt" 2>/dev/null | grep -q "offline_user_session"
}

stop_infra() {
  log "Stopping infrastructure services..."
  compose_cmd down
  success "Infrastructure services stopped"
}

reset_data() {
  warn "This will DELETE local Postgres, Vespa, Grafana, and Loki data."
  read -rp "Are you sure? [y/N] " confirm
  confirm="$(echo "$confirm" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
  if [[ "$confirm" != "y" && "$confirm" != "yes" ]]; then
    log "Reset cancelled."
    exit 0
  fi

  stop_infra

  log "Removing local data directories..."
  rm -rf "$SERVER_DIR/xyne-data" \
         "$SERVER_DIR/vespa-data" \
         "$SERVER_DIR/vespa-logs" \
         "$DEPLOYMENT_DIR/grafana/grafana-storage" \
         "$DEPLOYMENT_DIR/loki"

  success "Local data wiped. Run './setup-local.sh' to start fresh."
}

ensure_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    warn "server/.env not found. Copying from .env.default"
    cp "$SERVER_DIR/.env.default" "$ENV_FILE"
    warn "Please review $ENV_FILE and fill in any required secrets (Google OAuth, LLM keys, etc.)"
  fi
}

install_deps() {
  log "Installing server dependencies..."
  (cd "$SERVER_DIR" && bun install)

  log "Installing frontend dependencies..."
  (cd "$FRONTEND_DIR" && bun install)

  success "Dependencies installed"
}

fix_drizzle_config() {
  # The shipped drizzle.config.ts points to ./db/schema.ts, but the actual schema
  # lives at ./platform/db/schema.ts. We create a local config so the setup script
  # can push the schema without editing project files.
  local local_config="$SERVER_DIR/drizzle.config.local.ts"
  cat > "$local_config" <<'EOF'
import config from "@/config"
import { defineConfig } from "drizzle-kit"
export default defineConfig({
  dialect: "postgresql",
  schema: "./platform/db/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: `postgres://xyne:xyne@${config.postgresBaseHost}:5432/xyne`,
  },
})
EOF
  success "Created local drizzle config at $local_config"
}

bootstrap_keycloak() {
  log "Bootstrapping Keycloak realm/client/user..."
  (cd "$SERVER_DIR" && bun run keycloak:bootstrap)
  success "Keycloak bootstrap complete"
}

db_has_public_tables() {
  compose_cmd exec -T xyne-db psql -U xyne -d xyne -c "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' LIMIT 1" 2>/dev/null | grep -q "1"
}

migrations_journal_is_broken() {
  local journal="$SERVER_DIR/migrations/meta/_journal.json"
  [[ ! -f "$journal" ]] && return 1
  # If the journal references any .sql file that does not exist, it's broken.
  local sql_files
  sql_files=$(grep -oE '"tag": "[^"]+"' "$journal" | sed 's/.*"\([^"]*\)".*/\1.sql/' | sort -u)
  for f in $sql_files; do
    if [[ ! -f "$SERVER_DIR/migrations/$f" ]]; then
      return 0
    fi
  done
  return 1
}

clean_migrations() {
  log "Cleaning old/broken drizzle migrations..."
  rm -rf "$SERVER_DIR/migrations"/*
  rm -rf "$SERVER_DIR/migrations/meta"/*
  success "Migrations cleaned"
}

run_migrations() {
  fix_drizzle_config

  # On a fresh DB (or with a broken journal), delete stale migrations so
  # drizzle-kit generate produces a clean initial migration.
  if ! db_has_public_tables || migrations_journal_is_broken; then
    clean_migrations
  fi

  log "Generating drizzle migrations..."
  (cd "$SERVER_DIR" && bunx drizzle-kit generate --config=drizzle.config.local.ts)

  # drizzle-kit generate emits CREATE SCHEMA without IF NOT EXISTS. If the
  # schemas already exist (e.g. from a previous partial setup), migrate fails.
  # Patch the generated SQL to be idempotent.
  find "$SERVER_DIR/migrations" -maxdepth 1 -name "*.sql" -exec sed -i.bak 's/CREATE SCHEMA "\([^"]*\)";/CREATE SCHEMA IF NOT EXISTS "\1";/g' {} +
  rm -f "$SERVER_DIR/migrations"/*.bak

  success "Migrations generated"

  log "Applying drizzle migrations..."
  (cd "$SERVER_DIR" && bunx drizzle-kit migrate --config=drizzle.config.local.ts)
  success "Migrations applied"
}

start_backend() {
  log "Starting backend v2 on http://localhost:3000 ..."
  log "Press Ctrl+C to stop"
  (cd "$SERVER_DIR" && bun run dev:v2)
}

start_frontend() {
  log "Starting frontend dev server..."
  log "Press Ctrl+C to stop"
  (cd "$FRONTEND_DIR" && bun run dev)
}

start_both() {
  # Run backend in background, frontend in foreground so Ctrl+C stops both
  log "Starting backend and frontend in parallel..."
  (cd "$SERVER_DIR" && bun run dev:v2) &
  BACKEND_PID=$!

  cleanup() {
    log "Shutting down backend (pid $BACKEND_PID)..."
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  }
  trap cleanup EXIT INT TERM

  (cd "$FRONTEND_DIR" && bun run dev)
}

main() {
  parse_args "$@"

  case "$MODE" in
    infra)
      check_prerequisites
      ensure_env
      start_infra
      ;;
    stop)
      stop_infra
      ;;
    reset)
      reset_data
      ;;
    bootstrap)
      check_prerequisites
      ensure_env
      wait_for_postgres
      wait_for_keycloak
      run_migrations
      bootstrap_keycloak
      ;;
    backend)
      check_prerequisites
      ensure_env
      start_backend
      ;;
    frontend)
      check_prerequisites
      start_frontend
      ;;
    all)
      check_prerequisites
      ensure_env
      install_deps
      start_infra
      run_migrations
      bootstrap_keycloak
      start_both
      ;;
  esac
}

main "$@"
