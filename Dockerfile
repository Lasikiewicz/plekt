# plekt - self-hosted watch-state bridge (Sonarr/Radarr-style).
FROM node:25-trixie-slim

LABEL org.opencontainers.image.title="Plekt" \
    org.opencontainers.image.url="https://plekt.net" \
    org.opencontainers.image.source="https://github.com/Lasikiewicz/plekt"

WORKDIR /app
ARG BUILD_CHANNEL=release
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=5055 \
    BUILD_CHANNEL=$BUILD_CHANNEL

# Install gosu for clean privilege-drop in the entrypoint.
RUN apt-get update && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*

# Install production dependencies. The Trixie base provides the glibc level
# required by the bundled ARM better-sqlite3 prebuild.
COPY package.json package-lock.json* ./
COPY scripts/install-git-hooks.js ./scripts/install-git-hooks.js
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY scripts/check-worker-health.js ./scripts/check-worker-health.js
COPY scripts/seed-demo-catalog.js ./scripts/seed-demo-catalog.js
RUN npm ci --omit=dev --ignore-scripts \
    && sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

# Application code.
COPY server ./server
COPY public ./public
COPY changelog*.json ./

# The Node slim base provides a 'node' user at uid 1000; rename it to
# 'plekt' for clarity and set up the data directory.
RUN usermod -l plekt node && groupmod -n plekt node \
    && mkdir -p /data && chown plekt:plekt /data /app

VOLUME ["/data"]
EXPOSE 5055

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node scripts/check-worker-health.js

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server/server.js"]
