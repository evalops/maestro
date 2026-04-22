#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "maestro-headless-smoke-"));

function fail(message, details) {
	console.error(message);
	if (details) {
		console.error(details);
	}
	process.exitCode = 1;
}

function runHeadless(args, input = "") {
	return spawnSync(
		"node",
		[
			"dist/cli.js",
			"--headless",
			"--provider",
			"openai",
			"--api-key",
			"test-key",
			...args,
		],
		{
			cwd: process.cwd(),
			encoding: "utf8",
			input,
			env: {
				...process.env,
				HOME: home,
				MAESTRO_HOME: join(home, ".maestro"),
				OPENAI_API_KEY: "test-key",
				ANTHROPIC_API_KEY: "test-key",
			},
			timeout: 15_000,
		},
	);
}

function parseStdoutMessages(stdout) {
	const stdoutLines = stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const messages = [];
	for (const [index, line] of stdoutLines.entries()) {
		try {
			messages.push(JSON.parse(line));
		} catch (error) {
			fail(
				`Headless stdout line ${index + 1} was not protocol JSON.`,
				`line: ${line}\nerror: ${error instanceof Error ? error.message : error}`,
			);
			break;
		}
	}
	return messages;
}

try {
	const hello = {
		type: "hello",
		protocol_version: "2026-04-02",
		client_info: { name: "maestro-headless-smoke", version: "0.1.0" },
		role: "controller",
	};
	const result = runHeadless(
		["--model", "gpt-4o-mini"],
		`${JSON.stringify(hello)}\n`,
	);

	if (result.error) {
		fail("Headless smoke failed to launch Maestro.", result.error.stack);
	} else if (result.status !== 0) {
		fail(
			`Headless smoke exited with code ${result.status}.`,
			[
				result.stdout ? `stdout:\n${result.stdout}` : undefined,
				result.stderr ? `stderr:\n${result.stderr}` : undefined,
			]
				.filter(Boolean)
				.join("\n\n"),
		);
	} else {
		const messages = parseStdoutMessages(result.stdout);

		if (process.exitCode !== 1) {
			const types = new Set(messages.map((message) => message.type));
			if (!types.has("ready")) {
				fail("Headless smoke did not receive a ready message.");
			}
			if (!types.has("hello_ok")) {
				fail("Headless smoke did not receive a hello_ok message.");
			}
		}
	}

	const startupFailure = runHeadless([
		"--model",
		"definitely-not-a-real-model",
	]);
	if (startupFailure.error) {
		fail(
			"Headless startup-failure smoke failed to launch Maestro.",
			startupFailure.error.stack,
		);
	} else if (startupFailure.status === 0) {
		fail("Headless startup-failure smoke unexpectedly exited successfully.");
	} else {
		const messages = parseStdoutMessages(startupFailure.stdout);
		const fatalError = messages.find((message) => message.type === "error");
		if (!fatalError?.fatal) {
			fail(
				"Headless startup-failure smoke did not emit a fatal protocol error.",
				startupFailure.stdout,
			);
		}
		if (!startupFailure.stderr.includes("\n    at ")) {
			fail(
				"Headless startup-failure smoke did not preserve stderr stack diagnostics.",
				startupFailure.stderr,
			);
		}
	}
} finally {
	rmSync(home, { recursive: true, force: true });
}

if (process.exitCode === 1) {
	process.exit(1);
}

console.log("Headless smoke completed successfully.");
