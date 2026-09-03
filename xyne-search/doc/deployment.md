# Deploying the xyne v2 stack to prod

How to ship the **v2 stack** (`frontend/` + `server/` backendv2) to the production
VM. None of this is in the app's runtime config — it's out-of-band ops, written
here so any agent/engineer can run a deploy safely.

> TL;DR: build a lean source tar locally → `scp` it + `doc/deploy.sh` to the VM →
> run the script. It snapshots the current image for rollback, builds a
> **candidate**, **preflights** it (catches missing imports a clean build won't),
> promotes it to `xyne-v2:latest`, recreates **only** the `app` service, and
> **auto-rolls-back** if it never goes healthy. The build happens **on the VM**.

---

## Prerequisites

- **juspay VPN** connected (Bitbucket + the IAP tunnel need it; off-VPN, DNS
  resolves but SSH/:22 is filtered).
- **gcloud** authenticated (`gcloud auth list` shows your `@juspay.in` account)
  with IAP access to the project.

## Production coordinates

| What | Value |
|---|---|
| VM | `xyne-k8s-test` (single VM; "k8s" is a misnomer) |
| gcloud | `--zone=asia-southeast1-a --project=xyne-spaces-sbx --tunnel-through-iap` |
| Stack dir | `/home/shivral_somani_juspay_in/xyne-stack` |
| Compose file | `docker-compose.gpu.yml` (the `app` service uses `image: xyne-v2:latest`, **not** a `build:` block) |
| App image | `xyne-v2:latest` · rollbacks tagged `xyne-v2:pre-deploy-<TS>` |
| Containers | `xyne-app` (port 3000), `xyne-db` (postgres) |
| Health | `GET localhost:3000/v2/health` → `{"ok":true,"service":"backendv2"}` |
| Boot entry | `app/server.ts` (run via `start.sh`) |

> **Post-restructure renames (chore/restructure-server):** the build files are
> now `Dockerfile` (was `Dockerfile.v2`), `start.sh` (was `start-v2.sh`),
> `frontend/` (was `ui2/`), and the entrypoint is `app/server.ts` (was
> `backendv2/server.ts`). `doc/deploy.sh` already uses the new names.

## Keycloak demo setup

The demo deployment exposes Keycloak through the edge proxy at the same public
origin as Xyne, under `/keycloak`. Do not use a separate public `:8082` URL for
the demo unless the firewall, Keycloak issuer, and redirect URIs are
intentionally changed together.

Set these on the VM stack `.env` before bootstrapping:

```bash
KEYCLOAK_WEB_ENABLED=true
HOST=https://<demo-origin>
KEYCLOAK_PUBLIC_BASE_URL=https://<demo-origin>/keycloak
KEYCLOAK_INTERNAL_BASE_URL=http://keycloak:8080/keycloak
KEYCLOAK_REALM=xyne-shared
KEYCLOAK_CLIENT_ID=xyne-web
KEYCLOAK_CLIENT_SECRET=<generated-secret>
KEYCLOAK_WORKSPACE_CLAIM=xyne_workspace_external_id
KEYCLOAK_WORKSPACE_EXTERNAL_ID=g0xufd0v4fcvjqa02x4uror1
KEYCLOAK_LOGOUT_REDIRECT_URL=/auth
KEYCLOAK_ADMIN=admin
KEYCLOAK_ADMIN_PASSWORD=<strong-admin-password>
XYNE_BOOTSTRAP_ADMIN_EMAIL=<admin-email>
XYNE_BOOTSTRAP_ADMIN_PASSWORD=<strong-user-password>
XYNE_BOOTSTRAP_WORKSPACE_NAME="Juspay.in"
XYNE_BOOTSTRAP_WORKSPACE_DOMAIN=juspay.in
KC_DB_USERNAME=xyne
KC_DB_PASSWORD=xyne
```

After the app image is available on the VM and the Keycloak compose service is
running, bootstrap the realm/client/user from an app container on the same
Docker network:

```bash
sudo docker compose -f docker-compose.gpu.yml --profile keycloak up -d xyne-db keycloak
sudo docker run --rm --network xyne-stack_xyne --env-file .env xyne-v2:latest \
  sh -lc 'cd /usr/src/app/server && bun run keycloak:bootstrap'
```

Bootstrap creates or updates the `xyne-workspace-external-id` Keycloak protocol
mapper. That mapper copies each Keycloak user's `xyne_workspace_external_id`
attribute into the ID token. The bootstrap admin user receives
`KEYCLOAK_WORKSPACE_EXTERNAL_ID`; additional users should be created in the
`xyne-shared` realm and mapped to their target Xyne workspace.

To provision an additional Keycloak user for an existing Xyne workspace:

```bash
sudo docker run --rm --network xyne-stack_xyne --env-file .env \
  -e KEYCLOAK_USER_EMAIL=user@example.com \
  -e KEYCLOAK_USER_NAME="User Name" \
  -e KEYCLOAK_USER_PASSWORD='<strong-user-password>' \
  -e KEYCLOAK_USER_WORKSPACE_EXTERNAL_ID=<workspace-external-id> \
  -e KEYCLOAK_USER_ROLE=User \
  xyne-v2:latest sh -lc \
  'cd /usr/src/app/server && bun run keycloak:provision-user'
```

Create application users in the `xyne-shared` realm, not the `master` realm.
Users in `master` are only for Keycloak administration and cannot log in to
Xyne's `xyne-web` client.

To create or update a Xyne workspace and refresh the Keycloak workspace
dropdown used while creating/editing users:

```bash
sudo docker run --rm --network xyne-stack_xyne --env-file .env \
  -e XYNE_WORKSPACE_EXTERNAL_ID=boi-workspace \
  -e XYNE_WORKSPACE_NAME="BOI" \
  -e XYNE_WORKSPACE_DOMAIN=boi.local \
  -e XYNE_WORKSPACE_CREATED_BY=admin@boi.local \
  xyne-v2:latest sh -lc \
  'cd /usr/src/app/server && bun run keycloak:provision-workspace'
```

The script stores the workspace in Xyne, then configures the Keycloak
`xyne_workspace_external_id` user-profile attribute as an admin-editable
single-select dropdown whose options are all Xyne workspace external ids.

Useful demo links after the edge proxy and Keycloak are up:

- Xyne sign in: `https://<demo-origin>/signin`
- Start Keycloak login: `https://<demo-origin>/v1/auth/keycloak/start`
- Keycloak admin console: `https://<demo-origin>/keycloak/admin/master/console/`
- Realm users: `https://<demo-origin>/keycloak/admin/master/console/#/xyne-shared/users`
- Account console: `https://<demo-origin>/keycloak/realms/xyne-shared/account`
- OIDC discovery: `https://<demo-origin>/keycloak/realms/xyne-shared/.well-known/openid-configuration`

---

## Deploy — step by step

Run from the repo root, on the commit you want to ship (usually `main`):

### 1. Pull the target commit
```bash
git checkout main && git pull        # main tracks origin/main (the XYNE-project repo)
```

### 2. Build the lean source tar

**Excludes MUST be anchored to full paths** (`server/storage`, not `storage`).
A bare `storage`/`data`/`logs` matches *any* path component and silently drops
real source (e.g. `server/app/agent/storage/*.ts`) → runtime `Cannot find module`
crash-loop. Also exclude the multi-GB runtime dirs.

```bash
cd <repo-root>
rm -f /tmp/xyne-v2-src.tar.gz
COPYFILE_DISABLE=1 tar --no-mac-metadata \
  --exclude='server/node_modules' --exclude='frontend/node_modules' \
  --exclude='server/storage' --exclude='server/data' --exclude='server/logs' \
  --exclude='server/downloads' --exclude='server/vespa-data' --exclude='server/vespa-logs' \
  --exclude='server/xyne-data' --exclude='server/vespa/models' --exclude='server/platform/vespa/models' \
  --exclude='*.onnx' --exclude='frontend/dist' --exclude='frontend/.vite' \
  --exclude='.git' --exclude='.env' --exclude='server/.env' --exclude='frontend/.env' \
  --exclude='.DS_Store' \
  -czf /tmp/xyne-v2-src.tar.gz \
  Dockerfile start.sh server frontend
```
Tar should be **a few MB** (≈1.7M), not GB. `frontend/src/routeTree.gen.ts` is
tracked, so the working-tree tar already includes it (no TanStack-Router
build break).

### 3. Verify completeness (no source dropped by the excludes)
```bash
comm -23 <(git ls-files server frontend Dockerfile start.sh | sort) \
         <(tar -tzf /tmp/xyne-v2-src.tar.gz | sort)
```
Output must be empty **except** `server/logs/.gitkeep` (the excluded placeholder).
Anything else listed = real source missing → fix excludes before continuing.

### 4. Copy tar + script to the VM
```bash
gcloud compute scp /tmp/xyne-v2-src.tar.gz doc/deploy.sh \
  xyne-k8s-test:/tmp/ --tunnel-through-iap \
  --zone=asia-southeast1-a --project=xyne-spaces-sbx
```

### 5. Run the deploy on the VM (detached — the build takes minutes)
```bash
gcloud compute ssh xyne-k8s-test --tunnel-through-iap \
  --zone=asia-southeast1-a --project=xyne-spaces-sbx \
  --command="chmod +x /tmp/deploy.sh; rm -f /tmp/deploy-v2-latest.log; \
    nohup bash /tmp/deploy.sh >/tmp/deploy-v2-latest.log 2>&1 </dev/null & echo pid=\$!"
```

### 6. Watch it finish
```bash
gcloud compute ssh xyne-k8s-test --tunnel-through-iap \
  --zone=asia-southeast1-a --project=xyne-spaces-sbx \
  --command='for i in $(seq 1 20); do
      grep -qE "SUCCESS|BUILD FAILED|PREFLIGHT FAILED|ROLLED BACK" /tmp/deploy-v2-latest.log && break; sleep 15;
    done; tail -30 /tmp/deploy-v2-latest.log;
    sudo docker ps --filter name=xyne-app --format "{{.Names}} | {{.Status}} | {{.Image}}"'
```
Success looks like: `SUCCESS — healthy` + `{"ok":true,...}` + `xyne-app | Up … (healthy) | xyne-v2:latest`.

---

## What `doc/deploy.sh` does (the VM-side logic)

1. **Rollback snapshot** — `docker tag xyne-v2:latest xyne-v2:pre-deploy-<TS>`.
2. **Extract** the tar to a fresh `/tmp/xyne-v2-build` (leftover may be root-owned → `sudo rm`).
3. **Build candidate** — `docker build -f Dockerfile -t xyne-v2:candidate-<TS> .`.
4. **Preflight** — boots the candidate (`bun app/server.ts`) and fails if it prints
   any `Cannot find module`. A clean image still hides a missing relative import;
   only *running* catches it.
5. **Promote** — `docker tag candidate xyne-v2:latest`.
6. **Recreate app only** — `docker compose -f docker-compose.gpu.yml up -d
   --force-recreate --no-deps app`. **Never** `--remove-orphans` (it would nuke the
   `docling-scheduler-*` / sync containers that live in other compose files).
7. **Health gate + auto-rollback** — polls `/v2/health` for ~2 min; on failure,
   re-tags `pre-deploy-<TS>` → `latest` and recreates (restores in seconds).

Run all `docker` as `sudo`; reading `.env` needs `sudo`.

---

## Manual rollback

If you need to roll back after the fact, pick the snapshot from the deploy log
(`rollback image kept: xyne-v2:pre-deploy-<TS>`) and:
```bash
gcloud compute ssh xyne-k8s-test --tunnel-through-iap \
  --zone=asia-southeast1-a --project=xyne-spaces-sbx \
  --command='cd /home/shivral_somani_juspay_in/xyne-stack && \
    sudo docker tag xyne-v2:pre-deploy-<TS> xyne-v2:latest && \
    sudo docker compose -f docker-compose.gpu.yml up -d --force-recreate --no-deps app'
```
`sudo docker images | grep xyne-v2` lists all available snapshots.

---

## Gotchas (learned the hard way)

- **Anchor every exclude to its full path.** A bare `storage`/`data`/`logs`
  silently drops source and crash-loops prod.
- **Build on the VM**, not locally — the image registry and build resources live there.
- **Preflight is not optional** — a clean Docker build does not catch a missing
  relative import; the run-check does.
- **No `--remove-orphans`** on the recreate.
- macOS `tar` emits `LIBARCHIVE.xattr.com.apple.provenance` warnings on the Linux
  VM during extract — harmless, ignore them.
- **Per-deploy DB data migrations** (e.g. tool renames) run *after* the container
  is healthy, so a failed deploy rolls back without a stranded data change.
