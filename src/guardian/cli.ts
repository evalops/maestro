#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatGuardianResult, runGuardian } from "./runner.js";
import type { GuardianTarget } from "./types.js";

function printHelp(): void {
	console.log(`Maestro Guardian

Usage: guardian [--staged|--all] [--json] [--no-env] [--quiet] [--trigger <label>]

Options:
  --staged       Scan staged changes only (default)
  --all          Scan all tracked files
  --json         Emit JSON result
  --no-env       Ignore MAESTRO_GUARDIAN overrides
  --quiet        Omit file list from result output
  --trigger val  Label the caller (e.g. pre-commit, cli)
  -h, --help     Show this message
`);
}

function parseArgs(argv: string[]): {
	target: GuardianTarget;
	json: boolean;
	respectEnv: boolean;
	quiet: boolean;
	trigger?: string;
	showHelp: boolean;
} {
	let target: GuardianTarget = "staged";
	let json = false;
	let respectEnv = true;
	let quiet = false;
	let trigger: string | undefined;
	let showHelp = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--staged") {
			target = "staged";
		} else if (arg === "--all") {
			target = "all";
		} else if (arg === "--json") {
			json = true;
		} else if (arg === "--no-env") {
			respectEnv = false;
		} else if (arg === "--quiet") {
			quiet = true;
		} else if (arg === "--trigger") {
			trigger = argv[i + 1];
			i += 1;
		} else if (arg === "-h" || arg === "--help") {
			showHelp = true;
		}
	}

	return { target, json, respectEnv, quiet, trigger, showHelp };
}

export async function runGuardianCli(
	argv = process.argv.slice(2),
): Promise<number> {
	const parsed = parseArgs(argv);
	if (parsed.showHelp) {
		printHelp();
		return 0;
	}

	const result = await runGuardian({
		target: parsed.target,
		trigger: parsed.trigger ?? "cli",
		respectEnv: parsed.respectEnv,
		quiet: parsed.quiet,
	});

	if (parsed.json) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log(formatGuardianResult(result));
	}

	return result.exitCode;
}

const __filename = fileURLToPath(import.meta.url);

if (process.argv[1] && __filename === resolve(process.argv[1])) {
	void runGuardianCli().then((code) => {
		process.exitCode = code;
	});
}
