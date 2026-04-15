#!/usr/bin/env node
/**
 * Fast prebuild dependency guard.
 *
 * Skips `bun install` when:
 * - bun.lockb exists
 * - node_modules exists
 * - stored lockfile hash matches current lockfile
 *
 * Writes the hash to node_modules/.bun-lockb.sha256 after a successful install.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const lockfile = "bun.lockb";
const stamp = join("node_modules", ".bun-lockb.sha256");

function hashFile(path) {
	const buf = readFileSync(path);
	return createHash("sha256").update(buf).digest("hex");
}

function runInstall() {
	const result = spawnSync("bun", ["install", "--frozen-lockfile"], {
		stdio: "inherit",
	});
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
	const hash = hashFile(lockfile);
	mkdirSync(dirname(stamp), { recursive: true });
	writeFileSync(stamp, hash);
}

function main() {
	if (!existsSync(lockfile)) {
		console.warn("[ensure-deps] bun.lockb missing; running bun install");
		return runInstall();
	}
	if (!existsSync("node_modules")) {
		console.log("[ensure-deps] node_modules missing; running bun install");
		return runInstall();
	}

	const currentHash = hashFile(lockfile);
	const cachedHash = existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : "";

	if (currentHash === cachedHash) {
		console.log("[ensure-deps] dependencies up to date; skipping bun install");
		return;
	}

	console.log("[ensure-deps] lockfile changed; running bun install");
	runInstall();
}

main();
