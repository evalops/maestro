#!/usr/bin/env node
// Workspace contract check: ports the assertions that used to live in
// tools/bazel/maestro_bazel_contract_test.sh (run via `//:maestro_bazel_contract_test`
// under Bazel). Bazel has been retired; this keeps the same guarantees in
// the plain `npm run check` lane instead.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
	console.error(`workspace contract: ${message}`);
	process.exit(1);
}

function requireFile(path) {
	if (!existsSync(resolve(ROOT, path))) fail(`missing ${path}`);
}

function requireNonEmptyFile(path) {
	requireFile(path);
	if (readFileSync(resolve(ROOT, path), "utf8").length === 0) {
		fail(`${path} must not be empty`);
	}
}

function requireText(path, needle) {
	requireFile(path);
	const text = readFileSync(resolve(ROOT, path), "utf8");
	if (!text.includes(needle)) fail(`${path} must contain ${needle}`);
}

requireFile(".node-version");
requireFile("tool-versions.json");

const nodeVersion = readFileSync(resolve(ROOT, ".node-version"), "utf8").replace(/\s/g, "");
if (!nodeVersion) fail(".node-version must declare Node");

requireText("tool-versions.json", `"node": "${nodeVersion}"`);

requireText("package.json", `"build:all"`);
requireText("package.json", "cargo check --workspace");
requireText("package.json", "check:rust-only-runtime");
requireNonEmptyFile("Cargo.lock");
requireText("Cargo.toml", "[workspace]");

for (const crate of ["ambient-agent-rs", "runtime-gateway-rs", "maestro-rs", "tui-rs"]) {
	requireFile(`packages/${crate}/Cargo.toml`);
}

console.log("Workspace contract is in sync with the unified Rust workspace.");
