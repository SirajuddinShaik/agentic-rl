# Xyne runtime image for Polar RL agent containers.
#
# This is the BASE image only: Bun + Postgres client (for health checks) + the
# wait-for-xyne.sh helper. The Xyne backend source is NOT baked in here — Polar's
# runtime `PrepareAction` (upload) copies it into the container at task-submit
# time. This image only needs to provide a living container with the tooling.
#
# Health endpoint the wait script polls: GET /v2/health (Xyne backend port 3000).

FROM oven/bun:1-debian

# postgresql-client provides pg_isready (used by container health checks).
# We need curl for wait-for-xyne.sh HTTP polling.
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client curl \
    && rm -rf /var/lib/apt/lists/*

# Build context is the Polar repo root (docker build -f xyne/Dockerfile .),
# so the source file is at xyne/wait-for-xyne.sh relative to the context root.
COPY xyne/wait-for-xyne.sh /usr/local/bin/wait-for-xyne.sh
RUN chmod +x /usr/local/bin/wait-for-xyne.sh

# Polar's runtime starts the container then `exec`s prepare commands into it,
# so the container must stay alive. A long-running interactive shell does that.
CMD ["/bin/bash"]
