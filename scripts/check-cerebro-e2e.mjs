#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cerebroRepo = resolve(root, process.env.LOCAL_CEREBRO_REPO ?? "../cerebro");

let status = 0;

function ok(message) {
	console.log(`ok   ${message}`);
}

function fail(message) {
	console.error(`fail ${message}`);
	status = 1;
}

function warn(message) {
	console.log(`warn ${message}`);
}

function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function checkCommand(command, args) {
	const result = spawnSync(command, args, { stdio: "ignore" });
	return result.status === 0;
}

function readEnvFile(path) {
	const values = new Map();
	if (!existsSync(path)) {
		return values;
	}
	for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || !line.includes("=")) {
			continue;
		}
		const [name, ...rest] = line.split("=");
		values.set(name.trim(), rest.join("=").trim().replace(/^["']|["']$/g, ""));
	}
	return values;
}

function commandOutput(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8" });
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

const exampleEnv = readEnvFile(resolve(root, ".env.example"));
const localEnv = readEnvFile(resolve(root, ".env"));

function configuredValue(names, fallback) {
	for (const name of names) {
		const envValue = process.env[name]?.trim();
		if (envValue) {
			return envValue;
		}
		const fileValue = localEnv.get(name)?.trim();
		if (fileValue) {
			return fileValue;
		}
	}
	return fallback;
}

function normalizeUrl(value) {
	return value.replace(/\/+$/, "").replace(/\/cerebro\.v1\.CerebroService$/, "");
}

const expectedCerebroUrl = normalizeUrl(
	configuredValue(
		["MAESTRO_CEREBRO_URL", "CEREBRO_URL", "CEREBRO_SERVICE_URL", "LOCAL_BASE_URL"],
		"http://localhost:18080",
	),
);
const expectedCerebroMcpUrl = normalizeUrl(
	configuredValue(
		["MAESTRO_PLATFORM_MCP_URL", "MAESTRO_EVALOPS_AGENT_MCP_URL", "EVALOPS_AGENT_MCP_URL"],
		`${expectedCerebroUrl}/mcp`,
	),
);
const expectedCerebroWorkspace = configuredValue(
	["MAESTRO_CEREBRO_WORKSPACE_ID", "MAESTRO_WORKSPACE_ID", "CEREBRO_WORKSPACE_ID", "LOCAL_MAESTRO_WORKSPACE_ID"],
	"org_evalops_fixture",
);

function portForUrl(value) {
	const parsed = new URL(value);
	if (parsed.port) {
		return parsed.port;
	}
	return parsed.protocol === "https:" ? "443" : "80";
}

const expectedPort = portForUrl(expectedCerebroUrl);
const e2eEnv = new Map([
	["LOCAL_HTTP_PORT", process.env.LOCAL_HTTP_PORT ?? expectedPort],
	["LOCAL_ADDR", process.env.LOCAL_ADDR ?? `:${expectedPort}`],
	["LOCAL_BASE_URL", process.env.LOCAL_BASE_URL ?? expectedCerebroUrl],
	["MAESTRO_CEREBRO_URL", expectedCerebroUrl],
	["MAESTRO_CEREBRO_WORKSPACE_ID", expectedCerebroWorkspace],
	["MAESTRO_WORKSPACE_ID", expectedCerebroWorkspace],
	["MAESTRO_PLATFORM_MCP_URL", expectedCerebroMcpUrl],
	["LOCAL_MAESTRO_GENERATE_REPLAY", process.env.LOCAL_MAESTRO_GENERATE_REPLAY ?? "true"],
	["LOCAL_MAESTRO_DOCTOR_REPLAY", process.env.LOCAL_MAESTRO_DOCTOR_REPLAY ?? "auto"],
]);

if (process.argv.includes("--print-env")) {
	for (const [name, value] of e2eEnv) {
		console.log(`${name}=${shellQuote(value)}`);
	}
	process.exit(0);
}

console.log("Maestro Cerebro local E2E doctor");
console.log(`  Maestro repo: ${root}`);
console.log(`  Cerebro repo: ${cerebroRepo}`);
console.log(`  Expected local Cerebro URL: ${expectedCerebroUrl}`);
console.log(`  Expected local Cerebro MCP URL: ${expectedCerebroMcpUrl}`);
console.log(`  Expected local Cerebro workspace: ${expectedCerebroWorkspace}`);
console.log("");

if (existsSync(resolve(cerebroRepo, "Makefile"))) {
	ok("Cerebro Makefile found");
} else {
	fail(
		`Cerebro checkout not found at ${cerebroRepo}; set LOCAL_CEREBRO_REPO=/path/to/cerebro`,
	);
}

if (existsSync(resolve(cerebroRepo, "scripts/local-maestro-doctor.sh"))) {
	ok("Cerebro local Maestro doctor found");
} else {
	fail("Cerebro checkout is missing scripts/local-maestro-doctor.sh; pull latest main");
}

if (existsSync(resolve(root, "scripts/generate-maestro-platform-replay-fixture.ts"))) {
	ok("Maestro replay generator found");
} else {
	fail("Maestro replay generator missing");
}

if (checkCommand("bun", ["--version"])) {
	ok("command bun");
} else {
	fail("command bun is required");
}

if (checkCommand("docker", ["compose", "version"])) {
	ok("docker compose plugin");
} else {
	fail("docker compose plugin is required");
}

if (existsSync(resolve(root, "package.json"))) {
	const packageJson = readFileSync(resolve(root, "package.json"), "utf8");
	if (packageJson.includes('"smoke"') && packageJson.includes('"build"')) {
		ok("Maestro build and smoke scripts present");
	} else {
		fail("Maestro package.json is missing build or smoke scripts");
	}
}

if (existsSync(resolve(root, "Makefile"))) {
	const makefile = readFileSync(resolve(root, "Makefile"), "utf8");
	const exportedEnv = [
		"MAESTRO_CEREBRO_URL",
		"CEREBRO_URL",
		"CEREBRO_SERVICE_URL",
		"MAESTRO_CEREBRO_TOKEN",
		"CEREBRO_TOKEN",
		"MAESTRO_CEREBRO_WORKSPACE_ID",
		"MAESTRO_WORKSPACE_ID",
		"CEREBRO_WORKSPACE_ID",
		"MAESTRO_PLATFORM_MCP_URL",
		"MAESTRO_EVALOPS_AGENT_MCP_URL",
		"MAESTRO_CEREBRO_MCP_SCOPES",
		"MAESTRO_EVALOPS_MEMORY_MODE",
	];
	let makefileExportsOk = true;
	for (const name of exportedEnv) {
		if (!makefile.includes(name)) {
			fail(`Makefile does not export ${name}; .env values will not reach make-launched Maestro commands`);
			makefileExportsOk = false;
		}
	}
	if (makefileExportsOk) {
		ok("Makefile exports local Cerebro/MCP env vars");
	}
}

const exampleExpectations = new Map([
	["MAESTRO_CEREBRO_URL", "http://localhost:18080"],
	["MAESTRO_CEREBRO_WORKSPACE_ID", "org_evalops_fixture"],
	["MAESTRO_WORKSPACE_ID", "org_evalops_fixture"],
	["MAESTRO_PLATFORM_MCP_URL", "http://localhost:18080/mcp"],
	["MAESTRO_CEREBRO_MCP_SCOPES", "cerebro:read"],
	["MAESTRO_EVALOPS_MEMORY_MODE", "cerebro"],
]);
for (const [name, expected] of exampleExpectations) {
	if (exampleEnv.get(name) === expected) {
		ok(`.env.example ${name}=${expected}`);
	} else {
		warn(`.env.example does not document ${name}=${expected}; using effective local config instead`);
	}
}

if (localEnv.size > 0) {
	ok(".env loaded for local Cerebro override checks");
	if (localEnv.has("MAESTRO_CEREBRO_URL") || localEnv.has("CEREBRO_URL") || localEnv.has("LOCAL_BASE_URL")) {
		ok(`effective local Cerebro URL is ${expectedCerebroUrl}`);
	}
	if (localEnv.has("MAESTRO_PLATFORM_MCP_URL") || localEnv.has("MAESTRO_EVALOPS_AGENT_MCP_URL")) {
		ok(`effective local Cerebro MCP URL is ${expectedCerebroMcpUrl}`);
	}
	if (
		localEnv.has("MAESTRO_CEREBRO_WORKSPACE_ID") ||
		localEnv.has("MAESTRO_WORKSPACE_ID") ||
		localEnv.has("CEREBRO_WORKSPACE_ID") ||
		localEnv.has("LOCAL_MAESTRO_WORKSPACE_ID")
	) {
		ok(`effective local Cerebro workspace is ${expectedCerebroWorkspace}`);
	}
}

if (checkCommand("lsof", ["-v"])) {
	const listener = commandOutput("lsof", ["-nP", `-iTCP:${expectedPort}`, "-sTCP:LISTEN"]);
	if (listener.stdout.trim()) {
		const readyz = commandOutput("curl", ["-fsS", `${expectedCerebroUrl}/readyz`]);
		if (readyz.status === 0) {
			fail(`${expectedCerebroUrl}/readyz is already serving; stop the existing Cerebro process or choose another LOCAL_HTTP_PORT before running the self-contained E2E`);
		} else {
			fail(`port ${expectedPort} is already listening but Cerebro readyz is unhealthy:\n${listener.stdout.trim()}`);
		}
	} else {
		ok(`port ${expectedPort} is available for the self-contained Cerebro E2E`);
	}
} else {
	warn("skipped Cerebro port availability check because lsof is unavailable");
}

if (status === 0) {
	const result = spawnSync("make", ["-C", cerebroRepo, "local-maestro-doctor"], {
		stdio: "inherit",
		env: {
			...process.env,
			...Object.fromEntries(e2eEnv),
			LOCAL_MAESTRO_REPO: root,
		},
	});
	if (result.status !== 0) {
		status = result.status ?? 1;
	}
}

if (status !== 0) {
	console.error("");
	console.error("Maestro Cerebro local E2E doctor found blocking issues.");
	process.exit(status);
}

console.log("");
console.log("Ready to run: make cerebro-e2e");
