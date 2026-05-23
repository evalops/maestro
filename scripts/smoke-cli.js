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
	{
		name: "headless",
		cmd: "node",
		args: ["scripts/smoke-headless.js"],
	},
	{
		name: "mock-agent-read",
		cmd: "node",
		args: ["scripts/run-mock-agent.js", "README.md"],
	},
	{
		name: "mock-agent-write-read",
		cmd: "node",
		args: ["scripts/run-mock-agent-write-read.js"],
	},
	{
		name: "mock-agent-search-read",
		cmd: "node",
		args: ["scripts/run-mock-agent-search-read.js"],
	},
	{
		name: "mock-agent-edit-read",
		cmd: "node",
		args: ["scripts/run-mock-agent-edit-read.js"],
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
