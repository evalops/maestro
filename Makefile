# Composer — ergonomic Make targets wrapping npm/bun scripts
# Auto-loads .env when present (falls back to shell env otherwise).
# Only the vars below are exported — bare `export` would leak MAKEFLAGS etc.
-include .env
export ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY GROQ_API_KEY \
       OPENROUTER_API_KEY XAI_API_KEY EXA_API_KEY \
       COMPOSER_MODEL COMPOSER_MODEL_PROVIDER

.PHONY: help setup install build build-all compile run-ts run-rs run-rs-debug \
        web dev dev-all test test-fast lint check fmt smoke evals verify clean \
        db-up db-down db-migrate

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

setup: ## First-time project bootstrap
	@test -f .env || { test -f .env.example || { echo "error: .env.example not found — is this a complete checkout?" >&2; exit 1; }; \
		cp .env.example .env && echo "Created .env from .env.example — add your API keys"; }
	bun install
	bun run build:all
	@echo "\nReady! Run 'make run-ts' or 'make help' for all targets."

install: ## Install dependencies (bun install)
	bun install

build: ## Build TS CLI
	npm run build

build-all: ## Build all packages (contracts, tui, web, cli, ai)
	npm run build:all

compile: ## Compile standalone binary (dist/composer-bun)
	npm run bun:compile

run-ts: ## Launch TS TUI (with .env)
	bun run ./src/cli.ts

run-rs: build ## Launch Rust TUI (release)
	cargo build --release --manifest-path packages/tui-rs/Cargo.toml && \
	COMPOSER_AGENT_SCRIPT="$$(pwd)/dist/cli.js" ./packages/tui-rs/target/release/composer-tui

run-rs-debug: build ## Launch Rust TUI (debug build)
	cargo build --manifest-path packages/tui-rs/Cargo.toml && \
	COMPOSER_AGENT_SCRIPT="$$(pwd)/dist/cli.js" ./packages/tui-rs/target/debug/composer-tui

web: ## Web UI dev server (backend + Vite)
	npm run web:dev

dev: ## TS watch mode
	npm run dev

dev-all: ## TS watch + test watch
	npm run dev:all

test: ## Full test suite
	npx nx run composer:test --skip-nx-cache

test-fast: ## Fast test subset
	npm run test:fast

lint: ## Biome + eval verifier
	bun run bun:lint

check: lint test ## Full CI check (lint + test)

fmt: ## Auto-format with Biome
	bunx biome check --fix --unsafe .

smoke: ## Smoke-test the built CLI
	npm run smoke

evals: ## Run eval scenarios
	npx nx run composer:evals --skip-nx-cache

verify: fmt lint test build smoke ## Full verification (format + lint + test + build + smoke)

clean: ## Remove build artifacts
	npm run clean

db-up: ## Start Redis + PostgreSQL (Docker)
	docker compose up -d

db-down: ## Stop Docker services
	docker compose down

db-migrate: ## Run DB migrations
	npm run db:migrate
