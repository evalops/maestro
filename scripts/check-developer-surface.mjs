#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const requirements = {
	"local tooling": [
		["package.json", '"dev"'],
		["package.json", '"dev:all"'],
		["package.json", '"smoke:event-bus"'],
		["package.json", '"smoke:local-e2e"'],
		["package.json", '"platform:sdk-smoke"'],
		["package.json", '"web:dev:local"'],
		["scripts/smoke-cli.js", "mock-agent-write-read"],
		["scripts/smoke-cli.js", "mock-agent-search-read"],
		["scripts/smoke-cli.js", "mock-agent-edit-read"],
		["scripts/run-mock-agent-write-read.js", "did not read the expected file content"],
		["scripts/run-mock-agent-search-read.js", "did not read the expected search match"],
		["scripts/run-mock-agent-edit-read.js", "did not read the expected updated file content"],
		["Makefile", "dev-all"],
		["Makefile", "web-local"],
		["Makefile", "cerebro-dev"],
		["Makefile", "cerebro-env"],
		["Makefile", "cerebro-e2e-doctor"],
		["Makefile", "cerebro-e2e-trace"],
		["Makefile", "MAESTRO_CEREBRO_URL"],
		["Makefile", "MAESTRO_PLATFORM_MCP_URL"],
		["Makefile", "MAESTRO_WORKSPACE_ID"],
		["scripts/check-cerebro-e2e.mjs", "Maestro Cerebro local E2E doctor"],
		["scripts/check-cerebro-e2e.mjs", "--print-env"],
		["scripts/check-cerebro-e2e.mjs", "--print-maestro-env"],
	],
	"local introspection": [
		["package.json", '"telemetry:report"'],
		["package.json", '"db:migrate:status"'],
		["docs/FEATURES.md", "/diag"],
		["docs/FEATURES.md", "/telemetry"],
		["src/server/routes.ts", "/api/status"],
		["src/server/routes.ts", "/api/metrics"],
	],
	"distributed tracing": [
		["src/opentelemetry.ts", "OTEL_EXPORTER_OTLP_ENDPOINT"],
		["src/services/traces/otel.ts", "OpenTelemetryTraceExport"],
		["src/telemetry/maestro-event-bus.ts", "traceparent"],
		["src/telemetry/observability.ts", "OTEL_EXPORTER_OTLP_ENDPOINT"],
		["src/web-server.ts", "server-timing"],
	],
};

function read(path) {
	return readFileSync(join(root, path), "utf8");
}

const failures = [];

for (const [category, checks] of Object.entries(requirements)) {
	for (const [path, needle] of checks) {
		let haystack;
		try {
			haystack = read(path);
		} catch (error) {
			failures.push(`${category}: missing required file ${path}: ${error.message}`);
			continue;
		}
		if (!haystack.includes(needle)) {
			failures.push(`${category}: ${path} does not contain ${JSON.stringify(needle)}`);
		}
	}
}

if (failures.length > 0) {
	console.error("developer surface check failed:");
	for (const failure of failures) {
		console.error(`  - ${failure}`);
	}
	process.exit(1);
}

console.log("developer surface check passed: local tooling, introspection, and tracing are present");
