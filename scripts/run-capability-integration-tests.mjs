#!/usr/bin/env node
// @ts-check

import { spawnSync } from "node:child_process";

const TEST_FILES = [
	"test/tools/find.test.ts",
	"test/tools/image-processor.test.ts",
	"test/db/db-integration.test.ts",
	"test/slack-agent/sandbox.test.ts",
];

function commandAvailable(command, args = ["--version"]) {
	const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe" });
	return result.status === 0;
}

async function sharpAvailable() {
	try {
		await import("sharp");
		return true;
	} catch {
		return false;
	}
}

const capabilities = {
	db: Boolean(process.env.MAESTRO_DATABASE_URL || process.env.DATABASE_URL),
	docker: commandAvailable("docker", ["info"]),
	fd: commandAvailable("fd", ["--version"]),
	sharp: await sharpAvailable(),
};

console.log(
	`Capability integration profile: ${Object.entries(capabilities)
		.map(([name, available]) => `${name}=${available ? "yes" : "no"}`)
		.join(", ")}`,
);

const result = spawnSync(
	process.execPath,
	["./scripts/run-vitest.js", "--run", ...TEST_FILES, "--reporter=verbose"],
	{
		env: {
			...process.env,
			MAESTRO_CAPABILITY_INTEGRATION: "1",
		},
		stdio: "inherit",
	},
);

if (result.error) {
	throw result.error;
}

process.exit(result.status ?? 1);
