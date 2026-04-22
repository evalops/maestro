#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const config = {
	packageName: "@evalops/maestro",
	repository: "evalops/maestro",
	workflowFile: "release.yml",
	environment: "npm-release",
	npmPackage: "npm@11.10.0",
};

const args = process.argv.slice(2);
const allowedFlags = new Set(["--apply", "--dry-run", "--json", "--list"]);

function readValueFlag(name) {
	const prefix = `${name}=`;
	const match = args.find((arg) => arg.startsWith(prefix));
	return match ? match.slice(prefix.length) : null;
}

const unknown = args.filter((arg) => {
	if (allowedFlags.has(arg)) {
		return false;
	}
	return !arg.startsWith("--otp=");
});

if (unknown.length > 0) {
	console.error(`Unsupported option(s): ${unknown.join(", ")}`);
	console.error(
		"Usage: node scripts/configure-npm-trusted-publisher.mjs [--list] [--apply] [--otp=<code>]",
	);
	process.exit(2);
}

const apply = args.includes("--apply");
const list = args.includes("--list");
const otp = readValueFlag("--otp") ?? process.env.NPM_OTP ?? null;

const npmArgs = ["--yes", config.npmPackage, "trust"];

if (list) {
	npmArgs.push("list", config.packageName, "--json");
} else {
	npmArgs.push(
		"github",
		config.packageName,
		"--repo",
		config.repository,
		"--file",
		config.workflowFile,
		"--env",
		config.environment,
		"--json",
	);
	if (!apply) {
		npmArgs.push("--dry-run");
	} else {
		npmArgs.push("--yes");
	}
}

if (otp) {
	npmArgs.push(`--otp=${otp}`);
}

const shownArgs = npmArgs.filter((arg) => !arg.startsWith("--otp="));
console.error(`Running: npx ${shownArgs.join(" ")}`);
if (!apply && !list) {
	console.error("Dry run only. Add --apply --otp=<code> to write npm trust config.");
}

const result = spawnSync("npx", npmArgs, { stdio: "inherit" });
if (result.error) {
	console.error(result.error.message);
	process.exit(1);
}
process.exit(result.status ?? 1);
