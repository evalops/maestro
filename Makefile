# Maestro — ergonomic Make targets wrapping npm/bun scripts
# Auto-loads .env when present (falls back to shell env otherwise).
# Only the vars below are exported — bare `export` would leak MAKEFLAGS etc.
-include .env
export ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY GROQ_API_KEY \
       OPENROUTER_API_KEY XAI_API_KEY EXA_API_KEY \
       MAESTRO_MODEL MAESTRO_MODEL_PROVIDER \
       MAESTRO_CEREBRO_URL CEREBRO_URL CEREBRO_SERVICE_URL \
       MAESTRO_CEREBRO_TOKEN CEREBRO_TOKEN \
       MAESTRO_EVALOPS_ACCESS_TOKEN EVALOPS_TOKEN \
       MAESTRO_CEREBRO_WORKSPACE_ID CEREBRO_WORKSPACE_ID \
       MAESTRO_AGENT_RUNTIME_WORKSPACE_ID AGENT_RUNTIME_WORKSPACE_ID \
       MAESTRO_WORKSPACE_ID MAESTRO_EVALOPS_WORKSPACE_ID EVALOPS_WORKSPACE_ID \
       MAESTRO_REMOTE_RUNNER_WORKSPACE_ID \
       MAESTRO_CEREBRO_TIMEOUT_MS CEREBRO_TIMEOUT_MS \
       MAESTRO_CEREBRO_MAX_ATTEMPTS CEREBRO_MAX_ATTEMPTS \
       MAESTRO_CEREBRO_SEARCH_LIMIT CEREBRO_SEARCH_LIMIT \
       MAESTRO_CEREBRO_CHANGE_LIMIT CEREBRO_CHANGE_LIMIT \
       LOCAL_HTTP_PORT LOCAL_ADDR LOCAL_BASE_URL \
       MAESTRO_PLATFORM_MCP_ENABLED MAESTRO_AGENT_MCP_ENABLED \
       MAESTRO_PLATFORM_MCP_NAME MAESTRO_AGENT_MCP_NAME \
       MAESTRO_PLATFORM_MCP_URL MAESTRO_AGENT_MCP_URL MAESTRO_EVALOPS_AGENT_MCP_URL \
       EVALOPS_AGENT_MCP_URL MAESTRO_PLATFORM_MCP_MANIFEST_URL \
       MAESTRO_AGENT_MCP_MANIFEST_URL MAESTRO_EVALOPS_AGENT_MCP_MANIFEST_URL \
       MAESTRO_PLATFORM_MCP_TOKEN MAESTRO_AGENT_MCP_TOKEN \
       MAESTRO_CEREBRO_MCP_SCOPES MAESTRO_PLATFORM_MCP_SCOPES \
       MAESTRO_AGENT_MCP_SCOPES MAESTRO_EVALOPS_AGENT_MCP_SCOPES \
       MAESTRO_EVALOPS_MEMORY_MODE EVALOPS_MEMORY_MODE

LOCAL_CEREBRO_REPO ?= ../cerebro

.PHONY: help setup install build build-all compile run-ts run-rs run-rs-debug \
        web web-local dev dev-all developer-surface-check test test-fast test-coverage lint check fmt fmt-unsafe \
        smoke cerebro-dev cerebro-env cerebro-e2e cerebro-e2e-doctor cerebro-e2e-trace evals verify clean db-up db-down db-migrate

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

compile: ## Compile standalone binary (dist/maestro-bun)
	npm run bun:compile

run-ts: ## Launch TS TUI (with .env)
	bun run ./src/cli.ts

run-rs: build ## Launch Rust TUI (release)
	cargo build --release --manifest-path packages/tui-rs/Cargo.toml && \
	MAESTRO_AGENT_SCRIPT="$$(pwd)/dist/cli.js" ./packages/tui-rs/target/release/maestro-tui

run-rs-debug: build ## Launch Rust TUI (debug build)
	cargo build --manifest-path packages/tui-rs/Cargo.toml && \
	MAESTRO_AGENT_SCRIPT="$$(pwd)/dist/cli.js" ./packages/tui-rs/target/debug/maestro-tui

web: ## Web UI dev server (backend + Vite)
	npm run web:dev

web-local: ## Web UI dev server with local-only auth/Redis bypasses
	npm run web:dev:local

dev: ## TS watch mode
	npm run dev

dev-all: ## TS watch + test watch
	npm run dev:all

developer-surface-check: ## Verify local tooling, introspection, and tracing guardrails
	npm run developer-surface:check

test: ## Full test suite
	npx nx run maestro:test --skip-nx-cache

test-fast: ## Fast test subset
	npm run test:fast

test-coverage: ## Test suite with V8 coverage report
	npm run test:coverage

lint: ## Biome + eval verifier
	bun run bun:lint

check: lint test ## Full CI check (lint + test)

fmt: ## Auto-format with Biome (safe formatting only)
	bunx biome format --write .

fmt-unsafe: ## Auto-format + unsafe lint fixes
	bunx biome check --fix --unsafe .

smoke: build ## Smoke-test the built CLI
	npm run smoke

cerebro-e2e-doctor: ## Preflight the cross-repo Cerebro local E2E lane
	LOCAL_CEREBRO_REPO="$(LOCAL_CEREBRO_REPO)" node scripts/check-cerebro-e2e.mjs

cerebro-env: ## Print env exports for running this Maestro checkout against local Cerebro
	@LOCAL_CEREBRO_REPO="$(LOCAL_CEREBRO_REPO)" node scripts/check-cerebro-e2e.mjs --print-maestro-env

cerebro-dev: cerebro-e2e-doctor ## Start a usable local Cerebro stack with Maestro event ingestion enabled
	@env_exports="$$(LOCAL_CEREBRO_REPO="$(LOCAL_CEREBRO_REPO)" node scripts/check-cerebro-e2e.mjs --print-env)" && \
		eval "$$env_exports" && \
		LOCAL_MAESTRO_REPO="$(CURDIR)" \
		LOCAL_HTTP_PORT="$$LOCAL_HTTP_PORT" \
		LOCAL_ADDR="$$LOCAL_ADDR" \
		LOCAL_BASE_URL="$$LOCAL_BASE_URL" \
		MAESTRO_CEREBRO_URL="$$MAESTRO_CEREBRO_URL" \
		MAESTRO_CEREBRO_WORKSPACE_ID="$$MAESTRO_CEREBRO_WORKSPACE_ID" \
		MAESTRO_WORKSPACE_ID="$$MAESTRO_WORKSPACE_ID" \
		MAESTRO_PLATFORM_MCP_URL="$$MAESTRO_PLATFORM_MCP_URL" \
		MAESTRO_AGENT_MCP_URL="$$MAESTRO_AGENT_MCP_URL" \
		MAESTRO_CEREBRO_MCP_SCOPES="$$MAESTRO_CEREBRO_MCP_SCOPES" \
		MAESTRO_PLATFORM_MCP_SCOPES="$$MAESTRO_PLATFORM_MCP_SCOPES" \
		MAESTRO_AGENT_MCP_SCOPES="$$MAESTRO_AGENT_MCP_SCOPES" \
		LOCAL_MAESTRO_GENERATE_REPLAY="$$LOCAL_MAESTRO_GENERATE_REPLAY" \
		LOCAL_MAESTRO_DOCTOR_REPLAY="$$LOCAL_MAESTRO_DOCTOR_REPLAY" \
		$(MAKE) -C "$(LOCAL_CEREBRO_REPO)" local-maestro-dev

cerebro-e2e: cerebro-e2e-doctor ## Run the cross-repo Cerebro local E2E using this Maestro checkout
	@env_exports="$$(LOCAL_CEREBRO_REPO="$(LOCAL_CEREBRO_REPO)" node scripts/check-cerebro-e2e.mjs --print-env)" && \
		eval "$$env_exports" && \
		LOCAL_MAESTRO_REPO="$(CURDIR)" \
		LOCAL_HTTP_PORT="$$LOCAL_HTTP_PORT" \
		LOCAL_ADDR="$$LOCAL_ADDR" \
		LOCAL_BASE_URL="$$LOCAL_BASE_URL" \
		MAESTRO_CEREBRO_URL="$$MAESTRO_CEREBRO_URL" \
		MAESTRO_CEREBRO_WORKSPACE_ID="$$MAESTRO_CEREBRO_WORKSPACE_ID" \
		MAESTRO_WORKSPACE_ID="$$MAESTRO_WORKSPACE_ID" \
		MAESTRO_PLATFORM_MCP_URL="$$MAESTRO_PLATFORM_MCP_URL" \
		MAESTRO_AGENT_MCP_URL="$$MAESTRO_AGENT_MCP_URL" \
		MAESTRO_CEREBRO_MCP_SCOPES="$$MAESTRO_CEREBRO_MCP_SCOPES" \
		MAESTRO_PLATFORM_MCP_SCOPES="$$MAESTRO_PLATFORM_MCP_SCOPES" \
		MAESTRO_AGENT_MCP_SCOPES="$$MAESTRO_AGENT_MCP_SCOPES" \
		LOCAL_MAESTRO_GENERATE_REPLAY="$$LOCAL_MAESTRO_GENERATE_REPLAY" \
		LOCAL_MAESTRO_DOCTOR_REPLAY="$$LOCAL_MAESTRO_DOCTOR_REPLAY" \
		$(MAKE) -C "$(LOCAL_CEREBRO_REPO)" local-maestro-e2e

cerebro-e2e-trace: export LOCAL_REQUIRE_CEREBRO_TRACE_TARGET=true
cerebro-e2e-trace: cerebro-e2e-doctor ## Run the trace-backed Maestro/Cerebro local E2E and prove it in Jaeger
	@env_exports="$$(LOCAL_CEREBRO_REPO="$(LOCAL_CEREBRO_REPO)" node scripts/check-cerebro-e2e.mjs --print-env)" && \
		eval "$$env_exports" && \
		LOCAL_MAESTRO_REPO="$(CURDIR)" \
		LOCAL_HTTP_PORT="$$LOCAL_HTTP_PORT" \
		LOCAL_ADDR="$$LOCAL_ADDR" \
		LOCAL_BASE_URL="$$LOCAL_BASE_URL" \
		MAESTRO_CEREBRO_URL="$$MAESTRO_CEREBRO_URL" \
		MAESTRO_CEREBRO_WORKSPACE_ID="$$MAESTRO_CEREBRO_WORKSPACE_ID" \
		MAESTRO_WORKSPACE_ID="$$MAESTRO_WORKSPACE_ID" \
		MAESTRO_PLATFORM_MCP_URL="$$MAESTRO_PLATFORM_MCP_URL" \
		MAESTRO_AGENT_MCP_URL="$$MAESTRO_AGENT_MCP_URL" \
		MAESTRO_CEREBRO_MCP_SCOPES="$$MAESTRO_CEREBRO_MCP_SCOPES" \
		MAESTRO_PLATFORM_MCP_SCOPES="$$MAESTRO_PLATFORM_MCP_SCOPES" \
		MAESTRO_AGENT_MCP_SCOPES="$$MAESTRO_AGENT_MCP_SCOPES" \
		LOCAL_MAESTRO_GENERATE_REPLAY="$$LOCAL_MAESTRO_GENERATE_REPLAY" \
		LOCAL_MAESTRO_DOCTOR_REPLAY="$$LOCAL_MAESTRO_DOCTOR_REPLAY" \
		$(MAKE) -C "$(LOCAL_CEREBRO_REPO)" local-e2e-trace

evals: ## Run eval scenarios
	npx nx run maestro:evals --skip-nx-cache

verify: fmt lint test build smoke ## Full verification (format + lint + test + build + smoke)

clean: ## Remove build artifacts
	npm run clean

db-up: ## Start Redis + PostgreSQL (Docker)
	docker compose up -d

db-down: ## Stop Docker services
	docker compose down

db-migrate: ## Run DB migrations
	npm run db:migrate
