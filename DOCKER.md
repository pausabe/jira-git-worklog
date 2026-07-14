# Docker setup — jira-git-worklog

## Architecture

**Single container, single port.**

The Fastify server serves both:
- The REST API under `/api/*`
- The compiled React/Vite SPA as static files from `/`

There is no separate web server or second container.

```
Browser → http://localhost:4000
              │
              ▼
        Fastify (port 4000)
         ├── /api/*        → REST handlers (Jira, GitHub)
         └── /*            → static files from web/dist/
```

## Exposed port

**`4000`** (default).  Override by setting `PORT` in `.env`.

## Prerequisites

- Docker Engine 24+ (or Docker Desktop)
- `docker compose` v2 (included with Docker Desktop and Docker Engine 24+)

## Quick start

```bash
# 1. Create your secrets file from the example
cp .env.example .env
# → Edit .env: fill in JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN,
#              GITHUB_TOKEN, GITHUB_ORG

# 2. Create your workday-rules file from the example
cp config.example.yaml config.yaml
# → Edit config.yaml: set people, recurring meetings, etc.
#   (You can also edit it later from the Config tab in the UI.)

# 3. Create the data directory (persists branch links & ledger across restarts)
mkdir -p server/data

# 4. Build and start
docker compose up --build
```

Open **http://localhost:4000** in your browser.

## Files mounted at runtime

| Host path | Container path | Purpose |
|---|---|---|
| `./.env` | `/app/.env` | Jira/GitHub secrets + optional `PORT` / `CONFIG_PATH` overrides |
| `./config.yaml` | `/app/config.yaml` | Workday rules (no secrets — safe to share with teammates) |
| `./server/data/` | `/app/server/data/` | Persistent local data: branch links, churn cache, imputation ledger |

Neither `.env` nor `config.yaml` is ever baked into the image.

## Dockerfile stages

| Stage | Base | What it does |
|---|---|---|
| `web-builder` | `node:20-alpine` | `npm ci` + `vite build` → `web/dist/` |
| `server-builder` | `node:20-alpine` | `npm ci` + `tsc` → `server/dist/` |
| `runtime` | `node:20-alpine` | Production `npm ci --omit=dev`, copies compiled artefacts, drops privileges |

The final image contains **no TypeScript source files** and **no devDependencies**.

## Changing the port

Edit `.env`:

```dotenv
PORT=8080
```

`docker-compose.yml` reads `${PORT:-4000}` for the host→container port mapping, so the
published port tracks the value automatically.

## Stopping and cleaning up

```bash
docker compose down          # stop containers
docker compose down -v       # also remove the anonymous volume (if any)
```

Data in `./server/data/` on the host is preserved because it is a bind mount, not a
Docker-managed volume.
