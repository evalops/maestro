#!/usr/bin/env node

import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { loadRootPackage, shouldManagePackageLock } from "./workspace-utils.js";

const mode = process.argv[2] ?? "release";
const rootPackage = loadRootPackage();

function run(command, env = {}) {
	console.log(`$ ${command}`);
	execSync(command, { stdio: "inherit", env: { ...process.env, ...env } });
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

function removeStandaloneBinaryArtifacts() {
	for (const artifact of ["dist/maestro-bun", "dist/maestro-bun-bytecode"]) {
		rmSync(resolve(process.cwd(), artifact), { force: true });
	}
}

function ensurePackedCliArtifacts() {
	const cliArtifact = resolve(process.cwd(), "dist/cli.js");
	if (existsSync(cliArtifact)) {
		return;
	}

	console.log("Building package before packed CLI smoke (dist/cli.js missing).");
	run("npm run build");
}

function runPackSmoke() {
	const smokeScriptPath = resolve(process.cwd(), "scripts/smoke-packed-cli.js");
	if (!existsSync(smokeScriptPath)) {
		console.log("Skipping packed CLI smoke test (script missing)");
		return;
	}

	removeStandaloneBinaryArtifacts();
	ensurePackedCliArtifacts();
	const tarball = execSync("npm pack --silent", { encoding: "utf8" })
		.trim()
		.split("\n")
		.at(-1);

	if (!tarball) {
		throw new Error("npm pack did not produce a tarball name");
	}

	try {
		run(`node scripts/smoke-packed-cli.js "${tarball}"`, {
			MAESTRO_INSTALL_AUDIT_LEVEL:
				process.env.MAESTRO_INSTALL_AUDIT_LEVEL ?? "critical",
		});
	} finally {
		rmSync(resolve(process.cwd(), tarball), { force: true });
	}
}

function runCiChecks() {
	maybeRunScript("metadata:check");
	maybeRunScript("cutover:check");
	run("bun run bun:lint");
	run("npm run build");
	run("npm run verify:runtime-deps");
	runPackSmoke();
	maybeRunScript("smoke:exec-replay-e2e");
	maybeRunScript("openapi:check");
}

function runReleaseChecks() {
	maybeRunScript("metadata:check");
	maybeRunScript("cutover:check");
	run("bun run bun:lint");
	run("npm run clean && npm run build:all");
	run("npm run verify:runtime-deps");
	maybeRunScript("openapi:check");
	run("bun run bun:test");
	if (shouldManagePackageLock(rootPackage)) {
		run("npx -y -p node@22 -p npm@11.11.0 npm audit --audit-level=high");
	} else {
		console.log("Skipping npm audit (package-lock not managed in this repo)");
	}
	runPackSmoke();
	maybeRunScript("smoke:exec-replay-e2e");
}

switch (mode) {
	case "pack-smoke":
		runPackSmoke();
		break;
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
