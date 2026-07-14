# =============================================================================
# jira-git-worklog — multi-stage Dockerfile
#
# Stage 1 (web-builder)   — compile the React/Vite SPA → web/dist/
# Stage 2 (server-builder) — compile the Fastify TypeScript server → server/dist/
# Stage 3 (runtime)        — lean production image: only compiled JS + prod deps
#
# The final image exposes port 4000.  A single container runs the Fastify server,
# which serves both the REST API (/api/*) and the compiled SPA static assets.
# No devDependencies and no TypeScript source are present in the final layer.
#
# Runtime configuration is NEVER baked into the image.  Mount the two files at
# container start (see docker-compose.yml):
#   - .env          → /app/.env           (Jira / GitHub secrets + PORT override)
#   - config.yaml   → /app/config.yaml    (workday rules, no secrets)
# =============================================================================

# ---- shared base ----
ARG NODE_VERSION=20-alpine

# =============================================================================
# Stage 1: build the web SPA
# =============================================================================
FROM node:${NODE_VERSION} AS web-builder

WORKDIR /build

# Copy only the manifests first so that npm install is cached unless deps change.
COPY package.json package-lock.json ./
COPY web/package.json ./web/
# The server workspace must be present because npm workspaces links them.
COPY server/package.json ./server/

RUN npm ci --ignore-scripts

# Copy web source and build.
COPY web/ ./web/
RUN npm run build --workspace web

# =============================================================================
# Stage 2: compile the server TypeScript
# =============================================================================
FROM node:${NODE_VERSION} AS server-builder

WORKDIR /build

COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/

RUN npm ci --ignore-scripts

COPY server/ ./server/
RUN npm run build --workspace server

# =============================================================================
# Stage 3: production runtime
# =============================================================================
FROM node:${NODE_VERSION} AS runtime

# Run as a non-root user for security.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# --- production dependencies only (no devDependencies) ---
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/

RUN npm ci --omit=dev --ignore-scripts && \
    # Remove npm cache to keep the layer small.
    npm cache clean --force

# --- compiled server ---
COPY --from=server-builder /build/server/dist ./server/dist/

# --- compiled web assets (served as static files by Fastify) ---
COPY --from=web-builder /build/web/dist ./web/dist/

# Persistent data directory (branch links, churn cache, imputation ledger).
# Declare it as a volume so Docker (or compose) can mount it from the host.
VOLUME ["/app/server/data"]

# The server reads HOST to decide which interface to bind.
# Set to 0.0.0.0 so the port is reachable outside the container.
ENV HOST=0.0.0.0
ENV PORT=4000
# Point config to the mounted file (overridable via .env).
ENV CONFIG_PATH=/app/config.yaml

# Drop privileges before starting the process.
USER appuser

EXPOSE 4000

# server/package.json "start": "node dist/index.js"
# The CWD is /app; paths.ts resolves PROJECT_ROOT two levels up from
# server/dist/paths.js → /app, which is correct.
CMD ["node", "server/dist/index.js"]
