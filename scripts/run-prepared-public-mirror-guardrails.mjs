#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

function parseTarget(argv) {
	const index = argv.indexOf("--target");
	const target = index >= 0 ? argv[index + 1] : "";
	if (!target) throw new Error("Missing required --target <path>");
	return resolve(target);
}

/**
 * Lightweight checks on the prepared public tree before opening/updating the
 * sync PR. Full `cargo test` / clippy / evals already ran on internal main for
 * the same product sources; re-running a workspace cargo check here only burns
 * minutes and still cannot catch public-runner skew. Keep the mirror-specific
 * rust-only boundary check only.
 */
export function preparedPublicMirrorGuardrailCommands() {
	return [
		{
			command: "npm",
			args: ["run", "check:rust-only-runtime"],
			label: "Rust-only source guard",
		},
	];
}

function main() {
	const targetRoot = parseTarget(process.argv.slice(2));
	if (!existsSync(resolve(targetRoot, "package.json"))) {
		throw new Error(`Prepared public mirror target is invalid: ${targetRoot}`);
	}
	for (const { command, args, label } of preparedPublicMirrorGuardrailCommands()) {
		console.log(`\n## ${label}`);
		const result = spawnSync(command, args, { cwd: targetRoot, stdio: "inherit" });
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}.`);
	}
	console.log("Prepared public mirror native guardrails passed.");
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
