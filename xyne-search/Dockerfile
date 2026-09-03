# Dockerfile — production image for the xyne v2 stack (frontend + backendv2).
#
# Shape mirrors the v1 Dockerfile: one bun process, one port. Differences:
#   - Builds frontend/ → static assets staged at server/frontend-dist
#   - Boots via start.sh → bun app/server.ts (not server.ts)
#   - server/ source is still copied wholesale because backendv2/* imports 14
#     shared modules from it (db client, auth, vespa client, ai/model config,
#     pi-mono core, etc.). They live in the same image.
#
# Build:
#   docker build -f Dockerfile -t xyne-v2 .
# Run (single container, mounted .env + storage):
#   docker run --env-file server/.env -p 3000:3000 \
#     -v $(pwd)/server/storage:/usr/src/app/server/storage xyne-v2

FROM oven/bun:1 AS base
WORKDIR /usr/src/app

# ── Dependency install (cached layer) ─────────────────────────────────────
COPY server/package.json server/bun.lock* /usr/src/app/server/
COPY frontend/package.json frontend/bun.lock* /usr/src/app/frontend/

WORKDIR /usr/src/app/server
RUN bun install

WORKDIR /usr/src/app/frontend
RUN bun install

# ── Source ────────────────────────────────────────────────────────────────
WORKDIR /usr/src/app
COPY --chown=bun:bun server/ /usr/src/app/server/
COPY --chown=bun:bun frontend/    /usr/src/app/frontend/

# ── Build frontend → /usr/src/app/server/frontend-dist ──────────────────────────────
# Vite outputs to frontend/dist by default; we move it next to the backendv2
# entrypoint so serveStatic's relative paths resolve correctly when the
# server CWD is /usr/src/app/server (see start.sh).
WORKDIR /usr/src/app/frontend
RUN bun run build && \
    rm -rf /usr/src/app/server/frontend-dist && \
    mv dist /usr/src/app/server/frontend-dist

# ── System deps (vespa CLI + image libs) ──────────────────────────────────
# Same set as v1's Dockerfile so behavior is interchangeable; backendv2
# doesn't need canvas at runtime, but server/ still does for v1-era code
# paths that get imported transitively.
ENV NODE_ENV=production
USER root
RUN apt-get update && apt-get install -y \
    wget \
    curl \
    qpdf \
    tar \
    libexpat1 \
    libexpat1-dev \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    libpixman-1-dev \
    libfontconfig1-dev \
    libfreetype6-dev \
    && wget https://github.com/vespa-engine/vespa/releases/download/v8.453.24/vespa-cli_8.453.24_linux_amd64.tar.gz \
    && tar -xzf vespa-cli_8.453.24_linux_amd64.tar.gz \
    && mv vespa-cli_8.453.24_linux_amd64/bin/vespa /usr/local/bin/ \
    && rm -rf vespa-cli_8.453.24_linux_amd64 vespa-cli_8.453.24_linux_amd64.tar.gz \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# ── Runtime dirs (own them for the bun user) ──────────────────────────────
WORKDIR /usr/src/app/server
RUN mkdir -p downloads vespa-data vespa-logs uploads migrations storage && \
    chown bun:bun downloads vespa-data vespa-logs uploads migrations storage frontend-dist

# ── Boot script ───────────────────────────────────────────────────────────
COPY --chown=bun:bun start.sh /usr/src/app/start.sh
RUN chmod +x /usr/src/app/start.sh

USER bun
EXPOSE 3000
CMD ["/usr/src/app/start.sh"]
