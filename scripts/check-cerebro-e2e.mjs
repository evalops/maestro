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

function checkCommand(command, args) {
	const result = spawnSync(command, args, { stdio: "ignore" });
	return result.status === 0;
}

console.log("Maestro Cerebro local E2E doctor");
console.log(`  Maestro repo: ${root}`);
console.log(`  Cerebro repo: ${cerebroRepo}`);
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

if (status === 0) {
	const result = spawnSync("make", ["-C", cerebroRepo, "local-maestro-doctor"], {
		stdio: "inherit",
		env: {
			...process.env,
			LOCAL_MAESTRO_REPO: root,
			LOCAL_MAESTRO_GENERATE_REPLAY: "true",
			LOCAL_MAESTRO_DOCTOR_REPLAY:
				process.env.LOCAL_MAESTRO_DOCTOR_REPLAY ?? "auto",
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
