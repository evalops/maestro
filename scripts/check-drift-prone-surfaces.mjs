#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function read(path) {
	return readFileSync(join(root, path), "utf8");
}

function includesAll(source, needles) {
	return needles.every((needle) => source.includes(needle));
}

const failures = [];

const telemetryEntrypoints = [
	"src/telemetry.ts",
	"src/telemetry/beacon.ts",
];

for (const path of telemetryEntrypoints) {
	const source = read(path);
	if (!source.includes("normalizeTelemetryMetadataInputs")) {
		failures.push(`${path} must use normalizeTelemetryMetadataInputs`);
	}
	for (const forbidden of [
		"SENSITIVE_METADATA_KEY_PATTERN",
		"splitTelemetryMetadataRecord",
		"splitTelemetryMetadataValue",
		"mergeTelemetryMetadataRecord",
		"mergeTelemetryMetadataValue",
	]) {
		if (source.includes(forbidden)) {
			failures.push(
				`${path} must not duplicate telemetry metadata normalization (${forbidden})`,
			);
		}
	}
}

const sharedEvalOpsAliasUsers = [
	"src/evalops/managed-context.ts",
	"src/platform/client.ts",
	"src/mcp/platform-plugin.ts",
	"src/prompts/service-client.ts",
	"src/platform/agent-runtime-client.ts",
	"src/platform/tool-execution-client.ts",
	"src/platform/a2a-client.ts",
	"src/remote-runner/client.ts",
	"src/platform/maestro-timeline-client.ts",
	"src/memory/service-client.ts",
	"src/telemetry/meter-service-client.ts",
	"src/approvals/service-client.ts",
	"src/skills/service-client.ts",
	"src/connectors/service-client.ts",
	"src/safety/governance-service-client.ts",
	"src/oauth/evalops.ts",
	"src/providers/auth.ts",
	"src/providers/api-keys.ts",
	"src/platform/cerebro-facts-client.ts",
];

for (const path of sharedEvalOpsAliasUsers) {
	const source = read(path);
	const expectedImport = path.startsWith("src/evalops/")
		? "./env-aliases.js"
		: "../evalops/env-aliases.js";
	if (!source.includes(expectedImport)) {
		failures.push(`${path} must use src/evalops/env-aliases.ts`);
	}
}

const rootAliasSource = read("src/evalops/env-aliases.ts");
if (
	!includesAll(rootAliasSource, [
		"EVALOPS_ACCESS_TOKEN_ENV_VARS",
		"EVALOPS_ORGANIZATION_ID_ENV_VARS",
		"EVALOPS_WORKSPACE_ID_ENV_VARS",
		"EVALOPS_INTEGRATION_PROFILE_ENV_VARS",
		"EVALOPS_MEMORY_MODE_ENV_VARS",
		"EVALOPS_RUNTIME_OWNER_ENV_VARS",
		"EVALOPS_SHIM_TYPE_ENV_VARS",
		"EVALOPS_TRACE_MODE_ENV_VARS",
		"readEvalOpsEnv",
	])
) {
	failures.push("src/evalops/env-aliases.ts is missing expected alias exports");
}

const slackRuntime = read("packages/slack-agent/src/platform-runtime.ts");
if (!slackRuntime.includes("./platform-env.js")) {
	failures.push("packages/slack-agent/src/platform-runtime.ts must use platform-env.ts");
}

if (failures.length > 0) {
	console.error("drift-prone surface check failed:");
	for (const failure of failures) {
		console.error(`  - ${failure}`);
	}
	process.exit(1);
}

console.log("drift-prone surface check passed");
