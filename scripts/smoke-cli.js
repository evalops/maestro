#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const commands = [
	{
		name: "help",
		cmd: "node",
		args: ["dist/cli.js", "--help"],
	},
	{
		name: "version",
		cmd: "node",
		args: ["dist/cli.js", "--version"],
	},
];

let hadError = false;

const baseEnv = {
	...process.env,
	ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "test-key",
};

for (const command of commands) {
	const result = spawnSync(command.cmd, command.args, {
		stdio: "inherit",
		env: baseEnv,
	});
	if (result.status !== 0) {
		console.error(`Smoke command "${command.name}" failed with code ${result.status}`);
		hadError = true;
		break;
	}
}

if (hadError) {
	process.exit(1);
}

console.log("Smoke tests completed successfully.");
