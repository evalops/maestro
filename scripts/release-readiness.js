#!/usr/bin/env node

import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { loadRootPackage, shouldManagePackageLock } from "./workspace-utils.js";

const mode = process.argv[2] ?? "release";
const rootPackage = loadRootPackage();

function run(command) {
	console.log(`$ ${command}`);
	execSync(command, { stdio: "inherit" });
}

function hasScript(name) {
	return typeof rootPackage.scripts?.[name] === "string";
}

function maybeRunScript(name) {
	if (!hasScript(name)) {
		console.log(`Skipping npm run ${name} (script missing)`);
		return;
	}

	run(`npm run ${name}`);
}

function runPackSmoke() {
	const smokeScriptPath = resolve(process.cwd(), "scripts/smoke-packed-cli.js");
	if (!existsSync(smokeScriptPath)) {
		console.log("Skipping packed CLI smoke test (script missing)");
		return;
	}

	const tarball = execSync("npm pack --silent", { encoding: "utf8" })
		.trim()
		.split("\n")
		.at(-1);

	if (!tarball) {
		throw new Error("npm pack did not produce a tarball name");
	}

	try {
		run(`node scripts/smoke-packed-cli.js "${tarball}"`);
	} finally {
		rmSync(resolve(process.cwd(), tarball), { force: true });
	}
}

function runCiChecks() {
	maybeRunScript("metadata:check");
	run("bun run bun:lint");
	run("npm run build");
	run("npm run verify:runtime-deps");
}

function runReleaseChecks() {
	maybeRunScript("metadata:check");
	run("bun run bun:lint");
	run("npm run clean && npm run build:all");
	run("npm run verify:runtime-deps");
	if (hasScript("openapi:generate")) {
		run("bun run openapi:generate");
	}
	run("bun run bun:test");
	if (shouldManagePackageLock(rootPackage)) {
		run("npx -y -p node@22 -p npm@11.11.0 npm audit --audit-level=high");
	} else {
		console.log("Skipping npm audit (package-lock not managed in this repo)");
	}
	runPackSmoke();
}

switch (mode) {
	case "ci":
		runCiChecks();
		break;
	case "release":
		runReleaseChecks();
		break;
	default:
		console.error(`Unknown release-readiness mode: ${mode}`);
		process.exit(1);
}
