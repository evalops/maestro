# Composer — ergonomic Make targets wrapping npm/bun scripts
# Auto-loads .env when present (falls back to shell env otherwise).
# Only the vars below are exported — bare `export` would leak MAKEFLAGS etc.
-include .env
export ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY GROQ_API_KEY \
       OPENROUTER_API_KEY XAI_API_KEY EXA_API_KEY \
       COMPOSER_MODEL COMPOSER_MODEL_PROVIDER

.PHONY: help install build build-all compile run-ts run-rs run-rs-debug \
        web dev dev-all test test-fast lint check fmt clean \
        db-up db-down db-migrate

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

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

clean: ## Remove build artifacts
	npm run clean

db-up: ## Start Redis + PostgreSQL (Docker)
	docker compose up -d

db-down: ## Stop Docker services
	docker compose down

db-migrate: ## Run DB migrations
	npm run db:migrate
