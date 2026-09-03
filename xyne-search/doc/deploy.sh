#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# xyne v2 — VM-side deploy script (runs ON the prod VM, not locally).
# Builds the app image from an scp'd source tar, preflights it, promotes it to
# xyne-v2:latest, recreates ONLY the `app` service, health-gates, and
# auto-rolls-back if the new container never goes healthy.
#
# Prereq: /tmp/xyne-v2-src.tar.gz has been scp'd to the VM (see doc/deployment.md).
# Usage (on VM):  nohup bash /tmp/deploy.sh >/tmp/deploy-v2-latest.log 2>&1 &
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

TS=$(date +%Y%m%dT%H%M%SZ)
STACK=/home/shivral_somani_juspay_in/xyne-stack
COMPOSE=docker-compose.gpu.yml          # app service uses image: xyne-v2:latest
SRC=/tmp/xyne-v2-src.tar.gz
BUILD=/tmp/xyne-v2-build
CAND="xyne-v2:candidate-$TS"
ROLLBACK="xyne-v2:pre-deploy-$TS"

echo "[deploy $TS] start"

# 1. Snapshot the current prod image for rollback.
if sudo docker image inspect xyne-v2:latest >/dev/null 2>&1; then
  sudo docker tag xyne-v2:latest "$ROLLBACK"
  echo "[deploy] rollback snapshot -> $ROLLBACK"
fi

# 2. Fresh build context from the tar (leftover dir may be root-owned -> sudo rm).
sudo rm -rf "$BUILD"; mkdir -p "$BUILD"
tar -xzf "$SRC" -C "$BUILD"
echo "[deploy] extracted $(du -sh "$BUILD" | cut -f1) -> $BUILD"

# 3. Build the candidate (renamed: -f Dockerfile, was Dockerfile.v2). Slow (minutes).
echo "[deploy] building $CAND ..."
if ! sudo docker build -f "$BUILD/Dockerfile" -t "$CAND" "$BUILD"; then
  echo "[deploy] BUILD FAILED — prod untouched"; exit 1
fi

# 4. PREFLIGHT: a clean image still hides a missing relative-import; only RUNNING
#    catches it. Boot entry is app/server.ts (renamed from backendv2/server.ts).
echo "[deploy] preflight run-check ..."
MISS=$(sudo docker run --rm --entrypoint sh "$CAND" \
  -c "cd /usr/src/app/server && timeout 25 bun app/server.ts 2>&1 | head -60" \
  | grep -c "Cannot find module")
if [ "$MISS" != "0" ]; then
  echo "[deploy] PREFLIGHT FAILED — $MISS 'Cannot find module' — prod untouched"; exit 1
fi
echo "[deploy] preflight clean (0 missing modules)"

# 5. Promote + recreate ONLY the app (no --remove-orphans; leaves scheduler/sync alone).
sudo docker tag "$CAND" xyne-v2:latest
cd "$STACK"
sudo docker compose -f "$COMPOSE" up -d --force-recreate --no-deps app

# 6. Health gate (up to ~2 min) with auto-rollback.
ok=0
for _ in $(seq 1 30); do
  sleep 4
  if curl -sf --max-time 5 localhost:3000/v2/health 2>/dev/null | grep -q '"ok":true'; then ok=1; break; fi
done
if [ "$ok" = "1" ]; then
  echo "[deploy $TS] SUCCESS — healthy. rollback image kept: $ROLLBACK"
  curl -s localhost:3000/v2/health; echo
else
  echo "[deploy $TS] UNHEALTHY — auto-rolling back to $ROLLBACK"
  sudo docker tag "$ROLLBACK" xyne-v2:latest
  sudo docker compose -f "$COMPOSE" up -d --force-recreate --no-deps app
  sleep 8; curl -s localhost:3000/v2/health || true; echo
  echo "[deploy $TS] ROLLED BACK"; exit 1
fi
