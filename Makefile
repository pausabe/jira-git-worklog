.PHONY: install run build typecheck check-jira \
        docker-build docker-up docker-down docker-logs

install:
	npm install

run:
	npm run dev

build:
	npm run build

typecheck:
	npm run typecheck

check-jira:
	npm run check:jira --workspace server

# ---------------------------------------------------------------------------
# Docker targets
# ---------------------------------------------------------------------------

# Build the production image (all three stages).
docker-build:
	docker compose build

# Start the container in the foreground (Ctrl-C to stop).
# Requires .env and config.yaml to exist — copy from examples if needed:
#   cp .env.example .env && cp config.example.yaml config.yaml
docker-up:
	docker compose up --build

# Start detached.
docker-up-detached:
	docker compose up --build -d

# Stop and remove containers (data in ./server/data is preserved).
docker-down:
	docker compose down

# Tail logs from the running container.
docker-logs:
	docker compose logs -f app
