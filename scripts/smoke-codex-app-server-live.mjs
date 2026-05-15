#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = "dist/cli.js";
const baseEnv = {
	...process.env,
	NO_COLOR: "1",
	MAESTRO_TELEMETRY_DISABLED: "1",
};

function run(name, args, options = {}) {
	console.log(`[codex-live-smoke] ${name}`);
	const result = spawnSync("node", [cli, ...args], {
		encoding: "utf8",
		env: baseEnv,
		timeout: options.timeoutMs ?? 180_000,
	});
	if (result.stdout) {
		process.stdout.write(result.stdout);
	}
	if (result.stderr) {
		process.stderr.write(result.stderr);
	}
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(`${name} failed with exit code ${result.status}`);
	}
	return result.stdout ?? "";
}

run("doctor", ["codex", "doctor"], { timeoutMs: 60_000 });

const tempDir = mkdtempSync(join(tmpdir(), "maestro-codex-live-"));
try {
	const token = `codex-live-smoke-${Date.now().toString(36)}`;
	const tokenPath = join(tempDir, "token.txt");
	writeFileSync(tokenPath, `${token}\n`, "utf8");

	const output = run(
		"real inference with dynamic read tool",
		[
			"--provider",
			"openai-codex",
			"--model",
			"gpt-5.5",
			"--mode",
			"text",
			"--no-session",
			"--approval-mode",
			"fail",
			"--sandbox",
			"read-only",
			`Use the read tool to read ${tokenPath} and reply exactly with the token in that file.`,
		],
		{ timeoutMs: 240_000 },
	);
	if (!output.includes(token)) {
		throw new Error(
			`real inference did not return the expected token ${token}`,
		);
	}
	console.log("[codex-live-smoke] real inference returned expected token");
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}
