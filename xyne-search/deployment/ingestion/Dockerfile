FROM oven/bun:1 AS base

WORKDIR /usr/src/app

COPY server/package.json server/bun.lock* /usr/src/app/server/

WORKDIR /usr/src/app/server
RUN bun install

WORKDIR /usr/src/app
COPY --chown=bun:bun server/ /usr/src/app/server/
COPY --chown=bun:bun biome.json /usr/src/app/

ENV NODE_ENV=production

USER root
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y \
    curl \
    qpdf \
    libreoffice-writer \
    libreoffice-impress \
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
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app/server
RUN mkdir -p downloads storage logs migrations vespa-data vespa-logs uploads && \
    chown -R bun:bun downloads storage logs migrations vespa-data vespa-logs uploads

USER bun

CMD ["bun", "sync-server.ts"]
