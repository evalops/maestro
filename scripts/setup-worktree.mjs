#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";

function parseArgs(argv) {
	const args = {
		checkOnly: false,
		skipInstall: false,
	};
	for (const arg of argv) {
		switch (arg) {
			case "--check-only":
				args.checkOnly = true;
				args.skipInstall = true;
				break;
			case "--skip-install":
				args.skipInstall = true;
				break;
			default:
				throw new Error(
					"Usage: node scripts/setup-worktree.mjs [--skip-install] [--check-only]",
				);
		}
	}
	return args;
}

function run(command, args) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, {
		stdio: "inherit",
		env: process.env,
	});
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(`${command} exited with status ${result.status}`);
	}
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.skipInstall) {
		run("npm", ["install", "--ignore-scripts"]);
	}

	run("npm", ["run", "check:rust-only-runtime"]);
	run("cargo", ["check", "--locked", "--manifest-path", "packages/maestro-rs/Cargo.toml"]);

	if (!args.checkOnly) {
		console.log("worktree setup complete");
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
