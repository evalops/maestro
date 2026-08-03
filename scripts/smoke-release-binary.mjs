#!/usr/bin/env node
// @ts-check

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getPackageMetadata } from "./package-metadata.js";

function parseArgs(argv) {
	const options = {
		binary: "",
		expectedVersion: getPackageMetadata().version,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--expected-version":
				options.expectedVersion = argv[++index] ?? "";
				break;
			default:
				if (!options.binary) {
					options.binary = arg;
					break;
				}
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return options;
}

function fail(message, details = "") {
	console.error(message);
	if (details) {
		console.error(details);
	}
	process.exitCode = 1;
}

function parseStdoutMessages(stdout) {
	const messages = [];
	const lines = stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	for (const [index, line] of lines.entries()) {
		try {
			messages.push(JSON.parse(line));
		} catch (error) {
			fail(
				`Binary headless stdout line ${index + 1} was not protocol JSON.`,
				`line: ${line}\nerror: ${error instanceof Error ? error.message : error}`,
			);
			break;
		}
	}
	return messages;
}

const options = parseArgs(process.argv.slice(2));
if (!options.binary) {
	console.error(
		"Usage: node scripts/smoke-release-binary.mjs <binary-path> [--expected-version <version>]",
	);
	process.exit(1);
}

const binary = resolve(options.binary);
statSync(binary);

const home = mkdtempSync(join(tmpdir(), "maestro-release-binary-smoke-"));
try {
	const baseEnv = {
		...process.env,
		ANTHROPIC_API_KEY: "test-key",
		HOME: home,
		MAESTRO_HOME: join(home, ".maestro"),
		OPENAI_API_KEY: "test-key",
	};

	const version = spawnSync(binary, ["--version"], {
		encoding: "utf8",
		env: baseEnv,
		timeout: 30000,
	});
	if (version.error) {
		fail("Release binary failed to launch for --version.", version.error.stack);
	} else if (version.status !== 0) {
		fail(
			`Release binary --version exited with code ${version.status}.`,
			[version.stdout, version.stderr].filter(Boolean).join("\n\n"),
		);
	} else if (!version.stdout.includes(options.expectedVersion)) {
		fail(
			`Release binary --version did not include ${options.expectedVersion}.`,
			version.stdout.trim(),
		);
	}

	const hello = {
		type: "hello",
		protocol_version: "2026-08-01",
		client_info: { name: "maestro-release-binary-smoke", version: "0.1.0" },
		role: "controller",
	};
	const headless = spawnSync(
		binary,
		[
			"--headless",
			"--provider",
			"openai",
			"--api-key",
			"test-key",
			"--model",
			"gpt-4o-mini",
		],
		{
			encoding: "utf8",
			env: baseEnv,
			input: `${JSON.stringify(hello)}\n`,
			timeout: Number.parseInt(
				process.env.MAESTRO_RELEASE_BINARY_SMOKE_TIMEOUT_MS ?? "60000",
				10,
			),
		},
	);

	if (headless.error) {
		fail("Release binary failed to launch in headless mode.", headless.error.stack);
	} else if (headless.status !== 0) {
		fail(
			`Release binary headless smoke exited with code ${headless.status}.`,
			[headless.stdout, headless.stderr].filter(Boolean).join("\n\n"),
		);
	} else {
		const types = new Set(
			parseStdoutMessages(headless.stdout).map((message) => message.type),
		);
		if (!types.has("ready")) {
			fail("Release binary headless smoke did not receive a ready message.");
		}
		if (!types.has("hello_ok")) {
			fail("Release binary headless smoke did not receive a hello_ok message.");
		}
	}
} finally {
	rmSync(home, { recursive: true, force: true });
}

if (process.exitCode === 1) {
	process.exit(1);
}

console.log(`Release binary smoke completed successfully for ${binary}.`);
