#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.resolve(projectRoot, ".."));

const args = new Set(process.argv.slice(2));
if (args.has("--no-link") && args.has("--link")) {
	console.error("Cannot use --no-link and --link together.");
	process.exit(1);
}

const isNixEnv = Boolean(
	process.env.NIX_REMOTE ||
		process.env.NIX_PROFILES ||
		process.env.NIX_USER_PROFILE_DIR ||
		process.env.IN_NIX_SHELL,
);

const explicitSkip = args.has("--no-link");
const explicitForce = args.has("--link");
const shouldLink = explicitForce || (!explicitSkip && !isNixEnv);

const steps = [
	{
		title: "Installing dependencies",
		command: "npm",
		args: ["install"],
	},
	{
		title: "Building Composer CLI",
		command: "npm",
		args: ["run", "build"],
	},
];

if (shouldLink) {
	steps.push({
		title: "Linking composer globally (npm link)",
		command: "npm",
		args: ["link"],
	});
}

if (isNixEnv && !explicitForce && !explicitSkip) {
	console.log(
		"Detected Nix-managed environment (.dotfiles). Skipping npm link. Use --link to force linking.",
	);
}

if (explicitSkip) {
	console.log("Skipping npm link as requested (--no-link).");
}

if (explicitForce && isNixEnv) {
	console.log("Forcing npm link even though a Nix environment was detected.");
}

for (const step of steps) {
	console.log(`\n▶ ${step.title}`);
	const result = spawnSync(step.command, step.args, {
		stdio: "inherit",
		shell: false,
	});
	if (result.status !== 0) {
		console.error(`\n✖ Step failed: ${step.title}`);
		process.exit(result.status ?? 1);
	}
}

const completionMessage = shouldLink
	? "Composer linked globally. Run 'composer --help' to verify installation."
	: "Composer built locally. Run 'npm link' to expose the CLI globally when ready.";

console.log(`\n✅ ${completionMessage}`);
