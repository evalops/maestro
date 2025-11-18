#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.resolve(projectRoot, ".."));

const args = new Set(process.argv.slice(2));
const skipLink = args.has("--no-link");
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

if (!skipLink) {
	steps.push({
		title: "Linking composer globally (npm link)",
		command: "npm",
		args: ["link"],
	});
}

for (const step of steps) {
	console.log(`\n▶ ${step.title}`);
	const result = spawnSync(step.command, step.args, {
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	if (result.status !== 0) {
		console.error(`\n✖ Step failed: ${step.title}`);
		process.exit(result.status ?? 1);
	}
}

const completionMessage = skipLink
	? "Composer built locally. Run 'npm link' to expose the CLI globally when ready."
	: "Composer linked globally. Run 'composer --help' to verify installation.";

console.log(`\n✅ ${completionMessage}`);
