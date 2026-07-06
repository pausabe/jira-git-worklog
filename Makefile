.PHONY: install run build typecheck check-jira

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
